import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { TtlCache } from '../cache/ttlCache';
import { decideTokenBudget, PromptTooLargeError } from './tokenBudget';

export { PromptTooLargeError } from './tokenBudget';

export interface CopilotModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
}

/**
 * Wraps VS Code's Language Model API (`vscode.lm`) — stable since VS Code
 * 1.90, no proposed-API flags needed — to discover and call whatever chat
 * models the user's installed GitHub Copilot Chat extension actually
 * exposes. Deliberately never hardcodes a model list: what's available
 * depends on the user's Copilot subscription/installed extension version,
 * so the only correct approach is to ask VS Code at call time.
 */

/** How long a resolved Copilot model list stays cached — see
 * `resolveModels()`'s own doc comment. Short enough that a real change
 * (signing in/out, a plan change exposing a new model) is picked up well
 * within one interactive session; long enough to absorb the bursts of
 * repeated lookups a single user action actually causes (one
 * `sendPrompt()`/`countModelTokens()` call per RAG-corpus-batch unit, or
 * every keystroke re-running a live Token Monitoring estimate). */
const MODEL_LIST_TTL_MS = 10_000;
const modelListCache = new TtlCache<'copilot', Promise<vscode.LanguageModelChat[]>>(1);

/** Resolves Copilot's currently exposed chat models — the single call both
 * `listCopilotModels()` and `findModel()` build on. `vscode.lm.selectChatModels()`
 * is a real IPC round-trip to the Copilot Chat extension, not a free local
 * lookup, and until this cache existed it was NEVER memoized: every single
 * `sendPrompt()`/`countModelTokens()` call in this file re-resolved it from
 * scratch, unlike `countModelTokens()`'s own result, which already was (see
 * `tokenCountCache` below). A "Generate RAG Corpus format" batch (one
 * `sendPrompt()` per capability — easily dozens for one file) or a live
 * "Token Monitoring" estimate (re-run on every keystroke) previously
 * repeated that exact same round-trip, for the exact same answer, many
 * times in quick succession.
 *
 * Caches the PROMISE itself (not just its resolved value) so several
 * callers racing during a cache miss share ONE in-flight request instead
 * of each firing their own — and a REJECTED lookup is evicted immediately
 * (never replayed from cache) so a transient failure (Copilot Chat still
 * activating) doesn't lock in the same doomed promise for the rest of the
 * TTL window; the very next caller gets a fresh attempt. */
function resolveModels(): Promise<vscode.LanguageModelChat[]> {
  const cached = modelListCache.get('copilot');
  if (cached) {
    return cached;
  }
  // Wrapped in a real Promise — `selectChatModels()` returns VS Code's own
  // `Thenable`, which lacks `.catch()`/`.finally()`, both needed below.
  const pending = Promise.resolve(vscode.lm.selectChatModels({ vendor: 'copilot' }));
  modelListCache.set('copilot', pending, MODEL_LIST_TTL_MS);
  pending.catch(() => modelListCache.delete('copilot'));
  return pending;
}

/** Drops the cached model list — not currently wired to a command, exposed
 * for tests (same "not wired to a command, exposed for tests/a future
 * affordance" posture as `clearTokenCountCache()` below). */
export function clearModelListCache(): void {
  modelListCache.clear();
}

/** Lists Copilot's available chat models right now. Empty if GitHub Copilot
 * Chat isn't installed, the user isn't signed in, or no models are exposed —
 * callers should treat an empty list as "not available" and say so in the UI,
 * not throw. */
export async function listCopilotModels(): Promise<CopilotModelInfo[]> {
  try {
    const models = await resolveModels();
    return models.map((m) => ({ id: m.id, name: m.name, vendor: m.vendor, family: m.family }));
  } catch {
    return [];
  }
}

/** Exported for agent/verifyFixOrchestrator.ts, which needs the same
 * "resolve this id, or fall back to whatever's first" resolution — the
 * exact same model handle every other Copilot call in this extension uses,
 * never a second/different resolution path. */
export async function findModel(modelId: string): Promise<vscode.LanguageModelChat | undefined> {
  const models = await resolveModels();
  return models.find((m) => m.id === modelId) ?? models[0];
}

export class CopilotUnavailableError extends Error {
  /** `message` overrides the generic text when the caller knows the SPECIFIC reason (see `copilotSetupProblem()`),
   * so the user is told what to actually do instead of always being asked whether Copilot is installed. */
  constructor(message = 'No GitHub Copilot chat model is available. Is GitHub Copilot Chat installed and are you signed in?') {
    super(message);
    this.name = 'CopilotUnavailableError';
  }
}

/** Why a Copilot request cannot even start, from SoftPlay's OWN settings — or `undefined` when the settings are fine.
 * "Link with GitHub Copilot LLM" is off by default, and the old single message ("is Copilot installed and are you
 * signed in?") sent people who were signed in looking in the wrong place. */
export function copilotSetupProblem(settings: { copilotEnabled: boolean; copilotModelId: string }): string | undefined {
  if (!settings.copilotEnabled) {
    return 'GitHub Copilot is not linked yet: "Link with GitHub Copilot LLM" is turned off in SoftPlay. Click the ⚙ Settings button, turn it on, choose a model under "Copilot model", then try again.';
  }
  if (!settings.copilotModelId) {
    return 'No Copilot model is selected in SoftPlay. Click the ⚙ Settings button, pick one under "Copilot model", then try again.';
  }
  return undefined;
}

/** Text for the case where the settings are right but VS Code itself exposes no Copilot chat model. */
export const COPILOT_NO_MODELS_MESSAGE =
  'VS Code reports no GitHub Copilot chat models. Check that the GitHub Copilot Chat extension is installed AND enabled, that you are signed in ' +
  '(Accounts menu, bottom-left), that its status is not "not signed in / no access", and that your organisation\'s Copilot policy allows chat models. ' +
  'Reloading the window after signing in often fixes it.';

/**
 * Counts each message's own token count via the model's REAL tokenizer
 * (`LanguageModelChat.countTokens` — never a character-count heuristic) and
 * throws `PromptTooLargeError` (tokenBudget.ts) BEFORE `sendRequest` is
 * ever called once the total exceeds the model's safety-margined budget —
 * see `decideTokenBudget()`'s own doc comment for the exact decision logic
 * (including how an unmeasurable message is handled) and
 * `PROMPT_TOKEN_SAFETY_MARGIN` for why the margin exists at all. Counting
 * per-message avoids needing to hand-flatten a
 * `vscode.LanguageModelChatMessage`'s own content parts (tool calls
 * included) back into a single string just to count them.
 *
 * Shared by `sendPrompt()` below (a single user-turn prompt) and
 * agent/vscodeCopilotToolCallingModel.ts's `_generate()` (a real
 * multi-message LangChain conversation) — the ONE place this admission
 * check needs to live for every path this extension has into Copilot, both
 * the direct client and the LangChain adapter.
 */
export async function assertMessagesFitModel(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  token?: vscode.CancellationToken
): Promise<void> {
  const counts: (number | undefined)[] = [];
  for (const message of messages) {
    try {
      counts.push(await model.countTokens(message, token));
    } catch {
      counts.push(undefined);
    }
  }
  const decision = decideTokenBudget(counts, model.maxInputTokens);
  if (decision.outcome === 'exceeds') {
    throw new PromptTooLargeError(decision.totalTokens!, decision.maxInputTokens, decision.budget);
  }
  // 'fits' sends normally; 'unmeasured' also sends normally — see
  // decideTokenBudget()'s own doc comment on why an unmeasured request is
  // let through rather than blocked.
}

/**
 * Sends `prompt` against an ALREADY-RESOLVED `model` handle and streams the
 * response text via `onChunk` as it arrives. Split out from `sendPrompt()`
 * below (F12) so a caller that must resolve a model earlier anyway — to
 * measure a mandatory-token count and pack RAG content against that SAME
 * model's own `maxInputTokens`/tokenizer, e.g.
 * objectSpyPanel.ts's `runLlmRefinement()` — can reuse that EXACT handle
 * for the actual send too, rather than `sendPrompt()`'s own internal
 * `findModel()` potentially resolving a DIFFERENT one (Copilot's model
 * list could, in principle, change between the two calls) and enforcing
 * the real admission check against different numbers than packing itself
 * planned for.
 */
export async function sendPromptWithModel(
  model: vscode.LanguageModelChat,
  prompt: string,
  onChunk: (chunk: string) => void,
  token: vscode.CancellationToken
): Promise<void> {
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  await assertMessagesFitModel(model, messages, token);
  const response = await model.sendRequest(messages, {}, token);
  for await (const fragment of response.text) {
    onChunk(fragment);
  }
}

/**
 * Sends `prompt` to the selected model and streams the response text via
 * `onChunk` as it arrives. VS Code shows a one-time consent dialog the
 * first time an extension calls this API in a session — that's the API's
 * own gate; callers here (the chat composer's manual send, and the
 * automatic post-recording refinement pipeline — see objectSpyPanel.ts's
 * runLlmRefinement()) both only ever fire while the user has explicitly
 * turned on "Link with GitHub Copilot LLM" (Control Panel) and picked a model in Settings.
 *
 * Resolves the model exactly ONCE and reuses that same handle for both the
 * token-budget preflight (`assertMessagesFitModel`) and the actual request
 * — never a second, potentially different, resolution mid-request. A
 * caller that ALREADY has a resolved model handle from earlier in the same
 * logical request (e.g. for RAG packing) should call `sendPromptWithModel()`
 * directly instead, to guarantee the send uses that EXACT same handle.
 */
export async function sendPrompt(
  modelId: string,
  prompt: string,
  onChunk: (chunk: string) => void,
  token: vscode.CancellationToken
): Promise<void> {
  const model = await findModel(modelId);
  if (!model) {
    throw new CopilotUnavailableError();
  }
  await sendPromptWithModel(model, prompt, onChunk, token);
}

/**
 * Best-effort extraction of the first fenced code block from a chat
 * response — models often add commentary despite being asked not to.
 * Falls back to the full trimmed text when no fence is found, so a plain
 * (non-fenced) response still shows up rather than disappearing.
 */
export function extractCodeBlock(responseText: string): string {
  const match = responseText.match(/```[^\n]*\n([\s\S]*?)```/);
  return match ? match[1].trimEnd() : responseText.trim();
}

export interface ModelTokenCount {
  /** Real token count for `text`, from the model's OWN tokenizer via VS
   * Code's Language Model API (`LanguageModelChat.countTokens`) — never a
   * character-count heuristic, so this is exactly what the model itself
   * would bill/consider for that text. */
  count: number;
  /** `LanguageModelChat.maxInputTokens` — the real context-window ceiling
   * for this specific model, so a percentage-used figure means something
   * (and updates correctly the moment the user picks a different model in
   * Settings, since each model reports its own). */
  maxInputTokens: number;
}

/**
 * Local in-memory cache for `countModelTokens()` — keyed by (model, exact
 * text), NOT time-derived, since a given model's tokenizer gives the exact
 * same count for the exact same text every time (this is a deterministic
 * fact, not something that goes stale like an environment probe). The 200
 * cap + FIFO eviction bounds memory for a long editing session that touches
 * many distinct drafts; the 10-minute TTL is just a safety net for the
 * (currently theoretical) case of Copilot swapping a model's tokenizer
 * under the same id mid-session, not a "this might change soon" signal.
 *
 * Keyed on a SHA-1 of the text rather than the text itself — prompts can run
 * to many KB, and hashing keeps the Map's key set small regardless of how
 * large the drafts being measured are.
 */
const TOKEN_COUNT_TTL_MS = 10 * 60_000;
const tokenCountCache = new TtlCache<string, ModelTokenCount>(200);

function tokenCountCacheKey(modelId: string, text: string): string {
  return `${modelId}:${crypto.createHash('sha1').update(text).digest('hex')}`;
}

/** Drops every cached token count — not currently wired to a command,
 * exposed for an explicit "recheck"/testing hook. */
export function clearTokenCountCache(): void {
  tokenCountCache.clear();
}

/** Powers the "Token Monitoring" segment — counts `text` (a prompt about
 * to be sent, or a response just received) against whichever model is
 * currently selected. Returns `undefined` rather than throwing when the
 * model can't be resolved (not installed/signed in/no longer offered) or
 * `countTokens` itself fails — a monitoring feature must never surface as
 * a hard error interrupting the rest of the UI. */
export async function countModelTokens(modelId: string, text: string, token?: vscode.CancellationToken): Promise<ModelTokenCount | undefined> {
  const cacheKey = tokenCountCacheKey(modelId, text);
  const cached = tokenCountCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  try {
    const model = await findModel(modelId);
    if (!model) {
      return undefined;
    }
    const count = await model.countTokens(text, token);
    const result: ModelTokenCount = { count, maxInputTokens: model.maxInputTokens };
    tokenCountCache.set(cacheKey, result, TOKEN_COUNT_TTL_MS);
    return result;
  } catch {
    return undefined;
  }
}
