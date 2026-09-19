import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

/**
 * S01: a real, external code review ("Multi-scenario AI step-definition
 * generation review", 2026-09-11) reproduced two concrete bugs in
 * `runLlmRefinement()` ("Start AI Code Generation"): (1) switching the
 * linked Gherkin scenario WHILE generation prep (RAG retrieval, etc.) was
 * still in flight left the suggested OUTPUT FILENAME anchored to the OLD
 * scenario while the actual outgoing PROMPT was built from the NEW one;
 * (2) switching the linked scenario WHILE a model response was still
 * pending let that STALE response be silently accepted and displayed
 * under the NOW-linked (different) scenario's badge, because the
 * pre-existing request-identity check only ever detected "a NEWER
 * generation request started," never "the same request's own inputs
 * became stale."
 *
 * This file proves BOTH are fixed: (1) runLlmRefinement() now snapshots
 * `this.linkedScenario` ONCE at the very start and uses that snapshot for
 * everything (the suggested filename AND the final prompt) for the rest of
 * that one request; (2) switching scenarios now calls
 * `cancelInFlightLinkedGeneration()` (exactly what the REAL
 * FeatureFilePanel-selection callback and the 'unlinkFeatureFile' message
 * handler do), which cancels the in-flight request's own token — combined
 * with the request-identity check now ALSO testing
 * `cts.token.isCancellationRequested` (not just object identity), a stale
 * response can never be committed.
 *
 * Technique: a `Module._load` fake `vscode` (this codebase's own
 * established pattern for exercising REAL compiled vscode-dependent
 * modules without a real Extension Host — see e.g.
 * ragCorpusGenerator.redaction.test.ts) plus `Object.create(ObjectSpyPanel.prototype)`
 * to build a bare instance carrying ONLY the fields `runLlmRefinement()`
 * itself actually touches — sidestepping the real constructor's own
 * SettingsPanel/AiCodePanel/GeneratedFeaturePanel/AgenticModeController/
 * CodegenManager wiring entirely, none of which this method depends on.
 * `buildRagSection()`/`postLlmStart()`/`postLlmChunk()`/`postLlmDone()`/
 * `postLlmError()`/`streamCopilotResponse()`/`recordReceivedTokens()` are
 * all stubbed directly on the bare instance so this test observes exactly
 * what `runLlmRefinement()` itself decides, independent of the real
 * RAG/Copilot/webview machinery those normally drive.
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

function loadObjectSpyPanelWithFakeVsCode(): { ObjectSpyPanel: new (...args: never[]) => object; FeatureFilePanel: new (...args: never[]) => object } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (id: string, parent: { filename?: string } | undefined, isMain: boolean) {
    if (id === 'vscode') {
      return fakeVsCode;
    }
    if (parent?.filename?.endsWith(path.join('panel', 'objectSpyPanel.js'))) {
      // Every relative import objectSpyPanel.ts makes that this test's own
      // code paths (runLlmRefinement's prep + the scenario-switch/cancel
      // hooks) never actually exercise gets a minimal stub — the SAME
      // "fake everything not under test" posture as this codebase's other
      // Module._load harnesses. `path`/`fs` load for real (needed for
      // ordinary path/string handling elsewhere in the file at import
      // time).
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
          findModel: async () => ({ countTokens: async () => 100, maxInputTokens: 100_000 }),
          extractCodeBlock: (s: string) => s.replace(/^```\w*\n|\n```$/g, ''),
          countModelTokens: async () => ({ count: 0, maxInputTokens: 100_000 }),
          CopilotUnavailableError: class extends Error {},
          PromptTooLargeError: class extends Error {},
          sendPrompt: async () => '',
          sendPromptWithModel: async () => ''
        };
      }
      if (id === './ragTraceabilityBanner') {
        return { prependRagTraceabilityBanner: (code: string) => ({ code, observedMatches: [] }) };
      }
      // S03: real code (no vscode dependency at all — LinkedScenario is a
      // type-only import, elided from the compiled JS) — runLlmRefinement()
      // now calls this unconditionally before every postLlmDone(), so an
      // unstubbed `{}` fallback below would make it throw
      // "findUncoveredSteps is not a function" on every real call, silently
      // swallowed by runLlmRefinement()'s own catch block as if the whole
      // Copilot request had failed (caught by hand while wiring up S04's
      // own sibling test file — none of THIS file's assertions happened to
      // depend on postLlmDone() actually being reached, so it went
      // undetected here until then).
      if (id === './stepCoverageChecker') {
        return originalLoad.apply(this, arguments);
      }
      // Everything else this file imports (RAG modules, codegenManager,
      // the other panels, the agentic controller, execution/environment
      // checks, verify-fix agent, ...) is never reached by the code paths
      // this test exercises — an empty stub is enough for the module to
      // load without throwing.
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
    const featureFilePanelModule = require('../../src/panel/featureFilePanel');
    return { ObjectSpyPanel: objectSpyPanelModule.ObjectSpyPanel, FeatureFilePanel: featureFilePanelModule.FeatureFilePanel };
  } finally {
    Module._load = originalLoad;
  }
}

const { ObjectSpyPanel, FeatureFilePanel } = loadObjectSpyPanelWithFakeVsCode();

const FIXTURE = `Feature: Shopping
  Scenario: Search catalog
    When I search for "boots"
    Then I see catalog results

  Scenario: Add product to basket
    When I add "hat" to my basket
    Then the basket contains 1 items
`;

interface TestScenario {
  scenarioName: string;
  [key: string]: unknown;
}

/** A REAL FeatureFilePanel, used purely as a scenario-parsing/selection
 * utility, exactly like the review's own probe — decoupled entirely from
 * any ObjectSpyPanel instance. */
function makePicker(): { pick: (index: number) => TestScenario } {
  let selected: TestScenario | undefined;
  const picker = new (FeatureFilePanel as new (onSelected: (s: TestScenario) => void, onLinked: (p: string) => void) => Record<string, unknown>)(
    (s) => {
      selected = s;
    },
    () => undefined
  );
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseFeatureFile } = require('../../src/bdd/gherkinParser');
  (picker as Record<string, unknown>).feature = parseFeatureFile(FIXTURE);
  (picker as Record<string, unknown>).filePath = '/fixtures/shopping.feature';
  return {
    pick: (index: number) => {
      (picker as unknown as { handleMessage: (m: unknown) => void }).handleMessage({
        type: 'select',
        payload: { index, selectedStepIndices: [0, 1] }
      });
      return selected!;
    }
  };
}

interface FakeController {
  context: object;
  settingsStore: { get: () => Record<string, unknown> };
  outputChannel: { appendLine: () => void };
  linkedScenario: TestScenario | undefined;
  llmCancellation?: FakeCancellationTokenSource;
  llmCancellationOwner?: string;
  suggestedAtStart?: string;
  output?: string;
  errored?: string;
  buildRagSection: (...args: unknown[]) => Promise<{ section: string; matches: unknown[] }>;
  postLlmStart: (name: string | undefined) => void;
  postLlmChunk: (chunk: string) => void;
  postLlmDone: (code: string) => void;
  postLlmError: (message: string) => void;
  recordReceivedTokens: () => Promise<void>;
  streamCopilotResponse: (prompt: string, ...rest: unknown[]) => Promise<string>;
  getEncryptSecret: () => (plaintext: string) => Promise<string>;
  runLlmRefinement: (instructions: unknown[], code: string, customInstructions: string) => Promise<void>;
  cancelInFlightLinkedGeneration: () => void;
}

function makeController(streamCopilotResponse: (prompt: string, ...rest: unknown[]) => Promise<string>): FakeController {
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
  // S02: runLlmRefinement() now also computes recordingMayNotCoverScenario(),
  // which reads these two fields — a real instance always initializes them
  // (nativeGeneratedCode = '' as a field initializer; recordingAssociatedScenarioKey
  // implicitly undefined), but Object.create(prototype) skips field
  // initializers entirely, so this bare instance needs them set explicitly.
  // Empty/no-association means "no recording yet" — never flagged as a
  // mismatch — which is exactly right for these S01 tests (not about S02).
  (c as unknown as { nativeGeneratedCode: string }).nativeGeneratedCode = '';
  (c as unknown as { recordingAssociatedScenarioKey: string | undefined }).recordingAssociatedScenarioKey = undefined;
  c.buildRagSection = async () => ({ section: '', matches: [] });
  c.recordReceivedTokens = async () => undefined;
  c.postLlmStart = (name) => {
    c.suggestedAtStart = name;
  };
  c.postLlmChunk = () => undefined;
  c.postLlmDone = (code) => {
    c.output = code;
  };
  c.postLlmError = (message) => {
    c.errored = message;
  };
  c.getEncryptSecret = () => async (plaintext: string) => plaintext;
  c.streamCopilotResponse = streamCopilotResponse;
  return c;
}

test('S01: a scenario switch during PREPARATION (before the model call) never mixes the old scenario\'s filename with the new scenario\'s prompt', async () => {
  const picker = makePicker();
  let releasePrep: (() => void) | undefined;
  const prepEntered = new Promise<void>((resolveEntered) => {
    // Overridden below once the controller exists.
    releasePrep = () => resolveEntered();
  });
  let resumePrep: (() => void) | undefined;
  const c = makeController(async (prompt: string) => {
    capturedPrompt = prompt;
    return '```java\n// ok\n```';
  });
  let capturedPrompt = '';
  c.buildRagSection = async () => {
    releasePrep?.();
    await new Promise<void>((resolve) => {
      resumePrep = resolve;
    });
    return { section: '', matches: [] };
  };

  c.linkedScenario = picker.pick(0); // "Search catalog"
  const pending = c.runLlmRefinement([], 'reference code', '');
  await prepEntered; // prep (buildRagSection) is now paused mid-flight

  c.linkedScenario = picker.pick(1); // switch to "Add product to basket" WHILE prep is paused
  resumePrep?.();
  await pending;

  assert.equal(c.suggestedAtStart, 'SearchCatalog', 'the suggested filename must reflect the scenario active when THIS request started, never the one switched to mid-flight');
  assert.match(capturedPrompt, /Search catalog/);
  assert.doesNotMatch(capturedPrompt, /Add product to basket/, 'the prompt must be built ENTIRELY from the snapshot taken at request start — never a mix of old filename + new prompt content');
  // Guards against a downstream step (e.g. S03's coverage check) silently
  // throwing and getting swallowed by runLlmRefinement()'s own catch block
  // as if the whole Copilot request had failed — this test's OTHER
  // assertions above would still pass even if that happened, since they
  // only inspect the prompt/filename captured before the throw.
  assert.equal(c.output, '// ok', 'the request must actually complete and publish — not silently fail after a successful model response');
  assert.equal(c.errored, undefined);
});

test('S01: switching scenarios WHILE a model response is pending cancels that request — its stale result is never accepted', async () => {
  const picker = makePicker();
  let releaseStream: (() => void) | undefined;
  const streamEntered = new Promise<void>((resolve) => {
    releaseStream = () => resolve();
  });
  let finishStream: ((value: string) => void) | undefined;
  const c = makeController(async () => {
    releaseStream?.();
    return new Promise<string>((resolve) => {
      finishStream = resolve;
    });
  });

  c.linkedScenario = picker.pick(0); // "Search catalog"
  const pending = c.runLlmRefinement([], 'reference code', '');
  await streamEntered; // the model call is now pending

  // Exactly what the REAL FeatureFilePanel selection callback and the
  // 'unlinkFeatureFile' message handler both do (objectSpyPanel.ts) —
  // cancel any linked-scenario-dependent generation before swapping which
  // scenario is linked.
  c.cancelInFlightLinkedGeneration();
  c.linkedScenario = picker.pick(1); // "Add product to basket" is now linked

  finishStream?.('```java\n// Search catalog result\n```'); // the OLD request's response finally arrives
  await pending;

  assert.equal(c.output, undefined, 'a response for a CANCELLED, now-stale request must never be published — postLlmDone() must never have been called for it');
  assert.equal(c.errored, undefined, 'a cancelled request must also never surface as a user-visible error — it should be silently discarded');
  assert.equal(c.linkedScenario.scenarioName, 'Add product to basket', 'sanity check: the currently-linked scenario really is the NEW one, proving this was a genuine switch-while-pending race');
});

test('S01: cancelInFlightLinkedGeneration() does NOT touch an in-flight "Verify & Fix Code" request — only a linked-scenario generation', async () => {
  const c = makeController(async () => '```java\n// ok\n```');
  const verifyFixCts = new FakeCancellationTokenSource();
  c.llmCancellation = verifyFixCts;
  c.llmCancellationOwner = 'verifyFix';

  c.cancelInFlightLinkedGeneration();

  assert.equal(verifyFixCts.token.isCancellationRequested, false, 'an unrelated Verify & Fix Code request must never be cancelled just because the linked scenario changed');
  assert.equal(c.llmCancellation, verifyFixCts, 'the Verify & Fix Code request\'s own cancellation source must be left completely untouched');
});

test('S01: cancelInFlightLinkedGeneration() is a safe no-op when nothing linked-scenario-dependent is in flight', () => {
  const c = makeController(async () => '```java\n// ok\n```');
  assert.doesNotThrow(() => c.cancelInFlightLinkedGeneration());
});
