import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

/**
 * S03 (external review, "Multi-scenario AI step-definition generation
 * review", 2026-09-11): `runLlmRefinement()` published a Copilot response
 * as the final "AI Generated Code" with NO check that it actually contained
 * a step definition for every checked Gherkin step — reproduced with a
 * hand-crafted response containing only ONE, entirely unrelated step
 * definition, accepted verbatim with no warning surfaced anywhere.
 *
 * This file proves the fix at the `runLlmRefinement()` integration level
 * (stepCoverageChecker.test.ts already covers `findUncoveredSteps()` itself
 * in isolation): a response missing coverage for checked steps STILL gets
 * published (never silently discarded/blocked — this is a report, not a
 * gate) but ALSO logs a clear warning to the Output channel and shows a
 * non-blocking `vscode.window.showWarningMessage`; a response that
 * genuinely covers every checked step raises neither.
 *
 * Same `Module._load` fake-`vscode` + `Object.create(ObjectSpyPanel.prototype)`
 * technique as the S01/S02 sibling test files — see
 * objectSpyPanel.scenarioSwitch.test.ts's own doc comment for the full
 * rationale.
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

const shownWarnings: { message: string; items: string[] }[] = [];

const fakeVsCode = {
  CancellationTokenSource: FakeCancellationTokenSource,
  Uri: { file: fakeUri, joinPath: (base: FakeUri, ...parts: string[]) => fakeUri(path.posix.join(base.path, ...parts)) },
  window: {
    showWarningMessage: async (message: string, ...items: string[]) => {
      shownWarnings.push({ message, items });
      return undefined;
    },
    showErrorMessage: async () => undefined
  },
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
      // `stepCoverageChecker` must load for REAL — it's the thing under test.
      if (id === './stepCoverageChecker') {
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
  [key: string]: unknown;
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
  outputChannel: { appendLine: (line: string) => void };
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

function makeController(response: string): { c: FakeController; loggedLines: string[] } {
  const c = Object.create((ObjectSpyPanel as { prototype: object }).prototype) as FakeController;
  const loggedLines: string[] = [];
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
  c.outputChannel = { appendLine: (line) => loggedLines.push(line) };
  c.nativeGeneratedCode = '';
  c.recordingAssociatedScenarioKey = undefined;
  c.buildRagSection = async () => ({ section: '', matches: [] });
  c.recordReceivedTokens = async () => undefined;
  c.postLlmStart = () => undefined;
  c.postLlmChunk = () => undefined;
  c.postLlmDone = () => undefined;
  c.postLlmError = () => undefined;
  c.getEncryptSecret = () => async (plaintext: string) => plaintext;
  c.streamCopilotResponse = async () => response;
  return { c, loggedLines };
}

test('S03: a response missing step definitions for checked steps is still published, but logs and warns about the gap', async () => {
  shownWarnings.length = 0;
  const { c, loggedLines } = makeController('```java\n@When("I search for {string}")\npublic void x(String s) {}\n```');
  c.linkedScenario = makePicker().pick(0); // "Add product to basket" — 2 checked steps

  await c.runLlmRefinement([], 'reference code', '');

  const coverageLine = loggedLines.find((l) => l.includes('may have NO matching step definition'));
  assert.ok(coverageLine, 'a coverage warning must be logged to the Output channel');
  assert.match(coverageLine!, /I add "hat" to my basket/);
  assert.match(coverageLine!, /the basket contains 1 items/);

  assert.equal(shownWarnings.length, 1, 'exactly one non-blocking warning dialog must be shown');
  assert.match(shownWarnings[0].message, /missing step definition/i);
  assert.deepEqual(shownWarnings[0].items, ['Show Output']);
});

test('S03: a response that genuinely covers every checked step raises no warning at all', async () => {
  shownWarnings.length = 0;
  const { c, loggedLines } = makeController(
    '```java\n@When("I add {string} to my basket")\npublic void a(String s) {}\n@Then("the basket contains {int} items")\npublic void b(int n) {}\n```'
  );
  c.linkedScenario = makePicker().pick(0);

  await c.runLlmRefinement([], 'reference code', '');

  assert.equal(loggedLines.some((l) => l.includes('may have NO matching step definition')), false);
  assert.equal(shownWarnings.length, 0);
});

test('S03: the response is published even though coverage is incomplete — this is a report, never a gate', async () => {
  const { c } = makeController('```java\n// unrelated\n```');
  c.linkedScenario = makePicker().pick(0);
  let published: string | undefined;
  c.postLlmDone = (code) => {
    published = code;
  };

  await c.runLlmRefinement([], 'reference code', '');

  assert.equal(published, '// unrelated', 'the response must still reach postLlmDone() despite the coverage gap');
});
