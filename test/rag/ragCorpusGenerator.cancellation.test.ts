import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';

/**
 * F14: an AUTOMATED orchestration regression test for `generateRagCorpus()`
 * — the one vscode-dependent function in the RAG feature this codebase has
 * always treated as "reviewed, not directly tested" (see
 * ragCorpusGenerator.ts's own doc comment), because it needs a real
 * `vscode` module and a real Copilot model connection, neither of which
 * exist outside a running Extension Host.
 *
 * This closes that gap using the SAME technique an external review's own
 * probe script demonstrated is viable: intercepting Node's own
 * `Module._load` so `require('vscode')` — and ragCorpusGenerator.js's own
 * two vscode-adjacent relative imports, `../llm/copilotClient` and
 * `../cache/fileCache` — resolve to small in-memory fakes instead of
 * throwing "Cannot find module 'vscode'". That lets the REAL, COMPILED
 * orchestration logic (cancellation re-checks, draft quarantine, target
 * resolution, ...) run end-to-end against fake infrastructure and be
 * asserted against directly, instead of relying entirely on a human
 * manually clicking Cancel in a running Extension Host.
 *
 * Scope: this specifically targets F14's cancellation re-checks (the loop-
 * top check, and the post-`sendPrompt()` check added by that fix) — not a
 * general-purpose vscode mock for the whole RAG feature. The fake vscode
 * surface below implements ONLY what `generateRagCorpus()`/
 * `saveRejectedDraft()`/`buildExistingTargetsByIdentity()` actually call;
 * see each fake's own inline comment for why.
 *
 * The `Module._load` hook is installed ONCE, synchronously, at file-load
 * time — for exactly the one `require()` call chain that pulls in
 * `vscode`/`../llm/copilotClient`/`../cache/fileCache` — and restored
 * immediately afterward (in a `finally`), before any `test()` body runs.
 * Every subsequent call in this file reuses that SAME already-loaded
 * `generateRagCorpus`, whose closed-over `vscode`/`sendPrompt` are the
 * fakes bound at that one require — later tests just mutate the shared
 * `state` object's fields (`writes`, `prompts`, `progress`, `responder`)
 * before each call, the same pattern the reviewed probe script used.
 * Node's test runner isolates each test FILE into its own process, so this
 * hook can never leak into any other test file regardless.
 */

interface FakeUri {
  fsPath: string;
  path: string;
  scheme: 'file';
  toString(): string;
}

function fakeUri(p: string): FakeUri {
  return { fsPath: p, path: p, scheme: 'file', toString: () => p };
}

interface FakeState {
  writes: { path: string; text: string }[];
  prompts: string[];
  progress: { fileName: string; status: string; message?: string }[];
  /** What the fake model "responds" with for the NEXT `sendPrompt()` call
   * — receives the real prompt text and the SAME cancellation token
   * `generateRagCorpus()` passed in, so a test can flip
   * `token.isCancellationRequested = true` mid-flight (simulating
   * cancellation arriving WHILE the model call was in progress) exactly
   * like a real cancel-click racing a real in-flight request would. */
  responder: (prompt: string, token: { isCancellationRequested: boolean }) => Promise<string>;
}

const state: FakeState = { writes: [], prompts: [], progress: [], responder: async () => '' };

function resetState(responder: FakeState['responder']): void {
  state.writes = [];
  state.prompts = [];
  state.progress = [];
  state.responder = responder;
}

/** Only what `generateRagCorpus()` and its own helpers
 * (`saveRejectedDraft()`, `buildExistingTargetsByIdentity()`) actually
 * call — see `grep -n "vscode\." src/rag/ragCorpusGenerator.ts` for the
 * exhaustive list this was built against. `stat()` always throws (a
 * fresh, empty target/RAG folder — the realistic "nothing written yet"
 * starting point for every test here); `findFiles()` always returns no
 * existing corpus files, so `buildExistingTargetsByIdentity()`'s own
 * per-file `readFile()` path is never actually exercised (its surrounding
 * try/catch would swallow a missing implementation anyway, but a working
 * one is included for fidelity). */
const fakeVsCode = {
  /** The real `vscode.CancellationError` class `sendPrompt()`'s underlying
   * `model.sendRequest()` rejects with when a cancellation token fires
   * WHILE a real Copilot request is actually in flight ("End Process")
   * — see the "End Process" cancellation test below. */
  CancellationError: class CancellationError extends Error {},
  Uri: {
    file: fakeUri,
    joinPath: (base: FakeUri, ...parts: string[]) => fakeUri(path.posix.join(base.path, ...parts))
  },
  RelativePattern: class {
    constructor(
      public base: unknown,
      public pattern: string
    ) {}
  },
  workspace: {
    fs: {
      createDirectory: async () => {},
      stat: async () => {
        throw new Error('ENOENT (fake): not found');
      },
      readFile: async () => {
        throw new Error('ENOENT (fake): not found');
      },
      writeFile: async (u: FakeUri, bytes: Uint8Array) => {
        state.writes.push({ path: u.path, text: Buffer.from(bytes).toString('utf8') });
      }
    },
    findFiles: async () => [] as FakeUri[],
    asRelativePath: (u: FakeUri | string) => (typeof u === 'string' ? u : u.path)
  }
};

/** Records every prompt sent and calls `state.responder` for the reply —
 * the SAME shape as `llm/copilotClient.ts`'s real `sendPrompt()`, minus an
 * actual network/model call. */
const fakeCopilotClient = {
  CopilotUnavailableError: class extends Error {},
  countModelTokens: async () => ({ count: 200, maxInputTokens: 10_000 }),
  sendPrompt: async (_modelId: string, prompt: string, onChunk: (chunk: string) => void, token: { isCancellationRequested: boolean }) => {
    state.prompts.push(prompt);
    onChunk(await state.responder(prompt, token));
  }
};

/** Reads the REAL bundled prompt file — `readGenerateRecipeInstructions()`
 * needs real, non-empty instructions text for the rest of
 * `generateRagCorpus()` to behave realistically; faking this out with
 * empty/placeholder text would risk a subtly different code path than
 * production actually takes. */
const fakeFileCache = {
  readFileCachedSync: () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'prompts', 'generate-rag-recipe.md'), 'utf8')
};

type GenerateRagCorpusFn = (options: {
  modelId: string;
  files: { fileName: string; content: string; relativePath?: string }[];
  workspaceRoot: FakeUri;
  cancellationToken: { isCancellationRequested: boolean };
  onProgress: (p: { fileName: string; status: string; message?: string }) => void;
  confirmOverwrite: (existing: string[]) => Promise<boolean>;
}) => Promise<{ succeeded: number; skipped: number; failed: number }>;

/** Installs the `Module._load` interception ONLY for the duration of the
 * ONE `require()` call that loads ragCorpusGenerator.js, then restores the
 * real loader immediately (even if the require itself throws) — see this
 * file's own top-level doc comment for why this is safe and tightly
 * scoped. Returns the real, now-loaded `generateRagCorpus`, permanently
 * bound to the fakes above for the rest of this file's test run. */
function loadGenerateRagCorpusWithFakes(): GenerateRagCorpusFn {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (id: string, parent: { filename?: string } | undefined, isMain: boolean) {
    if (id === 'vscode') {
      return fakeVsCode;
    }
    if (parent?.filename?.endsWith(path.join('rag', 'ragCorpusGenerator.js'))) {
      if (id === '../llm/copilotClient') {
        return fakeCopilotClient;
      }
      if (id === '../cache/fileCache') {
        return fakeFileCache;
      }
    }
    // eslint-disable-next-line prefer-rest-params
    return originalLoad.apply(this, arguments);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../src/rag/ragCorpusGenerator');
    return mod.generateRagCorpus as GenerateRagCorpusFn;
  } finally {
    Module._load = originalLoad;
  }
}

const generateRagCorpus = loadGenerateRagCorpusWithFakes();

const HELPER_JAVA = 'package acme;\npublic class Helper {\n  public int find(int id) {\n    return id;\n  }\n}\n';

function validRecipeResponse(): string {
  return (
    '---\n' +
    'id: helper-find\n' +
    'title: Find a Helper row by id\n' +
    'tags: [helper]\n' +
    'automationMode: [ui, api]\n' +
    'language: [java]\n' +
    '---\n\n' +
    'API: public int find(int id)\n' +
    '```java\n' +
    'var result = Helper.find(1);\n' +
    '```\n'
  );
}

/** A second, distinct valid response for the OTHER capability used below
 * (multi-unit accumulation test) — validateSourceGrounding() rejects a
 * response that doesn't actually describe the capability it was given, so
 * reusing `validRecipeResponse()` (which only ever describes `Helper.find`)
 * for a second, different capability would get REJECTED rather than
 * succeed, undermining a test that needs TWO real successes to prove
 * cumulative accumulation. */
function validRecipeResponseForOther(): string {
  return (
    '---\n' +
    'id: other-other\n' +
    'title: Find an Other row by id\n' +
    'tags: [other]\n' +
    'automationMode: [ui, api]\n' +
    'language: [java]\n' +
    '---\n\n' +
    'API: public int other(int id)\n' +
    '```java\n' +
    'var result = Other.other(1);\n' +
    '```\n'
  );
}

test('a NORMAL (uncancelled) generation actually writes a recipe — the control case the cancellation tests below are meaningful against', async () => {
  resetState(async () => validRecipeResponse());
  const token = { isCancellationRequested: false };
  const counts = await generateRagCorpus({
    modelId: 'fake-model',
    files: [{ fileName: 'Helper.java', content: HELPER_JAVA }],
    workspaceRoot: fakeUri('/fake-workspace'),
    cancellationToken: token,
    onProgress: (p) => state.progress.push(p),
    confirmOverwrite: async () => true
  });
  assert.equal(counts.succeeded, 1);
  assert.equal(state.writes.length, 1, 'the real recipe must actually be written when nothing was cancelled');
  assert.ok(state.prompts.length > 0, 'the model must actually have been called');
});

test('F14: cancellation requested BEFORE generation starts skips without ever calling the model', async () => {
  resetState(async () => validRecipeResponse());
  const token = { isCancellationRequested: true }; // already cancelled when generateRagCorpus() is invoked
  const counts = await generateRagCorpus({
    modelId: 'fake-model',
    files: [{ fileName: 'Helper.java', content: HELPER_JAVA }],
    workspaceRoot: fakeUri('/fake-workspace'),
    cancellationToken: token,
    onProgress: (p) => state.progress.push(p),
    confirmOverwrite: async () => true
  });
  assert.equal(counts.skipped, 1);
  assert.equal(counts.succeeded, 0);
  assert.equal(state.prompts.length, 0, 'the model must never be called once cancellation is already requested');
  assert.equal(state.writes.length, 0);
  assert.ok(state.progress.some((p) => p.status === 'skipped' && p.message === 'Cancelled.'));
});

test('F14: cancellation requested WHILE the model call is in flight (mid-response) still writes NOTHING (the reproduced pre-fix bug)', async () => {
  resetState(async (_prompt, token) => {
    // Simulate cancellation arriving WHILE this request was in flight —
    // exactly the race F14's own re-check (added right after
    // sendPrompt() returns) exists to catch: the model still finishes
    // and returns a perfectly valid recipe, but the user already asked
    // to stop.
    token.isCancellationRequested = true;
    return validRecipeResponse();
  });
  const token = { isCancellationRequested: false };
  const counts = await generateRagCorpus({
    modelId: 'fake-model',
    files: [{ fileName: 'Helper.java', content: HELPER_JAVA }],
    workspaceRoot: fakeUri('/fake-workspace'),
    cancellationToken: token,
    onProgress: (p) => state.progress.push(p),
    confirmOverwrite: async () => true
  });
  assert.equal(counts.skipped, 1);
  assert.equal(counts.succeeded, 0, 'a response that arrives after cancellation must never be saved as a success');
  assert.equal(counts.failed, 0, 'cancellation is never reported as a failure — nothing actually went wrong');
  assert.equal(state.writes.length, 0, 'nothing must be written once cancellation was observed after the model responded');
  assert.equal(state.prompts.length, 1, 'the in-flight model call itself was already sent before cancellation arrived — this is a genuine race, not a call that should have been skipped entirely');
  const skippedEntry = state.progress.find((p) => p.status === 'skipped');
  assert.ok(skippedEntry, 'the mid-flight cancellation must be reported as "skipped"');
  assert.match(skippedEntry!.message ?? '', /Cancelled after the model responded/);
});

test('F14: with MULTIPLE files queued, cancellation arriving after the first one\'s model response stops the batch — later files are never even started', async () => {
  let callCount = 0;
  resetState(async (_prompt, token) => {
    callCount++;
    if (callCount === 1) {
      token.isCancellationRequested = true; // cancel arrives right after the FIRST file's response
    }
    return validRecipeResponse();
  });
  const token = { isCancellationRequested: false };
  const counts = await generateRagCorpus({
    modelId: 'fake-model',
    files: [
      { fileName: 'Helper.java', content: HELPER_JAVA },
      { fileName: 'Other.java', content: 'package acme;\npublic class Other {\n  public int other(int id) {\n    return id;\n  }\n}\n' }
    ],
    workspaceRoot: fakeUri('/fake-workspace'),
    cancellationToken: token,
    onProgress: (p) => state.progress.push(p),
    confirmOverwrite: async () => true
  });
  assert.equal(state.writes.length, 0, 'the first file\'s own response arrived post-cancellation and must not be written');
  assert.equal(counts.succeeded, 0);
  // The token stays cancelled for the REST of the loop, so a second file
  // is caught by the loop-top check before ever reaching the model.
  assert.equal(callCount, 1, 'the model must never be called again once cancellation has been observed');
  assert.equal(counts.skipped, 2, 'both files end up skipped — one from the mid-flight race, one from the loop-top check');
});

test('"End Process": a real in-flight-abort (vscode.CancellationError thrown by sendPrompt) is reported as skipped/cancelled, never as a failure', async () => {
  resetState(async (_prompt, token) => {
    // Unlike the "mid-response" race above (the model finishes and
    // RESOLVES with a valid recipe after cancellation was noticed), this
    // simulates VS Code's Language Model API actually ABORTING the
    // request the instant the token fires — model.sendRequest() rejects
    // instead of resolving. This is the real, documented shape of
    // "End Process" hitting a request that's genuinely in flight.
    token.isCancellationRequested = true;
    throw new fakeVsCode.CancellationError();
  });
  const token = { isCancellationRequested: false };
  const counts = await generateRagCorpus({
    modelId: 'fake-model',
    files: [{ fileName: 'Helper.java', content: HELPER_JAVA }],
    workspaceRoot: fakeUri('/fake-workspace'),
    cancellationToken: token,
    onProgress: (p) => state.progress.push(p),
    confirmOverwrite: async () => true
  });
  assert.equal(counts.skipped, 1, 'an aborted in-flight request must count as skipped/cancelled');
  assert.equal(counts.succeeded, 0);
  assert.equal(counts.failed, 0, '"End Process" must never be reported as a failure — the user asked for this, nothing went wrong');
  assert.equal(state.writes.length, 0, 'nothing must be written once the in-flight request was aborted');
  const skippedEntry = state.progress.find((p) => p.status === 'skipped');
  assert.ok(skippedEntry, 'the aborted request must be reported as "skipped", never "error"');
  assert.match(skippedEntry!.message ?? '', /Cancelled/);
  assert.ok(!state.progress.some((p) => p.status === 'error'), 'no progress entry should ever be reported as an error for a user-requested cancellation');
});

test('a genuine failure (not a cancellation) that happens to occur AFTER cancellation was already requested is still reported as skipped — cancellation wins', async () => {
  // Defensive: once the user has clicked "End Process", ANY error surfacing
  // from that point on for an in-flight unit should read as "cancelled",
  // not as a spurious failure — checking cancellationToken.isCancellationRequested
  // directly (not just `instanceof CancellationError`) covers a provider
  // that rejects with some OTHER error shape once aborted.
  resetState(async (_prompt, token) => {
    token.isCancellationRequested = true;
    throw new Error('ECONNRESET (fake): the aborted connection surfaced as a generic network error, not CancellationError');
  });
  const token = { isCancellationRequested: false };
  const counts = await generateRagCorpus({
    modelId: 'fake-model',
    files: [{ fileName: 'Helper.java', content: HELPER_JAVA }],
    workspaceRoot: fakeUri('/fake-workspace'),
    cancellationToken: token,
    onProgress: (p) => state.progress.push(p),
    confirmOverwrite: async () => true
  });
  assert.equal(counts.skipped, 1);
  assert.equal(counts.failed, 0);
});

test('tokensSoFar: present (0/0) from the very first progress event, then accumulates real sent+received counts as units complete', async () => {
  resetState(async () => validRecipeResponse());
  const token = { isCancellationRequested: false };
  const progressEvents: { status: string; tokensSoFar?: { sent: number; received: number } }[] = [];
  const counts = await generateRagCorpus({
    modelId: 'fake-model',
    files: [{ fileName: 'Helper.java', content: HELPER_JAVA }],
    workspaceRoot: fakeUri('/fake-workspace'),
    cancellationToken: token,
    onProgress: (p) => progressEvents.push(p as typeof progressEvents[number]),
    confirmOverwrite: async () => true
  });
  assert.equal(counts.succeeded, 1);
  assert.ok(progressEvents.every((p) => p.tokensSoFar), 'every progress event must carry a tokensSoFar field');
  const startedEvent = progressEvents.find((p) => p.status === 'started');
  assert.deepEqual(startedEvent!.tokensSoFar, { sent: 0, received: 0 }, 'nothing sent/received yet the moment a unit merely starts');
  const successEvent = progressEvents.find((p) => p.status === 'success');
  // fakeCopilotClient.countModelTokens() always answers { count: 200 } —
  // one call for the prompt (sent) and one for the raw response (received)
  // per unit; the THIRD countModelTokens() call this same unit also makes
  // (sizing the SAVED recipe content, for the "over target" note) is a
  // separate, purely informational measurement and must NOT be folded into
  // either total — it's checking a file already written, not billing an
  // additional Copilot request.
  assert.deepEqual(successEvent!.tokensSoFar, { sent: 200, received: 200 });
});

test('tokensSoFar accumulates CUMULATIVELY across multiple units — the second unit\'s total includes the first\'s', async () => {
  resetState(async (prompt) => (prompt.includes('public int other') ? validRecipeResponseForOther() : validRecipeResponse()));
  const token = { isCancellationRequested: false };
  const progressEvents: { fileName: string; status: string; tokensSoFar?: { sent: number; received: number } }[] = [];
  const counts = await generateRagCorpus({
    modelId: 'fake-model',
    files: [
      { fileName: 'Helper.java', content: HELPER_JAVA },
      { fileName: 'Other.java', content: 'package acme;\npublic class Other {\n  public int other(int id) {\n    return id;\n  }\n}\n' }
    ],
    workspaceRoot: fakeUri('/fake-workspace'),
    cancellationToken: token,
    onProgress: (p) => progressEvents.push(p as typeof progressEvents[number]),
    confirmOverwrite: async () => true
  });
  assert.equal(counts.succeeded, 2);
  const successEvents = progressEvents.filter((p) => p.status === 'success');
  assert.equal(successEvents.length, 2);
  assert.deepEqual(successEvents[0].tokensSoFar, { sent: 200, received: 200 }, 'first unit');
  assert.deepEqual(successEvents[1].tokensSoFar, { sent: 400, received: 400 }, 'second unit adds on top of the first, never resets');
});

test('tokensSoFar: a unit skipped WITHOUT ever calling the model (already cancelled) contributes nothing — totals stay at zero', async () => {
  resetState(async () => validRecipeResponse());
  const token = { isCancellationRequested: true }; // already cancelled — the model is never called at all
  const progressEvents: { status: string; tokensSoFar?: { sent: number; received: number } }[] = [];
  await generateRagCorpus({
    modelId: 'fake-model',
    files: [{ fileName: 'Helper.java', content: HELPER_JAVA }],
    workspaceRoot: fakeUri('/fake-workspace'),
    cancellationToken: token,
    onProgress: (p) => progressEvents.push(p as typeof progressEvents[number]),
    confirmOverwrite: async () => true
  });
  assert.ok(progressEvents.length > 0);
  progressEvents.forEach((p) => assert.deepEqual(p.tokensSoFar, { sent: 0, received: 0 }));
});

test('tokensSoFar: a unit that reaches the model but is cancelled mid-flight (sendPrompt aborts) still counts the prompt as sent', async () => {
  resetState(async () => {
    throw new fakeVsCode.CancellationError();
  });
  const token = { isCancellationRequested: false };
  const progressEvents: { status: string; tokensSoFar?: { sent: number; received: number } }[] = [];
  const counts = await generateRagCorpus({
    modelId: 'fake-model',
    files: [{ fileName: 'Helper.java', content: HELPER_JAVA }],
    workspaceRoot: fakeUri('/fake-workspace'),
    cancellationToken: token,
    onProgress: (p) => progressEvents.push(p as typeof progressEvents[number]),
    confirmOverwrite: async () => true
  });
  assert.equal(counts.skipped, 1);
  const skippedEvent = progressEvents.find((p) => p.status === 'skipped');
  assert.deepEqual(skippedEvent!.tokensSoFar, { sent: 200, received: 0 }, 'the prompt genuinely reached Copilot before the abort — it counts; no response ever came back, so received stays 0');
});
