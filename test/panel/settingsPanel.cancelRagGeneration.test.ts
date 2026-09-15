import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

/**
 * "End Process" (Generate RAG Corpus Format) — an integration test for the
 * NEW wiring in `SettingsPanel`: the `'cancelRagGeneration'` inbound
 * message → `handleCancelRagGeneration()` → the SAME
 * `vscode.CancellationTokenSource` already threaded into `generateRagCorpus()`
 * by `handleGenerateRagCorpus()`. The per-unit cancellation SEMANTICS
 * (skipped-vs-failed reporting, "nothing already written is touched") are
 * already covered end-to-end against the REAL `generateRagCorpus()` in
 * `test/rag/ragCorpusGenerator.cancellation.test.ts` — this file instead
 * proves the piece THAT test can't: that `SettingsPanel` actually hands
 * `generateRagCorpus()` a token which `handleCancelRagGeneration()` can
 * reach and fire, and that doing so still produces a normal, final
 * `ragGenerationDone` postMessage back to the webview (the message the
 * "End Process" button's own front-end code waits for to reset itself —
 * see settingsPanel.ts's embedded webview script).
 *
 * Technique: `Object.create(SettingsPanel.prototype)` (this codebase's own
 * established pattern — see objectSpyPanel.scenarioSwitch.test.ts) to skip
 * the real constructor (which needs a real `vscode.ExtensionContext`)
 * entirely, since neither method under test needs anything the constructor
 * sets up beyond the handful of fields set manually below. `generateRagCorpus`
 * itself is faked (not the real one) — this is deliberately an integration
 * test of the WIRING, not a second copy of the real generator's own
 * cancellation-race tests.
 */

interface FakeCts {
  token: { isCancellationRequested: boolean };
  cancel(): void;
  dispose(): void;
}

function fakeCancellationTokenSource(): FakeCts {
  const token = { isCancellationRequested: false };
  return {
    token,
    cancel: () => {
      token.isCancellationRequested = true;
    },
    dispose: () => undefined
  };
}

interface CapturedGenerateCall {
  cancellationToken: { isCancellationRequested: boolean };
}

let capturedCalls: CapturedGenerateCall[] = [];

/** Resolves once `cancellationToken.isCancellationRequested` becomes true —
 * standing in for the real `generateRagCorpus()`'s own loop, which (per its
 * own cancellation tests) keeps re-checking the token at every unit and
 * settles almost immediately once it's cancelled. Never resolves on its
 * own otherwise, so a test can assert the promise is STILL pending until
 * `handleCancelRagGeneration()` actually fires the token. */
function fakeGenerateRagCorpus(opts: CapturedGenerateCall): Promise<{ succeeded: number; skipped: number; failed: number }> {
  capturedCalls.push(opts);
  return new Promise((resolve) => {
    const check = () => {
      if (opts.cancellationToken.isCancellationRequested) {
        resolve({ succeeded: 0, skipped: 1, failed: 0 });
      } else {
        setImmediate(check);
      }
    };
    check();
  });
}

function fakeUri(p: string) {
  return { fsPath: p, path: p, scheme: 'file', toString: () => p };
}

const fakeVsCode = {
  CancellationTokenSource: class {
    private readonly inner = fakeCancellationTokenSource();
    get token() {
      return this.inner.token;
    }
    cancel() {
      this.inner.cancel();
    }
    dispose() {
      this.inner.dispose();
    }
  },
  Uri: { file: fakeUri, joinPath: (base: { path: string }, ...parts: string[]) => fakeUri(path.posix.join(base.path, ...parts)) },
  ViewColumn: { Beside: 2 },
  Disposable: class {},
  workspace: { workspaceFolders: [{ uri: fakeUri('/fake-workspace') }] },
  window: { showWarningMessage: async () => undefined }
};

function loadSettingsPanelWithFakes(): { SettingsPanel: new (...args: unknown[]) => Record<string, any> } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (id: string, parent: { filename?: string } | undefined, isMain: boolean) {
    if (id === 'vscode') {
      return fakeVsCode;
    }
    if (parent?.filename?.endsWith(path.join('panel', 'settingsPanel.js'))) {
      if (id === '../rag/ragCorpusGenerator') {
        return { generateRagCorpus: fakeGenerateRagCorpus };
      }
      // Every other relative import settingsPanel.ts makes is unreached by
      // handleGenerateRagCorpus()/handleCancelRagGeneration() — returning
      // `{}` for each is the same "not needed for this code path" posture
      // objectSpyPanel.scenarioSwitch.test.ts's own harness uses.
      if (
        id === '../settings/settingsStore' ||
        id === '../llm/copilotClient' ||
        id === '../rag/zipReader' ||
        id === '../rag/ragUploadFilters' ||
        id === '../rag/ragFreshnessService' ||
        id === '../rag/ragHybridConfig' ||
        id === '../security/secretVault'
      ) {
        return {};
      }
    }
    // eslint-disable-next-line prefer-rest-params
    return originalLoad.apply(this, arguments);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../src/panel/settingsPanel');
    return { SettingsPanel: mod.SettingsPanel };
  } finally {
    Module._load = originalLoad;
  }
}

const { SettingsPanel } = loadSettingsPanelWithFakes();

function makePanel(sentMessages: unknown[]): Record<string, any> {
  const panel = Object.create(SettingsPanel.prototype);
  panel.settingsStore = { get: () => ({ copilotEnabled: true, copilotModelId: 'fake-model' }) };
  panel.panel = { webview: { postMessage: (m: unknown) => sentMessages.push(m) } };
  panel.ragGenerationCts = undefined;
  return panel;
}

test('"End Process" cancels the SAME token generateRagCorpus() was given, and the batch still ends with a normal ragGenerationDone', async () => {
  capturedCalls = [];
  const sent: unknown[] = [];
  const panel = makePanel(sent);

  const generationPromise = panel.handleGenerateRagCorpus([{ fileName: 'Helper.java', relativePath: '', content: 'class Helper {}' }]);
  // Let the fire-and-forget generateRagCorpus() call actually start and
  // register its token before "End Process" is clicked.
  await new Promise((r) => setImmediate(r));
  assert.equal(capturedCalls.length, 1, 'generateRagCorpus() must have been called with a token by now');
  assert.equal(capturedCalls[0].cancellationToken.isCancellationRequested, false, 'must not already be cancelled before End Process is clicked');

  panel.handleCancelRagGeneration();

  await generationPromise;
  assert.equal(capturedCalls[0].cancellationToken.isCancellationRequested, true, 'handleCancelRagGeneration() must fire the exact token generateRagCorpus() received');
  const done = sent.find((m: any) => m.type === 'ragGenerationDone');
  assert.ok(done, '"End Process" must still produce a terminal ragGenerationDone message — this is what resets the webview button back to "Generate"');
  assert.deepEqual((done as any).payload, { succeeded: 0, skipped: 1, failed: 0 });
});

test('calling "End Process" with nothing running is a safe no-op', () => {
  const panel = makePanel([]);
  assert.doesNotThrow(() => panel.handleCancelRagGeneration());
});

test('a SECOND "Generate" click cancels the FIRST batch\'s token and starts a fresh one — the first batch\'s own late completion never overwrites the new batch\'s UI', async () => {
  capturedCalls = [];
  const sent: unknown[] = [];
  const panel = makePanel(sent);

  const firstPromise = panel.handleGenerateRagCorpus([{ fileName: 'First.java', relativePath: '', content: 'class First {}' }]);
  await new Promise((r) => setImmediate(r));
  const firstToken = capturedCalls[0].cancellationToken;

  // A fresh "Generate" click — NOT "End Process" — while the first batch
  // is still in flight; handleGenerateRagCorpus() itself is responsible
  // for cancelling+superseding the previous cts (this predates the "End
  // Process" feature — reconfirmed here since it shares the same
  // ragGenerationCts field "End Process" now also writes to).
  const secondPromise = panel.handleGenerateRagCorpus([{ fileName: 'Second.java', relativePath: '', content: 'class Second {}' }]);
  await new Promise((r) => setImmediate(r));

  assert.equal(firstToken.isCancellationRequested, true, 'starting a second batch must cancel the first batch\'s token');

  // Let the second (now-current) batch finish too, purely so this test
  // doesn't hang forever on fakeGenerateRagCorpus's own polling loop — not
  // itself the thing under test here.
  panel.handleCancelRagGeneration();
  await Promise.all([firstPromise, secondPromise]);

  // Only ONE ragGenerationDone should ever reach the webview for this
  // pair — the superseded first batch's own completion must be swallowed
  // by the `this.ragGenerationCts !== cts` guard, never shown as if it
  // were the second batch's result.
  const doneMessages = sent.filter((m: any) => m.type === 'ragGenerationDone');
  assert.equal(doneMessages.length, 1, 'a superseded batch must never post its own terminal message');
});
