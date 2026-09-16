import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { hasObservedCallEvidence, prependRagTraceabilityBanner } from '../../src/panel/ragTraceabilityBanner';
import type { RagMatch } from '../../src/rag/ragRetriever';

function makeMatch(overrides: Partial<RagMatch> = {}): RagMatch {
  return {
    id: 'postgres-helper',
    title: 'Query Postgres and validate a value',
    body: 'body',
    imports: { java: ['com.acme.testutil.PostgresHelper'] },
    score: 0.9,
    filePath: '/workspace/.github/rag/database/postgres-helper.md',
    ...overrides
  };
}

const relativePathOf = (p: string) => p.replace('/workspace/', '');

// --- hasObservedCallEvidence ------------------------------------------------

test('detects use via the explicit "RAG match: <id>" traceability comment', () => {
  const match = makeMatch({ id: 'my-helper', imports: undefined });
  const code = '// RAG match: my-helper (from helper.md)\nvar x = 1;';
  assert.equal(hasObservedCallEvidence(code, match, 'java'), true);
});

test('detects use via an actual import symbol appearing in the code, even with no comment', () => {
  const match = makeMatch({ imports: { java: ['com.acme.testutil.PostgresHelper'] } });
  const code = 'import com.acme.testutil.PostgresHelper;\nPostgresHelper.queryOne(conn, sql);';
  assert.equal(hasObservedCallEvidence(code, match, 'java'), true);
});

test('returns false when neither the comment nor any import symbol appears', () => {
  const match = makeMatch({ imports: { java: ['com.acme.testutil.PostgresHelper'] } });
  const code = 'var x = 1; // nothing to do with this helper';
  assert.equal(hasObservedCallEvidence(code, match, 'java'), false);
});

test('checks imports for the CORRECT language only', () => {
  const match = makeMatch({ imports: { python: ['testutil.postgres_helper'] } });
  const code = 'import testutil.postgres_helper';
  assert.equal(hasObservedCallEvidence(code, match, 'java'), false);
  assert.equal(hasObservedCallEvidence(code, match, 'python'), true);
});

test('a match with no imports at all and no comment is never falsely detected as used', () => {
  const match = makeMatch({ imports: undefined });
  const code = 'var x = 1;';
  assert.equal(hasObservedCallEvidence(code, match, 'java'), false);
});

// --- prependRagTraceabilityBanner ------------------------------------------

test('a no-op (code unchanged, empty observedMatches) when there are zero matches to begin with', () => {
  const result = prependRagTraceabilityBanner('var x = 1;', [], 'java', relativePathOf);
  assert.equal(result.code, 'var x = 1;');
  assert.deepEqual(result.observedMatches, []);
});

test('a match with observed call evidence is listed in the banner, honestly labeled OBSERVED not "used"/"verified"', () => {
  const match = makeMatch({ id: 'postgres-helper', imports: { java: ['com.acme.testutil.PostgresHelper'] } });
  const code = 'import com.acme.testutil.PostgresHelper;\nPostgresHelper.queryOne(conn, sql);';
  const result = prependRagTraceabilityBanner(code, [match], 'java', relativePathOf);
  assert.match(result.code, /OBSERVED \(heuristic, not verified\)/);
  assert.doesNotMatch(result.code, /actually used/i);
  assert.match(result.code, /postgres-helper/);
  assert.match(result.code, /database\/postgres-helper\.md/);
  assert.deepEqual(result.observedMatches, [match]);
  // Original code is still present, untouched, after the banner.
  assert.match(result.code, /PostgresHelper\.queryOne/);
});

test('a match included in the prompt but with NO observed call evidence is honestly reported as such, never claimed used', () => {
  const match = makeMatch({ id: 'unused-helper', imports: { java: ['com.acme.testutil.UnusedHelper'] } });
  const code = 'var x = 1; // this code never touches the helper at all';
  const result = prependRagTraceabilityBanner(code, [match], 'java', relativePathOf);
  assert.doesNotMatch(result.code, /RAG-matched reusable component/); // no banner header — nothing showed observed evidence
  assert.match(result.code, /no call evidence was observed/);
  assert.doesNotMatch(result.code, /actually used/i);
  assert.deepEqual(result.observedMatches, []);
});

test('a mix of observed and unobserved matches: only the observed one is listed, with an honest count of the rest', () => {
  const used = makeMatch({ id: 'used-helper', imports: { java: ['com.acme.testutil.UsedHelper'] } });
  const unused = makeMatch({ id: 'unused-helper', imports: { java: ['com.acme.testutil.UnusedHelper'] } });
  const code = 'import com.acme.testutil.UsedHelper;\nUsedHelper.call();';
  const result = prependRagTraceabilityBanner(code, [used, unused], 'java', relativePathOf);
  assert.match(result.code, /used-helper/);
  assert.doesNotMatch(result.code, /unused-helper/);
  assert.match(result.code, /1 additional component\(s\) were offered but showed no observed call evidence/);
  assert.deepEqual(result.observedMatches, [used]);
});

test('uses "#" comment syntax for python, "//" for java', () => {
  const match = makeMatch({ id: 'a', imports: { python: ['testutil.a'] } });
  const code = 'import testutil.a\ntestutil.a.call()';
  const result = prependRagTraceabilityBanner(code, [match], 'python', relativePathOf);
  assert.match(result.code, /^#/);
  assert.doesNotMatch(result.code.split('\n')[0], /^\/\//);
});

// --- import-alignment caveat (comment present, but the recipe's own
// declared import string never independently found in the code) ---------

test('a match used per its traceability comment WITH its own import also present gets no import caveat', () => {
  const match = makeMatch({ id: 'postgres-helper', imports: { java: ['com.acme.testutil.PostgresHelper'] } });
  const code = '// RAG match: postgres-helper (from postgres-helper.md)\nimport com.acme.testutil.PostgresHelper;\nPostgresHelper.queryOne(conn, sql);';
  const result = prependRagTraceabilityBanner(code, [match], 'java', relativePathOf);
  assert.doesNotMatch(result.code, /double-check the import\/package path/);
});

test('a match used per its traceability comment WITHOUT its own import present anywhere gets an explicit import-mismatch caveat', () => {
  const match = makeMatch({ id: 'postgres-helper', imports: { java: ['com.acme.testutil.PostgresHelper'] } });
  // The model added the traceability comment, and calls something plausibly
  // named the same, but the recipe's OWN fully-qualified import string is
  // nowhere in this file — exactly the case the user reported: the model
  // used the component conceptually but didn't align the import path.
  const code = '// RAG match: postgres-helper (from postgres-helper.md)\nimport com.other.pkg.PostgresHelper;\nPostgresHelper.queryOne(conn, sql);';
  const result = prependRagTraceabilityBanner(code, [match], 'java', relativePathOf);
  assert.match(result.code, /postgres-helper.*double-check the import\/package path actually matches/);
  // Still correctly counted as observed — this is a caveat, not a
  // demotion back to "no evidence".
  assert.deepEqual(result.observedMatches, [match]);
});

test('a match with no declared imports for this language at all never gets a spurious import caveat', () => {
  const match = makeMatch({ id: 'config-helper', imports: undefined });
  const code = '// RAG match: config-helper (from config-helper.md)\nvar x = ConfigHelper.get();';
  const result = prependRagTraceabilityBanner(code, [match], 'java', relativePathOf);
  assert.doesNotMatch(result.code, /double-check the import\/package path/);
});

test('a match used via import-symbol evidence alone (no comment at all) never gets the comment-only caveat', () => {
  const match = makeMatch({ id: 'postgres-helper', imports: { java: ['com.acme.testutil.PostgresHelper'] } });
  const code = 'import com.acme.testutil.PostgresHelper;\nPostgresHelper.queryOne(conn, sql);';
  const result = prependRagTraceabilityBanner(code, [match], 'java', relativePathOf);
  assert.doesNotMatch(result.code, /double-check the import\/package path/);
});
