import * as http from 'http';
import * as https from 'https';

/**
 * The ONLY network path Total Agentic Mode's Jira/Confluence connections use.
 * Deliberately small and strict:
 *
 *  - read-only: `GET` and nothing else;
 *  - https only, certificate validation always on (there is no option to turn
 *    it off — a bank's corporate CA is handled by VS Code, see below);
 *  - the response is read as a STREAM and abandoned the moment it exceeds the
 *    caller's byte limit (`Content-Length` is advisory only);
 *  - redirects are followed manually, at most three, and only where the caller's
 *    policy allows the destination; the `Authorization` header is only ever sent
 *    to the original origin and is never forwarded anywhere else;
 *  - finite timeouts, bounded retries with backoff on transient failures,
 *    honouring `Retry-After` up to a small ceiling, and cancellation through an
 *    `AbortSignal`.
 *
 * Proxy / CA: VS Code's extension host patches Node's `https` module to follow
 * the user's proxy settings and system certificates, so using `https.request`
 * here (rather than a private HTTP stack) inherits the corporate proxy and CA
 * behaviour with no code of our own. That is documented, not proven by these
 * tests — only a live run on the bank network proves it.
 *
 * Errors never contain request headers, credentials, query strings or response
 * bodies.
 */

export type TransportErrorCode = 'aborted' | 'timeout' | 'too_large' | 'network' | 'redirect_blocked' | 'unsupported_scheme' | 'too_many_redirects' | 'rate_limited';

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    readonly details: { origin?: string; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface TransportRequest {
  url: string;
  /** Sent only to the ORIGINAL url's origin. */
  authorization?: string;
  accept?: string;
  maxBytes: number;
  signal?: AbortSignal;
  /** Called for every redirect hop; return false to stop (the request then fails, sending nothing further). */
  isRedirectAllowed: (from: URL, to: URL) => boolean;
}

export interface TransportResponse {
  status: number;
  /** Lower-cased header names; multi-valued headers joined with ", ". */
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
}

export interface KnowledgeTransport {
  get(request: TransportRequest): Promise<TransportResponse>;
}

export type RequestFn = (options: https.RequestOptions, callback: (res: http.IncomingMessage) => void) => http.ClientRequest;

export interface HttpsTransportOptions {
  timeoutMs: number;
  /** Retries AFTER the first attempt for 429/502/503/504 and connection errors. Default 2. */
  maxRetries?: number;
  request?: RequestFn;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const MAX_REDIRECTS = 3;
const MAX_RETRY_AFTER_MS = 10_000;
const BASE_BACKOFF_MS = 400;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TransportError('aborted', 'The request was cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new TransportError('aborted', 'The request was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function createHttpsTransport(options: HttpsTransportOptions): KnowledgeTransport {
  const requestFn: RequestFn = options.request ?? ((opts, cb) => https.request(opts, cb));
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 2;

  /** One HTTP exchange, no redirect handling. */
  function exchange(url: URL, headers: Record<string, string>, maxBytes: number, signal: AbortSignal | undefined): Promise<Omit<TransportResponse, 'finalUrl'>> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new TransportError('aborted', 'The request was cancelled.'));
        return;
      }
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let req!: http.ClientRequest;
      const onAbort = (): void => {
        req.destroy();
        finish(() => reject(new TransportError('aborted', 'The request was cancelled.')));
      };
      const finish = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          clearTimeout(deadline);
          signal?.removeEventListener('abort', onAbort);
          fn();
        }
      };
      req = requestFn(
        { method: 'GET', protocol: 'https:', hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`, headers },
        (res) => {
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            req.destroy();
            finish(() => reject(new TransportError('too_large', `The response is larger than the ${maxBytes.toLocaleString()}-byte limit.`)));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              // Streaming enforcement: stop reading — never buffer the rest.
              req.destroy();
              finish(() => reject(new TransportError('too_large', `The response is larger than the ${maxBytes.toLocaleString()}-byte limit.`)));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(() =>
              resolve({
                status: res.statusCode ?? 0,
                headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : (v ?? '')])),
                body: Buffer.concat(chunks)
              })
            )
          );
          res.on('error', () => finish(() => reject(new TransportError('network', 'The connection was interrupted while reading the response.'))));
        }
      );
      deadline = setTimeout(() => {
        req.destroy();
        finish(() => reject(new TransportError('timeout', `The server did not respond within ${Math.round(options.timeoutMs / 1000)} seconds.`)));
      }, options.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(new TransportError('network', `Could not connect (${err.code ?? 'network error'}).`))));
      req.end();
    });
  }

  async function followRedirects(request: TransportRequest): Promise<TransportResponse> {
    const origin = new URL(request.url);
    if (origin.protocol !== 'https:') {
      throw new TransportError('unsupported_scheme', 'Only https addresses can be contacted.');
    }
    let current = origin;
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = {
        Accept: request.accept ?? 'application/json',
        'Accept-Encoding': 'identity',
        'User-Agent': 'SoftPlay-Agentic'
      };
      // The credential travels only to the origin it was collected for.
      if (request.authorization && current.origin === origin.origin) {
        headers.Authorization = request.authorization;
      }
      const res = await exchange(current, headers, request.maxBytes, request.signal);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= MAX_REDIRECTS) {
          throw new TransportError('too_many_redirects', 'The server redirected too many times.');
        }
        let target: URL;
        try {
          target = new URL(res.headers.location, current);
        } catch {
          throw new TransportError('redirect_blocked', 'The server sent an invalid redirect address.');
        }
        if (target.protocol !== 'https:' || target.username || target.password || !request.isRedirectAllowed(current, target)) {
          throw new TransportError(
            'redirect_blocked',
            `The server redirected to ${target.origin}, which is not part of the approved connection. Credentials were not sent there and nothing was downloaded.`,
            { origin: target.origin }
          );
        }
        current = target;
        continue;
      }
      return { ...res, finalUrl: `${current.origin}${current.pathname}` };
    }
  }

  return {
    async get(request) {
      for (let attempt = 0; ; attempt++) {
        let response: TransportResponse | undefined;
        let failure: TransportError | undefined;
        try {
          response = await followRedirects(request);
        } catch (err) {
          if (!(err instanceof TransportError)) {
            throw err;
          }
          failure = err;
        }
        const retryable = failure ? failure.code === 'network' : RETRYABLE_STATUS.has(response!.status);
        if (!retryable) {
          if (failure) {
            throw failure;
          }
          return response!;
        }
        const retryAfterMs = response ? parseRetryAfterMs(response.headers['retry-after']) : undefined;
        if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
          throw new TransportError('rate_limited', `The server asked to wait ${Math.ceil(retryAfterMs / 1000)} seconds before another request. Try again later.`, { retryAfterMs });
        }
        if (attempt >= maxRetries) {
          if (failure) {
            throw failure;
          }
          if (response!.status === 429) {
            throw new TransportError('rate_limited', 'The server is rate-limiting requests. Try again in a moment.', { retryAfterMs });
          }
          return response!;
        }
        await sleep(retryAfterMs ?? BASE_BACKOFF_MS * 2 ** attempt, request.signal);
      }
    }
  };
}
