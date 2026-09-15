import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

/**
 * Efficiency fix: `vscode.lm.selectChatModels({ vendor: 'copilot' })` is a
 * real IPC round-trip to the GitHub Copilot Chat extension — before this
 * fix it was NEVER cached, so every single `sendPrompt()`/`countModelTokens()`
 * call in this file re-resolved it from scratch (unlike `countModelTokens()`'s
 * own result, already cached via `tokenCountCache`). A "Generate RAG Corpus
 * format" batch (one `sendPrompt()` per capability — see
 * ragCorpusGenerator.cancellation.test.ts's own new `tokensSoFar` tests) or
 * a live "Token Monitoring" estimate (re-run on every keystroke) repeated
 * that exact round-trip many times in quick succession for the identical
 * answer. `resolveModels()` (copilotClient.ts) now shares one short-TTL
 * cached result across BOTH `listCopilotModels()` and `findModel()`.
 *
 * Technique: the usual `Module._load` fake-`vscode` harness — faking only
 * `vscode.lm.selectChatModels` (a call-counting stub) since that's the only
 * vscode surface `resolveModels()`/`listCopilotModels()`/`findModel()`
 * touch. `TtlCache`/`tokenCountCache` are the REAL, already-tested modules
 * — not faked — so this exercises the actual cache this fix added.
 */

interface FakeModel {
  id: string;
  name: string;
  vendor: string;
  family: string;
  maxInputTokens: number;
  countTokens: () => Promise<number>;
}

function fakeModel(id: string): FakeModel {
  return { id, name: id, vendor: 'copilot', family: id, maxInputTokens: 10_000, countTokens: async () => 10 };
}

let selectChatModelsCallCount = 0;
let nextResult: (() => Promise<FakeModel[]>) | undefined;

const fakeVsCode = {
  lm: {
    selectChatModels: async () => {
      selectChatModelsCallCount++;
      if (nextResult) {
        return nextResult();
      }
      return [fakeModel('gpt-4o'), fakeModel('claude-3.5')];
    }
  }
};

function loadCopilotClientWithFakeVsCode(): {
  listCopilotModels: () => Promise<{ id: string }[]>;
  findModel: (modelId: string) => Promise<FakeModel | undefined>;
  clearModelListCache: () => void;
} {
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
    // Fresh module instance per test file run — this file's own single
    // `require` gets ONE shared cache across all tests below, same as the
    // real extension host has ONE shared cache for its whole session; each
    // test accounts for that instead of expecting isolation between tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../src/llm/copilotClient');
    return { listCopilotModels: mod.listCopilotModels, findModel: mod.findModel, clearModelListCache: mod.clearModelListCache };
  } finally {
    Module._load = originalLoad;
  }
}

const { listCopilotModels, findModel, clearModelListCache } = loadCopilotClientWithFakeVsCode();

test('findModel() called repeatedly in quick succession hits selectChatModels() only ONCE — the cache absorbs the rest', async () => {
  clearModelListCache();
  selectChatModelsCallCount = 0;
  nextResult = undefined;
  await findModel('gpt-4o');
  await findModel('claude-3.5');
  await findModel('gpt-4o');
  assert.equal(selectChatModelsCallCount, 1, 'three lookups within the TTL window must share one real resolution');
});

test('listCopilotModels() and findModel() share the SAME cached resolution — one warms it for the other', async () => {
  clearModelListCache();
  selectChatModelsCallCount = 0;
  nextResult = undefined;
  const before = selectChatModelsCallCount;
  await listCopilotModels();
  const afterFirst = selectChatModelsCallCount;
  await findModel('gpt-4o');
  const afterSecond = selectChatModelsCallCount;
  assert.equal(afterFirst, before + 1, 'the first call of either kind performs exactly one real resolution');
  assert.equal(afterSecond, afterFirst, 'the second call, of the OTHER kind, must reuse that same cached result');
});

test('findModel() still resolves the exact same model handle it always did — caching changes call volume, never the answer', async () => {
  clearModelListCache();
  selectChatModelsCallCount = 0;
  nextResult = undefined;
  const model = await findModel('claude-3.5');
  assert.equal(model?.id, 'claude-3.5');
  const fallback = await findModel('does-not-exist');
  assert.equal(fallback?.id, 'gpt-4o', 'an unknown id still falls back to the first model, exactly as before this fix');
});

test('listCopilotModels() still swallows a rejection to an empty array, exactly as before this fix', async () => {
  clearModelListCache();
  selectChatModelsCallCount = 0;
  nextResult = () => Promise.reject(new Error('Copilot Chat not installed (fake)'));
  const models = await listCopilotModels();
  assert.deepEqual(models, []);
});

test('a REJECTED resolution is never cached — the very next call gets a fresh attempt, not the same doomed promise', async () => {
  clearModelListCache();
  selectChatModelsCallCount = 0;
  nextResult = () => Promise.reject(new Error('transient (fake)'));
  await listCopilotModels(); // swallows the rejection internally
  assert.equal(selectChatModelsCallCount, 1);
  nextResult = undefined; // "recovers" — the next real call would succeed
  const models = await listCopilotModels();
  assert.equal(selectChatModelsCallCount, 2, 'a rejected lookup must not be replayed from cache — this call must actually retry');
  assert.ok(models.length > 0, 'the retry succeeds now that the underlying call recovered');
});

test('findModel() still propagates a rejection uncaught, exactly as before this fix (unlike listCopilotModels(), which swallows it)', async () => {
  clearModelListCache();
  selectChatModelsCallCount = 0;
  nextResult = () => Promise.reject(new Error('boom (fake)'));
  await assert.rejects(() => findModel('gpt-4o'), /boom \(fake\)/);
});
