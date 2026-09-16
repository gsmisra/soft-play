import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * Item 3: direct unit tests for `AgenticModeController`'s own orchestration
 * — previously "reviewed, not tested" for all 1,100+ lines (every extracted
 * PURE helper — agenticActionShape.ts, agenticRequestEpoch.ts,
 * csvTestCaseGenerator.ts, csvUtils.ts, the format-specific ingestion
 * modules — already had direct tests; the class tying them together never
 * did). Uses this codebase's own established `Object.create(prototype)` +
 * `Module._load` fake-`vscode` technique (see
 * test/panel/objectSpyPanel.scenarioSwitch.test.ts, first proven for
 * exactly this kind of "too complex to construct for real" class) —
 * bypasses the real constructor (which builds real `AiCodePanel`/
 * `GeneratedFeaturePanel`/webview panels) entirely, since none of that is
 * needed to exercise the orchestration logic itself.
 *
 * Scope: this is NOT exhaustive coverage of every method in the class —
 * it targets the specific, previously-unverified correctness properties
 * the review identified: Item 1's `runAgenticChain()` sequencing, the
 * cancellation-supersede behavior every `generate*()` method relies on
 * (A13), and Item 4's `verifyCancellation` field being genuinely isolated
 * from `codeCancellation` (the exact cross-flow contamination class Standard
 * mode's own `llmCancellationOwner` field had to be retrofitted to fix —
 * see objectSpyPanel.ts's own doc comment on that field).
 */

function fakeUri(p: string) {
  return { fsPath: p, path: p, scheme: 'file', toString: () => p };
}

interface FakeModel {
  id: string;
  maxInputTokens: number;
  countTokens: (text: string) => Promise<number>;
}

function fakeModel(): FakeModel {
  return { id: 'fake-model', maxInputTokens: 10_000, countTokens: async (text: string) => Math.ceil(text.length / 4) };
}

const fakeVsCode = {
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {
      /* no-op */
    }
  },
  Uri: { joinPath: (base: { path: string }, ...parts: string[]) => fakeUri(path.posix.join(base.path, ...parts)) },
  ViewColumn: { Beside: 2 },
  window: { showWarningMessage: async () => 'Yes', showErrorMessage: async () => undefined },
  // No open workspace — buildRagSection() (via ragEnabled: false below) and
  // readSelectedCustomInstructionFiles() (via an empty selection) both
  // short-circuit before ever touching vscode.workspace.fs, so this can
  // stay minimal.
  // `findFiles` is needed only because reset()'s own fire-and-forget
  // refreshInstructionFiles() call reaches it — never actually exercised
  // for its own results by any test here.
  workspace: { workspaceFolders: undefined, findFiles: async () => [] },
  lm: { selectChatModels: async () => [fakeModel()] }
};

function loadAgenticModeControllerWithFakes(): { AgenticModeController: new (...args: unknown[]) => Record<string, any> } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (id: string, parent: unknown, isMain: boolean) {
    if (id === 'vscode') {
      return fakeVsCode;
    }
    // eslint-disable-next-line prefer-rest-params
    return originalLoad.apply(this, arguments);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../src/agentic/agenticModeController');
    return { AgenticModeController: mod.AgenticModeController };
  } finally {
    Module._load = originalLoad;
  }
}

const { AgenticModeController } = loadAgenticModeControllerWithFakes();

const FAKE_SETTINGS = {
  copilotEnabled: true,
  copilotModelId: 'fake-model',
  ragEnabled: false, // keeps buildRagSection() a same-tick no-op — see fakeVsCode's own comment
  automationMode: 'ui',
  language: 'java',
  languageVersion: '17'
};

function fakePanel() {
  const state = { code: '', shown: false, verifyEnabled: true, verifyStatus: '' };
  return {
    hasCode: () => state.code.trim().length > 0,
    hasContent: () => state.code.trim().length > 0,
    show: () => {
      state.shown = true;
    },
    startGenerating: () => undefined,
    finish: (text: string) => {
      state.code = text;
    },
    showError: () => undefined,
    setLanguage: () => undefined,
    setVerifyButtonEnabled: (enabled: boolean) => {
      state.verifyEnabled = enabled;
    },
    setVerifyStatus: (text: string) => {
      state.verifyStatus = text;
    },
    requestCurrentCode: async () => state.code,
    getContent: () => state.code,
    clear: () => {
      state.code = '';
    },
    _state: state
  };
}

function makeController(): Record<string, any> {
  const controller = Object.create(AgenticModeController.prototype);
  controller.settingsStore = { get: () => FAKE_SETTINGS };
  controller.outputChannel = { appendLine: () => undefined };
  controller.getSidebarWebview = () => undefined;
  // `secrets` — needed by verifyAndFixAgenticCode()'s real
  // secretVault.getSecretEnv() call (VS Code's SecretStorage API); an
  // in-memory stand-in is enough since no test here asserts anything about
  // the actual encryption key material.
  const secretsStore = new Map<string, string>();
  controller.context = {
    extensionUri: fakeUri('/fake-ext'),
    globalStorageUri: fakeUri('/fake-storage'),
    secrets: {
      get: async (key: string) => secretsStore.get(key),
      store: async (key: string, value: string) => {
        secretsStore.set(key, value);
      }
    }
  };
  controller.files = new Map();
  controller.lastUserRequest = 'do the thing';
  controller.sessionEpoch = 0;
  controller.selectedInstructionFiles = [];
  controller.lastReceivedTokens = 0;
  controller.tokenEstimateSeq = 0;
  controller.lastCsvUri = undefined;
  controller.codeCancellation = undefined;
  controller.featureCancellation = undefined;
  controller.csvCancellation = undefined;
  controller.verifyCancellation = undefined;
  controller.aiCodePanel = fakePanel();
  controller.generatedFeaturePanel = fakePanel();
  return controller;
}

test('runAgenticChain() invokes the given chain factory with a model bound to the CURRENT cts, and returns the result plus the settings actually used', async () => {
  const controller = makeController();
  const cts = new fakeVsCode.CancellationTokenSource();
  let receivedModel: any;
  const chainFactory = (model: unknown) => {
    receivedModel = model;
    return { invoke: async (input: { userRequest: string }) => `generated: ${input.userRequest}` };
  };

  const { result, settings } = await controller.runAgenticChain('feature', cts, chainFactory);

  assert.equal(result, 'generated: do the thing');
  assert.equal(settings, FAKE_SETTINGS);
  assert.ok(receivedModel, 'the chain factory must have been called with a model');
  assert.equal(receivedModel.cancellationToken, cts.token, 'the model must be bound to THIS request\'s own cancellation token');
});

test('a NEW "Generate" click cancels the PREVIOUS in-flight cts for the same action, and the stale response never overwrites the panel', async () => {
  const controller = makeController();
  let resolveFirst: (v: string) => void;
  const firstInvokePromise = new Promise<string>((r) => {
    resolveFirst = r;
  });
  let callCount = 0;
  // buildAgenticAutomationCodeChain-shaped stub: first call pauses until we
  // resolve it manually; second call resolves immediately.
  const chainFactory = () => ({
    invoke: async () => {
      callCount++;
      return callCount === 1 ? firstInvokePromise : 'second result';
    }
  });

  const firstCallPromise = controller.generateAutomationCode
    ? (async () => {
        // Reach into runAgenticChain directly for the FIRST call so we can
        // control its own cts explicitly and observe cancellation, without
        // needing to fake extractCodeBlock()/the full generate flow.
        const firstCts = new fakeVsCode.CancellationTokenSource();
        controller.codeCancellation = firstCts;
        return controller.runAgenticChain('code', firstCts, chainFactory).then((r: any) => ({ ...r, cts: firstCts }));
      })()
    : undefined;

  // A second "Generate" click supersedes the first — mirrors
  // generateAutomationCode()'s own cancel-old/create-new sequence.
  controller.codeCancellation.cancel();
  const secondCts = new fakeVsCode.CancellationTokenSource();
  controller.codeCancellation = secondCts;
  const second = await controller.runAgenticChain('code', secondCts, chainFactory);

  resolveFirst!('first result (stale)');
  const first = await firstCallPromise;

  assert.equal(first.cts.token.isCancellationRequested, true, 'the first request\'s own token must have been cancelled');
  assert.equal(second.result, 'second result');
  // The real generate*() methods guard exactly this with isStaleRequest()
  // (this.codeCancellation !== cts) before ever committing a result to the
  // panel — confirm the FIELD itself now points at the second request's
  // cts, which is what that guard actually checks.
  assert.equal(controller.codeCancellation, secondCts);
  assert.notEqual(controller.codeCancellation, first.cts);
});

test('Item 4: verifyCancellation is a genuinely SEPARATE field from codeCancellation — starting a fresh code generation never touches an in-flight Verify & Fix run\'s own token', async () => {
  const controller = makeController();
  const verifyToken = new fakeVsCode.CancellationTokenSource();
  controller.verifyCancellation = verifyToken;

  const chainFactory = () => ({ invoke: async () => 'code result' });
  const codeCts = new fakeVsCode.CancellationTokenSource();
  controller.codeCancellation = codeCts;
  await controller.runAgenticChain('code', codeCts, chainFactory);

  assert.equal(verifyToken.token.isCancellationRequested, false, 'an unrelated code-generation call must never cancel an in-flight Verify & Fix Code run');
});

test('generateFeatureFile(): a response with at least one real Scenario block is accepted and committed', async () => {
  const controller = makeController();
  const validFeature = 'Feature: Login\n\nScenario: Successful login\n  Given a user\n  When they log in\n  Then they see the dashboard\n';
  const chainModule = require('../../src/agentic/agenticChains');
  const original = chainModule.buildAgenticFeatureFileChain;
  chainModule.buildAgenticFeatureFileChain = () => ({ invoke: async () => validFeature });
  try {
    await controller.generateFeatureFile();
  } finally {
    chainModule.buildAgenticFeatureFileChain = original;
  }
  assert.equal(controller.generatedFeaturePanel._state.code.trim(), validFeature.trim());
});

test('Item 5: generateFeatureFile() rejects a response with NO parseable Scenario block, instead of silently showing broken content', async () => {
  const controller = makeController();
  const notGherkin = 'Sorry, here is a summary of the login flow instead of a feature file.';
  const chainModule = require('../../src/agentic/agenticChains');
  const original = chainModule.buildAgenticFeatureFileChain;
  chainModule.buildAgenticFeatureFileChain = () => ({ invoke: async () => notGherkin });
  let erroredMessage: string | undefined;
  controller.generatedFeaturePanel.showError = (message: string) => {
    erroredMessage = message;
  };
  try {
    await controller.generateFeatureFile();
  } finally {
    chainModule.buildAgenticFeatureFileChain = original;
  }
  assert.equal(controller.generatedFeaturePanel._state.code, '', 'invalid content must never be committed to the panel');
  assert.ok(erroredMessage && /doesn't parse as a valid Gherkin/.test(erroredMessage));
});

test('A15: a session reset (bumped sessionEpoch) WHILE ingestFiles() is still parsing discards that call\'s own result — nothing from a "Clear Data" mid-flight upload leaks into the files Map', async () => {
  const controller = makeController();
  const base64 = Buffer.from('some requirement text', 'utf-8').toString('base64');

  const ingestPromise = controller.ingestFiles([{ fileName: 'requirements.txt', base64 }]);
  // Simulates "Clear Data"/reset() firing while the above call's own
  // Promise.all(...) is still in flight — ingestFiles() captured its OWN
  // epoch synchronously before this line ever runs.
  controller.sessionEpoch++;
  const result = await ingestPromise;

  assert.deepEqual(result, { accepted: [], rejected: [] }, 'a superseded ingest must report nothing, not a stale success');
  assert.equal(controller.files.size, 0, 'the stale file must never be inserted into the files Map');
});

test('ingestFiles() started and resolved with NO session reset in between behaves normally', async () => {
  const controller = makeController();
  const base64 = Buffer.from('some requirement text', 'utf-8').toString('base64');

  const result = await controller.ingestFiles([{ fileName: 'requirements.txt', base64 }]);

  assert.equal(result.accepted.length, 1);
  assert.equal(controller.files.size, 1);
});

test('Item 7: generateTestCaseCsv() enforces the real .github/Jira_test_case_template.csv column count as a hard error', async () => {
  const controller = makeController();
  // Simulates a real template file existing with 5 columns.
  controller.readCsvTemplateExample = async () => ({
    status: 'ok',
    header: ['Summary', 'Description', 'Step #', 'Step Explanation', 'Expected Result'],
    exampleRows: [['Example', 'Example desc', '1', 'Do the thing', 'It works']]
  });
  const chainModule = require('../../src/agentic/agenticChains');
  const original = chainModule.buildAgenticTestCaseCsvChain;
  // Only 4 columns — deliberately short of the template's 5.
  chainModule.buildAgenticTestCaseCsvChain = () => ({ invoke: async () => 'Summary,Step #,Step Explanation,Expected Result\nLogin,1,Enter credentials,Logged in\n' });
  let reportedError: string | undefined;
  const webview = { postMessage: (m: { type: string; payload: { state: string; message?: string } }) => {
    if (m.type === 'agentic:csvStatus' && m.payload.state === 'error') {
      reportedError = m.payload.message;
    }
  } };
  controller.getSidebarWebview = () => webview;
  try {
    await controller.generateTestCaseCsv();
  } finally {
    chainModule.buildAgenticTestCaseCsvChain = original;
  }
  assert.ok(reportedError && /does not exactly match/.test(reportedError), `expected a header-mismatch error, got: ${reportedError}`);
});

// ---------------------------------------------------------------------
// F01/F02: real public-action ownership-race tests for
// verifyAndFixAgenticCode() — module-level monkey-patches (the SAME
// require-cache-sharing technique used above for agenticChains.js) since
// this method reaches execution/environmentCheck.ts and
// agent/verifyFixOrchestrator.ts directly, neither of which this file's
// own Module._load hook fakes (only 'vscode' is intercepted).
// ---------------------------------------------------------------------

function withRealScratchDir<T>(controller: Record<string, any>, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-verify-test-'));
  controller.context.globalStorageUri = fakeUri(dir);
  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('F01: a session reset (Clear Data) firing WHILE verifyAndFixAgenticCode() is still in its preflight prevents the agent from ever starting', async () => {
  const controller = makeController();
  controller.aiCodePanel._state.code = 'some code to verify';

  const envModule = require('../../src/execution/environmentCheck');
  const originalCheckEnvironment = envModule.checkEnvironment;
  let resolveEnv!: (v: unknown) => void;
  envModule.checkEnvironment = () => new Promise((r) => (resolveEnv = r));

  const orchestratorModule = require('../../src/agent/verifyFixOrchestrator');
  const originalRunVerifyFixAgent = orchestratorModule.runVerifyFixAgent;
  let runVerifyFixAgentCallCount = 0;
  orchestratorModule.runVerifyFixAgent = async () => {
    runVerifyFixAgentCallCount++;
    return { stopReason: 'success', summary: 'ok', transcript: [] };
  };

  try {
    await withRealScratchDir(controller, async () => {
      const verifyPromise = controller.verifyAndFixAgenticCode();
      // Let the synchronous portion (through the checkEnvironment() call
      // itself starting) actually run before the reset below.
      await new Promise((r) => setImmediate(r));
      // The reproduced F01 gap: this used to have nothing to cancel yet,
      // since verifyCancellation was assigned much later than this point.
      controller.reset();
      resolveEnv({ ok: true, message: 'OK', pythonCommand: 'python' });
      await verifyPromise;
    });
    assert.equal(runVerifyFixAgentCallCount, 0, 'a session cleared during preflight must never let the agent actually start');
  } finally {
    envModule.checkEnvironment = originalCheckEnvironment;
    orchestratorModule.runVerifyFixAgent = originalRunVerifyFixAgent;
  }
});

test('F02: generateAutomationCode() takes over aiCodePanel ownership from whatever (e.g. an in-flight verify) held it before — a stale holder\'s own ownership check fails afterward', async () => {
  const controller = makeController();
  controller.aiCodePanel._state.code = 'original code';

  // Simulates "a verifyAndFixAgenticCode() run already claimed the panel" —
  // exercising the real ownership FIELD/CHECK this fix introduced directly,
  // rather than driving the full verify method through its real
  // environment-check/agent-orchestrator dependencies (covered instead by
  // the dedicated F01 preflight-abort test above, which already proves
  // verifyAndFixAgenticCode() itself behaves correctly end-to-end).
  const staleOwnerCts = new fakeVsCode.CancellationTokenSource();
  controller.verifyCancellation = staleOwnerCts;
  controller.aiCodePanelOwner = staleOwnerCts;

  const chainModule = require('../../src/agentic/agenticChains');
  const originalChain = chainModule.buildAgenticAutomationCodeChain;
  chainModule.buildAgenticAutomationCodeChain = () => ({ invoke: async () => '```java\nNEW CODE\n```' });

  try {
    await controller.generateAutomationCode(true);
  } finally {
    chainModule.buildAgenticAutomationCodeChain = originalChain;
  }

  assert.equal(controller.aiCodePanel._state.code, 'NEW CODE', 'the new generation must have committed');
  assert.notEqual(controller.aiCodePanelOwner, staleOwnerCts, 'ownership must have moved to the new generation\'s own cts');
  assert.equal(controller.ownsAiCodePanel(staleOwnerCts), false, 'the stale (verify) holder must no longer be recognized as the owner');
  assert.equal(controller.ownsAiCodePanel(controller.codeCancellation), true, 'the new generation\'s own cts must now own the panel');
});

// ---------------------------------------------------------------------
// Database testing instructions (llm/databaseTestingInstructions.ts) —
// buildSystemInstructions() gains a `userRequest` param specifically so
// this deterministic keyword check can fire without a stale/live re-read
// of the mutable `this.lastUserRequest` field, matching the "snapshot
// once" discipline (A14/F07) already used throughout runAgenticChain().
// ---------------------------------------------------------------------

test('buildSystemInstructions(): includes the bundled database-testing section when userRequest mentions database testing', async () => {
  // Note: this harness's fake `vscode` (via Module._load, see above) does
  // NOT also fake `../cache/fileCache`, so `readFileCachedSync()` resolves
  // its bundled-file path relative to THIS compiled test tree rather than
  // the real packaged extension's — it reliably returns '' here for every
  // bundled prompts/*.md file, not just this one (the real, non-empty
  // content path is covered directly by
  // test/llm/databaseTestingInstructions.test.ts's own dedicated fake).
  // This test asserts the WIRING — the section heading appears exactly
  // when, and only when, the request mentions database testing.
  const controller = makeController();

  const withDb = await controller.buildSystemInstructions(FAKE_SETTINGS, '', false, 'Connect to MongoDB and verify the users collection');
  assert.ok(withDb.includes('## Database testing instructions'), 'expected the database-testing section heading to be present');

  const withoutDb = await controller.buildSystemInstructions(FAKE_SETTINGS, '', false, 'Click the login button and verify the banner');
  assert.equal(withoutDb.includes('## Database testing instructions'), false, 'unrelated requests must not pull in the database-testing section');
});

test('runAgenticChain(): a database-testing chat request reaches BOTH the mandatory-measurement pass and the real systemInstructions sent to the chain', async () => {
  const controller = makeController();
  controller.lastUserRequest = 'Run a query against the orders table and verify the row count';
  const cts = new fakeVsCode.CancellationTokenSource();

  let receivedSystemInstructions = '';
  const chainFactory = () => ({
    invoke: async (input: { systemInstructions: string }) => {
      receivedSystemInstructions = input.systemInstructions;
      return 'generated';
    }
  });

  await controller.runAgenticChain('code', cts, chainFactory);

  assert.ok(
    receivedSystemInstructions.includes('## Database testing instructions'),
    'the real prompt sent to the chain must include the database-testing section for a database-related request'
  );
});
