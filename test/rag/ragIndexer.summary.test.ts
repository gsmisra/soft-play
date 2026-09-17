import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

/**
 * F16: an AUTOMATED regression test for `getOrBuildRagIndex()`'s
 * skip-summary reporting — the same "reviewed, not directly tested"
 * vscode-dependent file this codebase has always treated ragIndexer.ts as
 * (it needs `vscode.workspace.findFiles`/`fs`, neither of which exist
 * outside a real Extension Host), closed here using the SAME
 * `Module._load` interception technique already established for
 * ragCorpusGenerator.ts's own cancellation tests (see
 * ragCorpusGenerator.cancellation.test.ts's own top-level doc comment for
 * the full rationale) — a smaller fake here, since ragIndexer.ts only ever
 * touches `vscode` itself (no vscode-adjacent relative imports to fake).
 *
 * What this verifies: a `.github/rag/` folder that visibly contains files
 * but silently indexes NONE of them (every one failed to parse — exactly
 * the workspace-specific F16 scenario: `bdd-java-framework-guide.md`
 * starts with a heading, not YAML frontmatter) must no longer be a purely
 * invisible mismatch — `onWarn` now also receives ONE aggregate "N valid
 * recipe(s) indexed; M skipped" summary whenever at least one file was
 * skipped, in addition to its existing per-file reason messages.
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

/** In-memory fake filesystem: fsPath -> file content. Reset per test via
 * `files.clear()`. */
const files = new Map<string, string>();

/** R02 (external review, 2026-09-17): a controllable "pause" a test can
 * insert into every `readFile()` call, plus a call counter — used ONLY by
 * the epoch/race test below to deterministically hold a build mid-flight
 * while `clearRagIndexCache()` fires, then verify the cache wasn't
 * repopulated once it finishes. Defaults to an already-resolved (no-op)
 * gate and a 0 counter, reset per test, so every OTHER test here is
 * completely unaffected. */
let readFileGate: Promise<void> = Promise.resolve();
let readFileCallCount = 0;

const fakeVsCode = {
  Uri: {
    joinPath: (base: FakeUri, ...parts: string[]) => fakeUri(path.posix.join(base.path, ...parts))
  },
  RelativePattern: class {
    constructor(
      public base: unknown,
      public pattern: string
    ) {}
  },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: {
    // Ignores `base`/`pattern` entirely and just returns every registered
    // fake file — this test controls exactly what's "on disk" via `files`,
    // so a real glob implementation adds nothing a hand-picked fixture set
    // doesn't already cover.
    findFiles: async () => Array.from(files.keys()).map(fakeUri),
    fs: {
      readFile: async (u: FakeUri) => {
        await readFileGate;
        readFileCallCount++;
        if (!files.has(u.path)) {
          throw new Error(`ENOENT (fake): ${u.path}`);
        }
        return Buffer.from(files.get(u.path)!, 'utf8');
      },
      stat: async (u: FakeUri) => {
        if (!files.has(u.path)) {
          throw new Error(`ENOENT (fake): ${u.path}`);
        }
        return { mtime: 1, size: files.get(u.path)!.length, type: 1 };
      }
    }
  }
};

type GetOrBuildRagIndexFn = (
  workspaceRoot: FakeUri,
  onWarn?: (message: string) => void
) => Promise<{ recipes: unknown[] } | undefined>;

/** Installs the `Module._load` interception ONLY for the one `require()`
 * that loads ragIndexer.js, then restores the real loader immediately
 * (even if that require throws) — see this file's own top-level doc
 * comment for why this is safe and tightly scoped; identical approach to
 * ragCorpusGenerator.cancellation.test.ts's own loader. */
function loadRagIndexerWithFakeVsCode(): { getOrBuildRagIndex: GetOrBuildRagIndexFn; clearRagIndexCache: () => void } {
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
    return require('../../src/rag/ragIndexer');
  } finally {
    Module._load = originalLoad;
  }
}

const { getOrBuildRagIndex, clearRagIndexCache } = loadRagIndexerWithFakeVsCode();

const VALID_RECIPE = `---
id: postgres-query
title: Query Postgres
tags: [postgres]
automationMode: [ui, api]
language: [java]
---

Example.
\`\`\`java
Helper.queryOne();
\`\`\`
`;

test('F16: a workspace-visible file that fails to parse produces BOTH a per-file reason AND an aggregate skip-count summary', async () => {
  files.clear();
  clearRagIndexCache();
  // Mirrors the real, reproduced F16 scenario exactly: a Markdown file
  // that starts with a heading instead of YAML frontmatter.
  files.set('/fake-workspace/.github/rag/bdd-java-framework-guide.md', '# BDD Java Framework Guide\n\nSome prose, no frontmatter.\n');

  const warnings: string[] = [];
  const index = await getOrBuildRagIndex(fakeUri('/fake-workspace'), (message) => warnings.push(message));

  assert.equal(index, undefined, 'zero valid recipes must still resolve to "nothing to retrieve," never an error');
  assert.ok(
    warnings.some((w) => w.includes('bdd-java-framework-guide.md') && w.includes('Missing YAML frontmatter')),
    'the per-file reason must still be reported exactly as before'
  );
  assert.ok(
    warnings.some((w) => /Indexed 0 valid recipe\(s\); skipped 1 file\(s\)/.test(w)),
    'a visible "N valid; M skipped" summary must ALSO be reported — the F16 fix'
  );
});

test('F16: a healthy corpus with zero skips reports NO summary line at all (no noise for the common case)', async () => {
  files.clear();
  clearRagIndexCache();
  files.set('/fake-workspace/.github/rag/postgres-query.md', VALID_RECIPE);

  const warnings: string[] = [];
  const index = await getOrBuildRagIndex(fakeUri('/fake-workspace'), (message) => warnings.push(message));

  assert.ok(index, 'a fully valid corpus must still index normally');
  assert.equal(warnings.length, 0, 'onWarn must never fire at all when nothing was skipped');
});

test('F16: a MIXED corpus (some valid, some skipped) reports the correct valid/skipped counts', async () => {
  files.clear();
  clearRagIndexCache();
  files.set('/fake-workspace/.github/rag/postgres-query.md', VALID_RECIPE);
  files.set('/fake-workspace/.github/rag/another-valid.md', VALID_RECIPE.replace('postgres-query', 'another-valid'));
  files.set('/fake-workspace/.github/rag/broken.md', '# Not a recipe\n');

  const warnings: string[] = [];
  const index = await getOrBuildRagIndex(fakeUri('/fake-workspace'), (message) => warnings.push(message));

  assert.ok(index, 'the two valid recipes must still be indexed despite one broken file alongside them');
  assert.equal((index as { recipes: unknown[] }).recipes.length, 2);
  assert.ok(warnings.some((w) => /Indexed 2 valid recipe\(s\); skipped 1 file\(s\)/.test(w)));
});

test('F16: a cache HIT (nothing changed since the last real build) calls onWarn zero times, same as always', async () => {
  files.clear();
  clearRagIndexCache();
  // MUST include at least one VALID recipe — an all-skipped result (zero
  // valid recipes) deliberately clears the cache every time (see
  // ragIndexer.ts's own "if (recipes.length === 0) { cached = undefined;
  // ... }"), so that shape would never actually exercise a real cache hit
  // at all; a mixed corpus is the only shape where caching engages while
  // still having a skip to (not) re-warn about.
  files.set('/fake-workspace/.github/rag/postgres-query.md', VALID_RECIPE);
  files.set('/fake-workspace/.github/rag/broken.md', '# Not a recipe\n');

  const firstWarnings: string[] = [];
  await getOrBuildRagIndex(fakeUri('/fake-workspace'), (message) => firstWarnings.push(message));
  assert.ok(firstWarnings.length > 0, 'the first (real) build must warn as usual');

  const secondWarnings: string[] = [];
  await getOrBuildRagIndex(fakeUri('/fake-workspace'), (message) => secondWarnings.push(message));
  assert.equal(secondWarnings.length, 0, 'a cache hit re-derives nothing, so it must never re-emit warnings (including the new summary line)');
});

test('R02 (external review, 2026-09-17): an index build already in flight when clearRagIndexCache() fires cannot repopulate the cache afterward', async () => {
  files.clear();
  clearRagIndexCache();
  readFileCallCount = 0;
  files.set('/fake-workspace/.github/rag/postgres-query.md', VALID_RECIPE);

  let releaseGate: () => void = () => undefined;
  readFileGate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  // Starts a real build — it's now paused mid-flight, blocked on
  // readFileGate, exactly like "Clear Data"/"Kill All Browsers" firing
  // while a RAG index build for an in-flight generation is still reading
  // recipe files off disk.
  const inFlightBuild = getOrBuildRagIndex(fakeUri('/fake-workspace'));
  // Simulates the reset firing WHILE that build is still paused.
  clearRagIndexCache();
  // Let the paused build actually finish now.
  releaseGate();
  const inFlightResult = await inFlightBuild;

  assert.ok(inFlightResult, "the in-flight build's OWN caller still gets a real, freshly-built index — only the SHARED cache is protected, not this caller's own result");

  // A brand-new call right after must do its OWN fresh read — if the
  // now-stale in-flight build were allowed to repopulate the cache after
  // the reset, this would silently hit that stale cache entry instead
  // (nothing on disk changed, so the fingerprint would still match).
  readFileGate = Promise.resolve();
  await getOrBuildRagIndex(fakeUri('/fake-workspace'));

  assert.equal(readFileCallCount, 2, 'both the in-flight build AND the call after the reset must each have done their own real file read — a count of 1 would mean the second call wrongly served a cache the reset should have prevented from ever being (re)written');
});
