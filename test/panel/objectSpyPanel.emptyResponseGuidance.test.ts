import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

/**
 * A real-world report: "Start AI Code Generation" failed with Copilot's own
 * generic "Response contained no choices." error, while the extension's own
 * "Token Monitoring" panel showed the request at only ~9% of the selected
 * model's context window — nowhere near this extension's own
 * `PromptTooLargeError` preflight threshold (llm/copilotClient.ts), which
 * already refuses to even SEND a genuinely oversized prompt before this
 * failure mode can occur at all. The OLD `buildEmptyResponseGuidance()`
 * (objectSpyPanel.ts) unconditionally opened with "the combined prompt was
 * too large" regardless of how much headroom the request actually had —
 * actively misleading in exactly this case, since the real cause of a
 * comfortably-under-budget "no choices" response is something else entirely
 * (a transient backend hiccup, a Copilot Chat connectivity problem, or an
 * organization-level content-exclusion/policy filter — common on a
 * locked-down corporate Copilot deployment).
 *
 * Fix: `buildEmptyResponseGuidance()` now REACTIVELY measures the actual
 * failed prompt's own token count (`measureFailedPromptTokens()`, called
 * only once a request has already failed — zero cost on the success path)
 * and reframes its guidance evidence-based: when usage is comfortably under
 * the model's real limit, it says so explicitly and points at non-size
 * causes instead of the old, always-present "shrink the prompt" levers.
 *
 * Same `Module._load` fake-`vscode` + `Object.create(ObjectSpyPanel.prototype)`
 * technique as objectSpyPanel.recordingCorrespondence.test.ts — see that
 * file's own doc comment for the full rationale. `../llm/copilotClient`'s
 * `findModel` is stubbed with a MUTABLE `fakeModelConfig` (reassigned per
 * test) rather than a fixed literal, so each test can set its own
 * maxInputTokens/measured-token-count scenario before calling
 * `runLlmRefinement()`.
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

class FakeCancellationTokenSource {
  token: { isCancellationRequested: boolean } = { isCancellationRequested: false };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {
    // no-op — nothing this test needs to observe.
  }
}

const fakeVsCode = {
  CancellationTokenSource: FakeCancellationTokenSource,
  Uri: { file: fakeUri, joinPath: (base: FakeUri, ...parts: string[]) => fakeUri(path.posix.join(base.path, ...parts)) },
  window: { showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
  workspace: { asRelativePath: (p: FakeUri | string) => (typeof p === 'string' ? p : p.path) },
  ViewColumn: { Beside: 2 }
};

/** Mutated per test (before calling `runLlmRefinement()`) to control what
 * the fake `findModel()`/`countTokens()` below report — see this file's own
 * top-level doc comment. `resolvable: false` simulates `findModel()` unable
 * to resolve the configured model id at all (distinct from no model id
 * being configured, which is an earlier, unrelated guard in
 * `runLlmRefinement()` itself). */
const fakeModelConfig = { maxInputTokens: 100_000, tokenCountResult: 100, resolvable: true };

function loadObjectSpyPanelWithFakeVsCode(): { ObjectSpyPanel: new (...args: never[]) => object } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (id: string, parent: { filename?: string } | undefined, isMain: boolean) {
    if (id === 'vscode') {
      return fakeVsCode;
    }
    if (parent?.filename?.endsWith(path.join('panel', 'objectSpyPanel.js'))) {
      if (id === 'path' || id === 'fs') {
        return originalLoad.apply(this, arguments);
      }
      if (id === '../cache/fileCache') {
        return { readFileCachedSync: () => '', readWorkspaceFileCached: async () => undefined, clearFileCaches: () => undefined };
      }
      if (id === '../rag/ragIndexer') {
        return { clearRagIndexCache: () => undefined };
      }
      if (id === '../security/secretVault') {
        return { TOKEN_MARKER: 'ENC[v1:', getSecretEnv: async () => ({}) };
      }
      if (id === '../security/uiPasswordRedactor') {
        return { encryptPasswordLiteralsInCode: async (_ctx: unknown, code: string) => ({ code, count: 0 }) };
      }
      if (id === '../security/chatInstructionRedactor') {
        return { encryptCredentialsInFreeText: async (_ctx: unknown, text: string) => ({ text, count: 0 }) };
      }
      if (id === '../security/passwordEncryptionSection') {
        return { appendPasswordEncryptionSection: () => undefined };
      }
      if (id === '../llm/databaseTestingInstructions') {
        return { withDatabaseTestingInstructions: (instructions: unknown[]) => instructions, mentionsDatabaseTesting: () => false };
      }
      if (id === '../llm/copilotClient') {
        return {
          // `countTokens` ignores its `text` argument and always returns the
          // currently-configured `fakeModelConfig.tokenCountResult` — every
          // test here cares about the RATIO reported to the guidance
          // function, not about faithfully tokenizing any particular prompt.
          findModel: async () => (fakeModelConfig.resolvable ? { countTokens: async () => fakeModelConfig.tokenCountResult, maxInputTokens: fakeModelConfig.maxInputTokens } : undefined),
          extractCodeBlock: (s: string) => s.replace(/^```\w*\n|\n```$/g, ''),
          countModelTokens: async () => ({ count: 0, maxInputTokens: fakeModelConfig.maxInputTokens }),
          CopilotUnavailableError: class extends Error {},
          PromptTooLargeError: class extends Error {},
          sendPrompt: async () => '',
          sendPromptWithModel: async () => ''
        };
      }
      if (id === './ragTraceabilityBanner') {
        return { prependRagTraceabilityBanner: (code: string) => ({ code, observedMatches: [] }) };
      }
      if (id === './stepCoverageChecker') {
        return originalLoad.apply(this, arguments);
      }
      // Pure, vscode-free — real code (see llm/customInstructionsSection.ts).
      if (id === '../llm/customInstructionsSection') {
        return originalLoad.apply(this, arguments);
      }
      return {};
    }
    // eslint-disable-next-line prefer-rest-params
    return originalLoad.apply(this, arguments);
  };
  try {
    const objectSpyPanelModule = require('../../src/panel/objectSpyPanel');
    return { ObjectSpyPanel: objectSpyPanelModule.ObjectSpyPanel };
  } finally {
    Module._load = originalLoad;
  }
}

const { ObjectSpyPanel } = loadObjectSpyPanelWithFakeVsCode();

interface FakeController {
  context: object;
  settingsStore: { get: () => Record<string, unknown> };
  outputChannel: { appendLine: () => void };
  linkedScenario: undefined;
  recordingAssociatedScenarioKey: undefined;
  buildRagSection: (...args: unknown[]) => Promise<{ section: string; matches: unknown[] }>;
  postLlmStart: (name: string | undefined) => void;
  postLlmChunk: (chunk: string) => void;
  postLlmDone: (code: string) => void;
  postLlmError: (message: string) => void;
  errored?: string;
  recordReceivedTokens: () => Promise<void>;
  streamCopilotResponse: (prompt: string, ...rest: unknown[]) => Promise<string>;
  getEncryptSecret: () => (plaintext: string) => Promise<string>;
  runLlmRefinement: (instructions: unknown[], code: string, customInstructions: string) => Promise<void>;
}

function makeController(): FakeController {
  const c = Object.create((ObjectSpyPanel as { prototype: object }).prototype) as FakeController;
  c.context = {};
  c.settingsStore = {
    get: () => ({
      copilotEnabled: true,
      copilotModelId: 'fake-model',
      automationMode: 'ui',
      language: 'java',
      languageVersion: '17',
      browserChannel: 'chrome',
      ragEnabled: false
    })
  };
  c.outputChannel = { appendLine: () => undefined };
  c.linkedScenario = undefined;
  c.recordingAssociatedScenarioKey = undefined;
  c.buildRagSection = async () => ({ section: '', matches: [] });
  c.recordReceivedTokens = async () => undefined;
  c.postLlmStart = () => undefined;
  c.postLlmChunk = () => undefined;
  c.postLlmDone = () => undefined;
  c.postLlmError = (message) => {
    c.errored = message;
  };
  c.getEncryptSecret = () => async (plaintext: string) => plaintext;
  // Reproduces the reported failure exactly: Copilot's own generic
  // "Response contained no choices." error, on every call.
  c.streamCopilotResponse = async () => {
    throw new Error('Response contained no choices.');
  };
  return c;
}

test('a "no choices" failure that measured well under budget does NOT blame prompt size, and names real alternative causes', async () => {
  fakeModelConfig.maxInputTokens = 100_000;
  fakeModelConfig.tokenCountResult = 9_000; // 9% — matches the reported real-world case
  const c = makeController();

  await c.runLlmRefinement([], 'some recorded code', '');

  assert.ok(c.errored, 'expected a user-facing error to be posted');
  assert.match(c.errored!, /measured 9,000 of the selected model's 100,000-token limit \(9%\)/, 'expected the actual measured usage to be stated explicitly');
  assert.match(c.errored!, /unlikely to be the actual cause here/);
  assert.doesNotMatch(
    c.errored!,
    /the combined prompt was too large/,
    'must NOT lead with "prompt too large" when the measured evidence clearly rules it out'
  );
  assert.match(c.errored!, /organization-level content-exclusion|transient Copilot backend/, 'expected a realistic alternative cause to be named');
});

test('a "no choices" failure that measured close to the model\'s limit still gets the original size-focused guidance', async () => {
  fakeModelConfig.maxInputTokens = 100_000;
  fakeModelConfig.tokenCountResult = 92_000; // 92% — genuinely close to the ceiling
  const c = makeController();

  await c.runLlmRefinement([], 'some recorded code', '');

  assert.ok(c.errored, 'expected a user-facing error to be posted');
  assert.match(c.errored!, /the combined prompt was too large/, 'size-focused guidance should still apply when usage is genuinely high');
  assert.match(c.errored!, /measured 92,000 of the selected model's 100,000-token limit \(92%\)/);
  assert.match(c.errored!, /select fewer Gherkin steps/, 'the concrete shrink-the-request levers should still be listed');
});

test('a "no choices" failure when the model can\'t be resolved at all falls back to the original size-agnostic wording, never crashing', async () => {
  fakeModelConfig.maxInputTokens = 100_000;
  fakeModelConfig.tokenCountResult = 100;
  fakeModelConfig.resolvable = false; // findModel() itself returns undefined this time
  const c = makeController();

  try {
    await c.runLlmRefinement([], 'some recorded code', '');
  } finally {
    fakeModelConfig.resolvable = true; // restore for any later test in this file
  }

  assert.ok(c.errored, 'expected a user-facing error to be posted');
  assert.match(c.errored!, /the combined prompt was too large/, 'with no measurement available at all, the original wording is the correct, safe fallback');
  assert.doesNotMatch(c.errored!, /this request measured/i, 'no measurement was possible, so none should be fabricated or claimed');
});
