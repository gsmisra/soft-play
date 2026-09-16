import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

/**
 * S02: the same external review ("Multi-scenario AI step-definition
 * generation review", 2026-09-11) that produced S01 also reproduced a
 * second bug: switching the linked Gherkin scenario does NOT re-associate a
 * fresh recording. `runLlmRefinement()`'s prompt confidently told the model
 * to "reuse its locators as-is" from whatever Playwright recording was
 * still sitting in the editor, with zero check that the recording actually
 * corresponds to the CURRENTLY linked scenario — reproduced with a "search
 * for boots" recording silently reused as if it were valid grounding for an
 * entirely unrelated "add to basket" scenario, in both Java and Python
 * prompt paths.
 *
 * Fixed via a new `recordingAssociatedScenarioKey` field, stamped ONLY from
 * the real `codegenManager.onCodeUpdate` callback (never from the
 * scenario-link callback itself) with whichever scenario is linked at the
 * moment fresh recording content actually arrives — see its own doc comment
 * in objectSpyPanel.ts. `recordingMayNotCoverScenario()` compares that
 * stamp against a candidate scenario; when they disagree (and there IS
 * existing recorded content), `buildLlmPrompt()` swaps its normally
 * confident "reuse its locators as-is" framing for an explicit,
 * honest ⚠ UNVERIFIED caveat instead — both in the "Reference
 * Playwright-generated code" section and, restated for recency, right next
 * to the "Linked Gherkin" step list itself.
 *
 * Same `Module._load` fake-`vscode` + `Object.create(ObjectSpyPanel.prototype)`
 * technique as objectSpyPanel.scenarioSwitch.test.ts (S01) — see that
 * file's own doc comment for the full rationale. `recordingAssociatedScenarioKey`
 * is set directly on the bare instance in these tests to simulate exactly
 * what the constructor's real `onCodeUpdate` callback would have stamped,
 * using the SAME `<featureFilePath>::<scenarioKind>::<scenarioName>` format
 * documented on `scenarioIdentityKey()` in objectSpyPanel.ts — a deliberate,
 * narrow coupling to that documented format, not a guess.
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
      if (id === 'path' || id === 'fs') {
        return originalLoad.apply(this, arguments);
      }
      if (id === '../cache/fileCache') {
        return { readFileCachedSync: () => '', readWorkspaceFileCached: async () => undefined };
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
      // Stubbed with a small, deterministic stand-in (not the real regex —
      // that's covered directly by test/llm/databaseTestingInstructions.test.ts)
      // so this file's own tests can verify runLlmRefinement()'s WIRING
      // (does a database-mentioning chat instruction actually reach the
      // rendered prompt?) without depending on __dirname-relative file
      // reads resolving correctly under this compiled test layout.
      if (id === '../llm/databaseTestingInstructions') {
        return {
          withDatabaseTestingInstructions: (instructions: { path: string; content: string }[], ...texts: (string | undefined | null)[]) =>
            texts.some((t) => !!t && /database|mongodb|postgres|verify.*table/i.test(t))
              ? [...instructions, { path: 'database_testing_instructions.md', content: 'DB-TESTING-INSTRUCTIONS-MARKER' }]
              : instructions,
          mentionsDatabaseTesting: (t: string) => !!t && /database|mongodb|postgres|verify.*table/i.test(t)
        };
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
      // S03: real code, zero vscode dependency — see
      // objectSpyPanel.scenarioSwitch.test.ts's identical comment for why
      // this must NOT fall through to the generic `{}` stub below.
      if (id === './stepCoverageChecker') {
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
  scenarioKind: string;
  featureFilePath: string;
  [key: string]: unknown;
}

/** Same documented format as scenarioIdentityKey() in objectSpyPanel.ts —
 * see this file's own doc comment for why the test reconstructs it rather
 * than importing the (deliberately unexported) internal helper. */
function testScenarioKey(scenario: TestScenario): string {
  return `${scenario.featureFilePath}::${scenario.scenarioKind}::${scenario.scenarioName}`;
}

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
  nativeGeneratedCode: string;
  recordingAssociatedScenarioKey: string | undefined;
  buildRagSection: (...args: unknown[]) => Promise<{ section: string; matches: unknown[] }>;
  postLlmStart: (name: string | undefined) => void;
  postLlmChunk: (chunk: string) => void;
  postLlmDone: (code: string) => void;
  postLlmError: (message: string) => void;
  output?: string;
  errored?: string;
  recordReceivedTokens: () => Promise<void>;
  streamCopilotResponse: (prompt: string, ...rest: unknown[]) => Promise<string>;
  getEncryptSecret: () => (plaintext: string) => Promise<string>;
  runLlmRefinement: (instructions: unknown[], code: string, customInstructions: string) => Promise<void>;
  recordingMayNotCoverScenario: (scenario: TestScenario | undefined) => boolean;
  lastCustomInstructions: string;
  lastApiRequestDetails: undefined;
  selectedInstructionFiles: string[];
  handleMessage: (message: unknown) => Promise<void>;
  regenerateAiCode: () => Promise<void>;
}

function makeController(capturePrompt: (prompt: string) => void): FakeController {
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
  c.nativeGeneratedCode = '';
  c.recordingAssociatedScenarioKey = undefined;
  c.lastCustomInstructions = '';
  c.lastApiRequestDetails = undefined;
  c.selectedInstructionFiles = [];
  c.buildRagSection = async () => ({ section: '', matches: [] });
  c.recordReceivedTokens = async () => undefined;
  c.postLlmStart = () => undefined;
  c.postLlmChunk = () => undefined;
  // Captured (not just no-op'd) so tests can assert the request actually
  // completed and published — not silently swallowed by runLlmRefinement()'s
  // own catch block by some unrelated downstream step throwing (e.g. S03's
  // coverage check, when it isn't loaded for real — see this file's own
  // Module._load stub list above).
  c.postLlmDone = (code) => {
    c.output = code;
  };
  c.postLlmError = (message) => {
    c.errored = message;
  };
  c.getEncryptSecret = () => async (plaintext: string) => plaintext;
  c.streamCopilotResponse = async (prompt: string) => {
    capturePrompt(prompt);
    return '```java\n// ok\n```';
  };
  return c;
}

test('S02: recordingMayNotCoverScenario() is false when nothing has been recorded yet', () => {
  const c = makeController(() => undefined);
  const scenarioA = makePicker().pick(0);
  assert.equal(c.recordingMayNotCoverScenario(scenarioA), false);
});

test('S02: recordingMayNotCoverScenario() is false for the normal "record first, link after" flow', () => {
  const c = makeController(() => undefined);
  c.nativeGeneratedCode = 'page.getByRole("button").click();';
  // recordingAssociatedScenarioKey stays undefined — the recording happened
  // before ANY scenario was ever linked, exactly like a real onCodeUpdate
  // firing while this.linkedScenario is still undefined.
  const scenarioA = makePicker().pick(0);
  assert.equal(c.recordingMayNotCoverScenario(scenarioA), false);
});

test('S02: recordingMayNotCoverScenario() is true when the recording is associated with a DIFFERENT scenario', () => {
  const c = makeController(() => undefined);
  c.nativeGeneratedCode = 'page.getByRole("button").click();';
  const picker = makePicker();
  const scenarioA = picker.pick(0); // "Search catalog"
  const scenarioB = picker.pick(1); // "Add product to basket"
  c.recordingAssociatedScenarioKey = testScenarioKey(scenarioA); // recording was captured for A

  assert.equal(c.recordingMayNotCoverScenario(scenarioB), true, 'switching to B without a fresh recording must be flagged');
  assert.equal(c.recordingMayNotCoverScenario(scenarioA), false, 'A itself still matches its own recording');
});

test('S02: relinking the SAME scenario the recording was captured for is never flagged', () => {
  const c = makeController(() => undefined);
  c.nativeGeneratedCode = 'page.getByRole("button").click();';
  const scenarioA = makePicker().pick(0);
  c.recordingAssociatedScenarioKey = testScenarioKey(scenarioA);
  assert.equal(c.recordingMayNotCoverScenario(scenarioA), false);
});

test('S02: an empty/blank recording is never flagged, regardless of association', () => {
  const c = makeController(() => undefined);
  c.nativeGeneratedCode = '   ';
  const picker = makePicker();
  const scenarioA = picker.pick(0);
  const scenarioB = picker.pick(1);
  c.recordingAssociatedScenarioKey = testScenarioKey(scenarioA);
  assert.equal(c.recordingMayNotCoverScenario(scenarioB), false);
});

test('S02: runLlmRefinement() builds an honest ⚠ UNVERIFIED prompt when the recording does not match the linked scenario', async () => {
  let capturedPrompt = '';
  const c = makeController((p) => {
    capturedPrompt = p;
  });
  c.nativeGeneratedCode = 'reference code for boots search';
  const picker = makePicker();
  const scenarioA = picker.pick(0); // "Search catalog" — what the recording actually corresponds to
  c.recordingAssociatedScenarioKey = testScenarioKey(scenarioA);
  c.linkedScenario = picker.pick(1); // switched to "Add product to basket" — no fresh recording since

  await c.runLlmRefinement([], 'reference code for boots search', '');

  assert.match(capturedPrompt, /UNVERIFIED/, 'the prompt must explicitly flag the recording as unverified against this scenario');
  assert.doesNotMatch(
    capturedPrompt,
    /match this structure and style, reuse its locators as-is/,
    'the normal confident "reuse as-is" framing must NOT be used when correspondence is unverified'
  );
  assert.match(capturedPrompt, /add "hat" to my basket/i, 'the actual linked scenario\'s steps must still be present in the prompt');
  assert.equal(c.output, '// ok', 'the request must actually complete and publish');
  assert.equal(c.errored, undefined);
});

test('S02: runLlmRefinement() keeps the normal confident framing when the recording DOES match the linked scenario', async () => {
  let capturedPrompt = '';
  const c = makeController((p) => {
    capturedPrompt = p;
  });
  c.nativeGeneratedCode = 'reference code for boots search';
  const scenarioA = makePicker().pick(0); // "Search catalog"
  c.recordingAssociatedScenarioKey = testScenarioKey(scenarioA);
  c.linkedScenario = scenarioA; // same scenario the recording was captured for

  await c.runLlmRefinement([], 'reference code for boots search', '');

  assert.doesNotMatch(capturedPrompt, /UNVERIFIED/, 'a genuinely matching recording must not be flagged as unverified');
  assert.match(capturedPrompt, /match this structure and style, reuse its locators as-is/);
  assert.equal(c.output, '// ok', 'the request must actually complete and publish');
  assert.equal(c.errored, undefined);
});

test('S02: runLlmRefinement() never flags the normal "record first, link after" first-time link', async () => {
  let capturedPrompt = '';
  const c = makeController((p) => {
    capturedPrompt = p;
  });
  c.nativeGeneratedCode = 'reference code for boots search';
  // recordingAssociatedScenarioKey stays undefined: nothing was ever linked
  // while this recording was captured — the ordinary, intended flow.
  c.linkedScenario = makePicker().pick(0);

  await c.runLlmRefinement([], 'reference code for boots search', '');

  assert.doesNotMatch(capturedPrompt, /UNVERIFIED/);
  assert.equal(c.output, '// ok', 'the request must actually complete and publish');
  assert.equal(c.errored, undefined);
});

// ---------------------------------------------------------------------
// Database testing instructions wiring — runLlmRefinement()'s `instructions`
// array is the single injection point shared by the mandatory-measurement
// pass and the real send (see llm/databaseTestingInstructions.ts). The
// regex itself is covered directly by
// test/llm/databaseTestingInstructions.test.ts; this file's Module._load
// stub above (a small deterministic stand-in) verifies the WIRING: does a
// database-mentioning "Instant instructions to LLM" chat box value actually
// reach the rendered prompt?
// ---------------------------------------------------------------------

test('runLlmRefinement(): a database-mentioning chat instruction pulls the database-testing section into the sent prompt', async () => {
  let capturedPrompt = '';
  const c = makeController((p) => {
    capturedPrompt = p;
  });
  c.nativeGeneratedCode = 'some recorded code';
  c.linkedScenario = undefined;

  await c.runLlmRefinement([], 'some recorded code', 'Connect to the database and verify the users table');

  assert.match(capturedPrompt, /DB-TESTING-INSTRUCTIONS-MARKER/, 'expected the database-testing section to be included in the sent prompt');
  assert.equal(c.output, '// ok', 'the request must actually complete and publish');
  assert.equal(c.errored, undefined);
});

test('runLlmRefinement(): unrelated chat instructions never pull in the database-testing section', async () => {
  let capturedPrompt = '';
  const c = makeController((p) => {
    capturedPrompt = p;
  });
  c.nativeGeneratedCode = 'some recorded code';
  c.linkedScenario = undefined;

  await c.runLlmRefinement([], 'some recorded code', 'Make the button click faster');

  assert.doesNotMatch(capturedPrompt, /DB-TESTING-INSTRUCTIONS-MARKER/, 'unrelated instructions must not pull in the database-testing section');
  assert.equal(c.output, '// ok');
  assert.equal(c.errored, undefined);
});

// ---------------------------------------------------------------------
// RAG usage reminder (buildRagUsageReminder() in objectSpyPanel.ts) — a
// user reported that offered reusable components were ignored by the LLM
// (banner: "N reusable components were offered... no call evidence was
// observed"). Root cause: the full "## Reusable components available"
// section is placed early in the prompt, well before the Linked
// Gherkin/free-text-instructions sections — both of which this codebase's
// own existing comments already document as deliberately placed LAST
// because "a model weighs what it reads most recently more heavily". This
// verifies the fix: a short restatement of the RAG usage rule is now ALSO
// placed at the very end (recency), right before the free-text
// instructions block, whenever a RAG section was actually included.
// ---------------------------------------------------------------------

test('runLlmRefinement(): a non-empty RAG section gets a recency-boosted usage reminder near the end of the prompt', async () => {
  let capturedPrompt = '';
  const c = makeController((p) => {
    capturedPrompt = p;
  });
  c.nativeGeneratedCode = 'some recorded code';
  c.linkedScenario = undefined;
  c.buildRagSection = async () => ({
    section: '\n## Reusable components available — reuse ONLY the ones that genuinely fit\n### 1. Query Postgres (id: `pg-1`)',
    matches: [{ id: 'pg-1' }]
  });

  await c.runLlmRefinement([], 'some recorded code', '');

  assert.match(capturedPrompt, /Reusable components reminder \(read this again before writing the final code\)/);
  assert.match(capturedPrompt, /copy its import statement EXACTLY, character for character/);
  // Recency: the reminder must appear AFTER the full RAG section itself,
  // not merely somewhere in the prompt.
  const ragSectionIndex = capturedPrompt.indexOf('Reusable components available — reuse ONLY');
  const reminderIndex = capturedPrompt.indexOf('Reusable components reminder');
  assert.ok(ragSectionIndex >= 0 && reminderIndex > ragSectionIndex, 'the reminder must come AFTER the full RAG section, not before it');
  assert.equal(c.output, '// ok');
  assert.equal(c.errored, undefined);
});

test('runLlmRefinement(): no RAG section means no usage reminder either (zero cost when RAG had nothing to offer)', async () => {
  let capturedPrompt = '';
  const c = makeController((p) => {
    capturedPrompt = p;
  });
  c.nativeGeneratedCode = 'some recorded code';
  c.linkedScenario = undefined;
  c.buildRagSection = async () => ({ section: '', matches: [] });

  await c.runLlmRefinement([], 'some recorded code', '');

  assert.doesNotMatch(capturedPrompt, /Reusable components reminder/);
  assert.equal(c.output, '// ok');
  assert.equal(c.errored, undefined);
});

// ---------------------------------------------------------------------
// chatInstructionsStaged wiring — a user asked: if a second chat message
// is sent while (or after) a generation is already in flight, is it added
// to the LLM context too? Answer traced from the real code: "Start AI Code
// Generation" already accumulates every staged chat message correctly
// (main.js's `stagedInstructions`/`collectInstructionsForGeneration()`),
// but "Regenerate AI Code" lives in a COMPLETELY SEPARATE webview panel
// with no chat box of its own — it only ever reads
// `this.lastCustomInstructions`, which was previously updated ONLY by an
// actual sendToLlm()/generateFeatureFile() call. A message staged in the
// sidebar chat but never followed by clicking "Start AI Code Generation"
// again was silently invisible to a "Regenerate AI Code" click. Fixed by
// a new `chatInstructionsStaged` message, posted the moment a chat message
// is actually staged (not merely typed), that keeps
// `lastCustomInstructions` continuously in sync.
// ---------------------------------------------------------------------

test('handleMessage(chatInstructionsStaged) updates lastCustomInstructions, trimmed', async () => {
  const c = makeController(() => undefined);
  await c.handleMessage({ type: 'chatInstructionsStaged', payload: { customInstructions: '  message one\n\nmessage two  ' } });
  assert.equal(c.lastCustomInstructions, 'message one\n\nmessage two');
});

test('a message staged AFTER the last "Start AI Code Generation" send is still picked up by a later "Regenerate AI Code" click', async () => {
  let capturedPrompt = '';
  const c = makeController((p) => {
    capturedPrompt = p;
  });
  c.nativeGeneratedCode = 'some recorded code';
  c.linkedScenario = undefined;

  // Simulates: user sent "first message" via Start AI Code Generation
  // earlier (lastCustomInstructions already set from that real send)...
  c.lastCustomInstructions = 'first message';
  // ...then, WITHOUT clicking "Start AI Code Generation" again, staged a
  // second message in the sidebar chat box (main.js posts this the moment
  // Enter/➤ is pressed) — before this fix, this text never reached the
  // extension host at all until/unless a fresh full send happened.
  await c.handleMessage({ type: 'chatInstructionsStaged', payload: { customInstructions: 'first message\n\nsecond message' } });

  // Now the user clicks "Regenerate AI Code" in the separate AI Generated
  // Code panel — it has no chat box of its own and relies entirely on
  // lastCustomInstructions.
  await c.regenerateAiCode();

  assert.match(capturedPrompt, /second message/, 'the message staged after the last real send must still reach the regenerated prompt');
  assert.equal(c.output, '// ok');
  assert.equal(c.errored, undefined);
});
