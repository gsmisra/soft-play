import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

/**
 * S04 (external review, "Multi-scenario AI step-definition generation
 * review", 2026-09-11): Python generation was never given the real linked
 * feature-file path anywhere in the prompt — only the feature/scenario
 * NAMES and raw Gherkin text ever reached it — even though pytest-bdd's
 * `@scenario(path, name)` binding requires an explicit path the model has
 * no reliable way to invent. Fixed via `buildPythonScenarioBindingSection()`
 * in objectSpyPanel.ts, which now supplies the workspace-relative feature
 * path explicitly and forbids the "bind every scenario in the file"
 * `scenarios(...)` helper for a single-scenario-scoped request.
 *
 * Same `Module._load` fake-`vscode` + `Object.create(ObjectSpyPanel.prototype)`
 * technique as the S01/S02/S03 sibling test files.
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
    // no-op
  }
}

const fakeVsCode = {
  CancellationTokenSource: FakeCancellationTokenSource,
  Uri: { file: fakeUri, joinPath: (base: FakeUri, ...parts: string[]) => fakeUri(path.posix.join(base.path, ...parts)) },
  window: { showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
  // Deliberately a pass-through, same as the sibling test files — this
  // test isn't about asRelativePath()'s own real workspace-root-trimming
  // logic (a vscode.workspace concern this codebase doesn't unit-test in
  // isolation anywhere), just that objectSpyPanel.ts calls it and threads
  // whatever it returns into the prompt.
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
      if (id === './stepCoverageChecker') {
        return { findUncoveredSteps: () => [] };
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
  Scenario: Add product to basket
    When I add "hat" to my basket
    Then the basket contains 1 items
`;

interface TestScenario {
  scenarioName: string;
  featureFilePath: string;
  [key: string]: unknown;
}

function makePicker(): { pick: (selectedStepIndices: number[]) => TestScenario } {
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
  (picker as Record<string, unknown>).filePath = '/workspace/fixtures/shopping.feature';
  return {
    pick: (selectedStepIndices: number[]) => {
      (picker as unknown as { handleMessage: (m: unknown) => void }).handleMessage({
        type: 'select',
        payload: { index: 0, selectedStepIndices }
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
  recordReceivedTokens: () => Promise<void>;
  streamCopilotResponse: (prompt: string, ...rest: unknown[]) => Promise<string>;
  getEncryptSecret: () => (plaintext: string) => Promise<string>;
  runLlmRefinement: (instructions: unknown[], code: string, customInstructions: string) => Promise<void>;
}

function makeController(language: 'java' | 'python', capturePrompt: (prompt: string) => void): FakeController {
  const c = Object.create((ObjectSpyPanel as { prototype: object }).prototype) as FakeController;
  c.context = {};
  c.settingsStore = {
    get: () => ({
      copilotEnabled: true,
      copilotModelId: 'fake-model',
      automationMode: 'ui',
      language,
      languageVersion: language === 'java' ? '17' : '3.11',
      browserChannel: 'chrome',
      ragEnabled: false
    })
  };
  c.outputChannel = { appendLine: () => undefined };
  c.nativeGeneratedCode = '';
  c.recordingAssociatedScenarioKey = undefined;
  c.buildRagSection = async () => ({ section: '', matches: [] });
  c.recordReceivedTokens = async () => undefined;
  c.postLlmStart = () => undefined;
  c.postLlmChunk = () => undefined;
  c.postLlmDone = () => undefined;
  c.postLlmError = () => undefined;
  c.getEncryptSecret = () => async (plaintext: string) => plaintext;
  c.streamCopilotResponse = async (prompt: string) => {
    capturePrompt(prompt);
    return '```python\n# ok\n```';
  };
  return c;
}

test('S04: Python generation prompt carries an explicit @scenario(path, name) binding using the real linked feature-file path', async () => {
  let capturedPrompt = '';
  const c = makeController('python', (p) => {
    capturedPrompt = p;
  });
  c.linkedScenario = makePicker().pick([0, 1]); // full scenario selected

  await c.runLlmRefinement([], 'reference code', '');

  assert.match(capturedPrompt, /Required pytest-bdd scenario binding/);
  assert.match(
    capturedPrompt,
    /@scenario\('\/workspace\/fixtures\/shopping\.feature', 'Add product to basket'\)/,
    'must embed the REAL linked feature file path, not a placeholder'
  );
  assert.match(capturedPrompt, /Do NOT.*use `scenarios\('\/workspace\/fixtures\/shopping\.feature'\)`/s, 'must explicitly forbid the bind-every-scenario helper');
});

test('S04: Java generation prompt never gets a pytest-bdd binding section (Cucumber-JVM has no such thing)', async () => {
  let capturedPrompt = '';
  const c = makeController('java', (p) => {
    capturedPrompt = p;
  });
  c.linkedScenario = makePicker().pick([0, 1]);

  await c.runLlmRefinement([], 'reference code', '');

  assert.doesNotMatch(capturedPrompt, /pytest-bdd scenario binding/);
  assert.doesNotMatch(capturedPrompt, /@scenario\(/);
});

test('S04: a partial ("bare snippet") selection never gets a pytest-bdd binding section either — no test-function shell exists to bind', async () => {
  let capturedPrompt = '';
  const c = makeController('python', (p) => {
    capturedPrompt = p;
  });
  c.linkedScenario = makePicker().pick([0]); // only 1 of 2 steps checked

  await c.runLlmRefinement([], 'reference code', '');

  assert.doesNotMatch(capturedPrompt, /pytest-bdd scenario binding/);
});
