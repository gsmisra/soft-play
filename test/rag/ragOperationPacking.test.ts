import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { packOperationCandidates, PackOptions } from '../../src/rag/ragOperationPacking';
import type { OperationRagCandidate } from '../../src/rag/ragOperationRetrieval';
import type { RagMatch } from '../../src/rag/ragRetriever';
import type { RagOperation } from '../../src/rag/ragOperationPlanner';

function makeMatch(id: string, bodyChars = 200, score = 0.9): RagMatch {
  return {
    id,
    title: `Helper ${id}`,
    body: `\`\`\`java\n${'x'.repeat(bodyChars)}\n\`\`\``,
    score,
    filePath: `/fake/.github/rag/${id}.md`
  };
}

function candidate(id: string, coveredOperationIds: string[], bodyChars = 200, score = 0.9): OperationRagCandidate {
  return { match: makeMatch(id, bodyChars, score), coveredOperationIds, bestScore: score };
}

function op(operationId: string): RagOperation {
  return { operationId, text: operationId };
}

/** A fake, deterministic token counter — roughly 1 token per 4 chars,
 * matching how the metric is USED (a stand-in for the real model
 * tokenizer, which packOperationCandidates() never calls directly — it
 * only ever calls the injected countTokens). */
function fakeCounter(charsPerToken = 4): (text: string) => Promise<number | undefined> {
  return async (text: string) => Math.ceil(text.length / charsPerToken);
}

function options(overrides: Partial<PackOptions> = {}): PackOptions {
  return {
    maxInputTokens: 100_000,
    safetyMargin: 0.9,
    mandatoryTokens: 0,
    countTokens: fakeCounter(),
    ...overrides
  };
}

test('a three-operation fixture includes all THREE necessary helpers when space permits', async () => {
  const candidates = [candidate('helper-a', ['op-0']), candidate('helper-b', ['op-1']), candidate('helper-c', ['op-2'])];
  const operations = [op('op-0'), op('op-1'), op('op-2')];
  const result = await packOperationCandidates(candidates, operations, 'java', options());
  assert.deepEqual(result.includedMatches.map((m) => m.id).sort(), ['helper-a', 'helper-b', 'helper-c']);
  assert.ok(result.diagnostics.operationCoverage.every((c) => c.covered));
});

test('a REPEATED operation (the same capability needed twice) reuses ONE contract, not two', async () => {
  const candidates = [candidate('helper-a', ['op-0', 'op-1'])]; // one candidate covering both operations
  const operations = [op('op-0'), op('op-1')];
  const result = await packOperationCandidates(candidates, operations, 'java', options());
  assert.equal(result.includedMatches.length, 1);
  assert.ok(result.diagnostics.operationCoverage.every((c) => c.covered));
});

test('a TIGHT budget omits a complete unit and shows the coverage loss honestly', async () => {
  // Each helper's body is ~200 chars. Measured directly (with these exact
  // IDs — the header line embeds the id/filename, so length depends on
  // them): 1 such recipe's full section is ~1375 chars (~344 fake tokens
  // at 4 chars/token); 2 recipes together are ~1657 chars (~415 tokens).
  // A 380-token budget fits exactly one, not both.
  const candidates = [candidate('helper-a', ['op-0'], 200), candidate('helper-b', ['op-1'], 200)];
  const operations = [op('op-0'), op('op-1')];
  const result = await packOperationCandidates(candidates, operations, 'java', options({ maxInputTokens: 380, safetyMargin: 1 }));
  assert.ok(result.includedMatches.length < 2, 'not everything should fit under a tight budget');
  const coverageLoss = result.diagnostics.operationCoverage.filter((c) => !c.covered);
  assert.ok(coverageLoss.length > 0, 'the omitted operation must show as NOT covered — coverage loss must be visible');
  // Whatever was omitted must be reported with a genuine reason, not silently dropped.
  assert.ok(result.diagnostics.omitted.length > 0);
  assert.ok(result.diagnostics.omitted.every((o) => o.reason === 'budget' || o.reason === 'duplicate'));
});

test('mandatory context already exceeding the budget produces zero RAG content, reported honestly (not an error thrown)', async () => {
  const candidates = [candidate('helper-a', ['op-0'])];
  const operations = [op('op-0')];
  const result = await packOperationCandidates(candidates, operations, 'java', options({ maxInputTokens: 100, safetyMargin: 0.9, mandatoryTokens: 200 }));
  assert.equal(result.section, '');
  assert.deepEqual(result.includedMatches, []);
  assert.ok(result.diagnostics.operationCoverage.every((c) => !c.covered));
  assert.equal(result.diagnostics.omitted.length, 1);
});

test('all measured final requests fit within the given budget — the packed section never exceeds it', async () => {
  const candidates = Array.from({ length: 5 }, (_, i) => candidate(`helper-${i}`, [`op-${i}`], 300, 0.9 - i * 0.01));
  const operations = Array.from({ length: 5 }, (_, i) => op(`op-${i}`));
  const budgetTokens = 100;
  const result = await packOperationCandidates(candidates, operations, 'java', options({ maxInputTokens: budgetTokens, safetyMargin: 1 }));
  assert.ok(result.diagnostics.countedTokens !== undefined);
  assert.ok(result.diagnostics.countedTokens! <= budgetTokens, `packed section (${result.diagnostics.countedTokens} tokens) must fit the ${budgetTokens}-token budget`);
});

test('when counting is unavailable, the unmeasured policy is followed and clearly reported, never claimed token-safe', async () => {
  const candidates = [candidate('helper-a', ['op-0'])];
  const operations = [op('op-0')];
  const unavailableCounter = async () => undefined;
  const result = await packOperationCandidates(candidates, operations, 'java', options({ countTokens: unavailableCounter }));
  assert.equal(result.diagnostics.tokensUnmeasured, true);
  assert.equal(result.diagnostics.countedTokens, undefined);
  // Still produces a best-effort section via formatRagPromptSection()'s own char cap.
  assert.ok(result.section.length > 0);
});

test('a candidate covering ONLY an already-covered operation is reported as "duplicate", not "budget"', async () => {
  // Measured directly with these exact IDs: 1 recipe (100-char body) ->
  // ~1584 chars (~396 tokens); 2 such recipes together -> ~1790 chars
  // (~448 tokens). A 420-token budget fits exactly one, forcing the
  // lower-scored, same-operation "redundant" one to be dropped.
  const candidates = [
    candidate('helper-primary', ['op-0'], 100, 0.9),
    candidate('helper-redundant', ['op-0'], 100, 0.5) // same operation, lower score — genuinely redundant
  ];
  const operations = [op('op-0')];
  const result = await packOperationCandidates(candidates, operations, 'java', options({ maxInputTokens: 420, safetyMargin: 1 }));
  assert.deepEqual(result.includedMatches.map((m) => m.id), ['helper-primary']);
  const redundantOmission = result.diagnostics.omitted.find((o) => o.id === 'helper-redundant');
  assert.ok(redundantOmission, 'helper-redundant must be omitted under this budget');
  assert.equal(redundantOmission!.reason, 'duplicate');
});

test('coverage-first ordering: an uncovered operation is prioritized over a redundant extra for an already-covered one', async () => {
  // Measured directly with these exact IDs: 3 recipes (100-char bodies)
  // -> ~1972 chars (~493 tokens); the 2 that survive dropping the last
  // (redundant, keeping primary+b) -> ~1766 chars (~442 tokens). A
  // 460-token budget fits exactly those 2, not all 3.
  const candidates = [
    candidate('helper-redundant', ['op-0'], 100, 0.95), // highest score, but op-0 gets covered either way
    candidate('helper-primary', ['op-0'], 100, 0.9),
    candidate('helper-b', ['op-1'], 100, 0.5) // lower score, but the ONLY thing covering op-1
  ];
  const operations = [op('op-0'), op('op-1')];
  const result = await packOperationCandidates(candidates, operations, 'java', options({ maxInputTokens: 460, safetyMargin: 1 }));
  const includedIds = result.includedMatches.map((m) => m.id);
  assert.ok(includedIds.includes('helper-b'), 'the only candidate covering op-1 should be prioritized over a redundant op-0 duplicate');
  assert.equal(includedIds.length, 2, 'exactly 2 of the 3 should fit under this budget');
});

test('deterministic tie-breaking: equal-priority candidates always order the same way regardless of input order', async () => {
  // Both cover a DIFFERENT, not-yet-covered operation with the SAME score
  // — a genuine tie broken only by capability ID. Measured directly with
  // these exact IDs: 1 recipe (100-char body) -> ~1566 chars (~392
  // tokens); both together -> ~1748 chars (~437 tokens). A 410-token
  // budget fits exactly one, so which one gets kept must be deterministic
  // either way.
  const a = candidate('helper-a', ['op-0'], 100, 0.9);
  const b = candidate('helper-b', ['op-1'], 100, 0.9);
  const operations = [op('op-0'), op('op-1')];
  const resultForward = await packOperationCandidates([a, b], operations, 'java', options({ maxInputTokens: 410, safetyMargin: 1 }));
  const resultReversed = await packOperationCandidates([b, a], operations, 'java', options({ maxInputTokens: 410, safetyMargin: 1 }));
  assert.equal(resultForward.includedMatches.length, 1, 'only one of the two should fit under this budget');
  assert.deepEqual(
    resultForward.includedMatches.map((m) => m.id),
    resultReversed.includedMatches.map((m) => m.id)
  );
});

test('zero candidates produces an empty section with full coverage loss, without throwing', async () => {
  const operations = [op('op-0'), op('op-1')];
  const result = await packOperationCandidates([], operations, 'java', options());
  assert.equal(result.section, '');
  assert.deepEqual(result.includedMatches, []);
  assert.ok(result.diagnostics.operationCoverage.every((c) => !c.covered));
});

// --- F11: a smaller, lower-priority candidate is never blocked out entirely by a larger higher-priority one that doesn't fit ---

test('a small candidate that fits alone is still included even though a larger, higher-priority candidate does not fit at all (the reproduced F11 bug)', async () => {
  // Measured directly: helper-big (1200-char body) alone -> 2381 chars
  // (~596 tokens); helper-small (50-char body) alone -> 1237 chars (~310
  // tokens); both together -> 2525 chars (~632 tokens). A 400-token
  // budget: small fits alone, big does NOT fit alone, and the OLD
  // "start with everything, drop the lowest-priority (small) from the
  // tail first" algorithm would then be left with just [big] (still too
  // big), drop it too, and return NOTHING — even though helper-small on
  // its own fits comfortably.
  const bigCandidate = candidate('helper-big', ['op-0'], 1200, 0.9); // higher score -> higher priority, ordered first
  const smallCandidate = candidate('helper-small', ['op-1'], 50, 0.5); // lower score, but the ONLY thing covering op-1
  const operations = [op('op-0'), op('op-1')];
  const result = await packOperationCandidates([bigCandidate, smallCandidate], operations, 'java', options({ maxInputTokens: 400, safetyMargin: 1 }));
  assert.deepEqual(
    result.includedMatches.map((m) => m.id),
    ['helper-small']
  );
});

test('the oversized candidate skipped by F11\'s fix is still reported in diagnostics with reason "budget", not silently dropped', async () => {
  const bigCandidate = candidate('helper-big', ['op-0'], 1200, 0.9);
  const smallCandidate = candidate('helper-small', ['op-1'], 50, 0.5);
  const operations = [op('op-0'), op('op-1')];
  const result = await packOperationCandidates([bigCandidate, smallCandidate], operations, 'java', options({ maxInputTokens: 400, safetyMargin: 1 }));
  const bigOmission = result.diagnostics.omitted.find((o) => o.id === 'helper-big');
  assert.ok(bigOmission, 'the oversized candidate must still appear in diagnostics');
  assert.equal(bigOmission!.reason, 'budget');
  assert.equal(result.diagnostics.operationCoverage.find((c) => c.operationId === 'op-0')!.covered, false, 'op-0 is honestly reported as NOT covered — helper-small never claimed to cover it');
});

test('the SAME small-fits-despite-large-not-fitting result holds regardless of which candidate is listed first (order-independence)', async () => {
  const bigCandidate = candidate('helper-big', ['op-0'], 1200, 0.9);
  const smallCandidate = candidate('helper-small', ['op-1'], 50, 0.5);
  const operations = [op('op-0'), op('op-1')];
  const forward = await packOperationCandidates([bigCandidate, smallCandidate], operations, 'java', options({ maxInputTokens: 400, safetyMargin: 1 }));
  const reversed = await packOperationCandidates([smallCandidate, bigCandidate], operations, 'java', options({ maxInputTokens: 400, safetyMargin: 1 }));
  assert.deepEqual(forward.includedMatches.map((m) => m.id).sort(), reversed.includedMatches.map((m) => m.id).sort());
});

// --- F08: a stale/missing recipe is hard-excluded from packing ---------------

test('a candidate whose filePath is in staleFilePaths is EXCLUDED from packing entirely, reported with reason "stale"', async () => {
  const freshCandidate = candidate('helper-fresh', ['op-0']);
  const staleCandidate = candidate('helper-stale', ['op-1']);
  const operations = [op('op-0'), op('op-1')];
  const result = await packOperationCandidates([freshCandidate, staleCandidate], operations, 'java', options({ staleFilePaths: new Set([staleCandidate.match.filePath]) }));
  assert.ok(!result.includedMatches.some((m) => m.id === 'helper-stale'));
  assert.ok(result.includedMatches.some((m) => m.id === 'helper-fresh'));
  const staleOmission = result.diagnostics.omitted.find((o) => o.id === 'helper-stale');
  assert.ok(staleOmission);
  assert.equal(staleOmission!.reason, 'stale');
});

test('excluding a stale candidate never consumes any of the token budget it would have used', async () => {
  // The stale candidate is deliberately the ONLY thing that (lexically)
  // covers op-1 — if it were merely deprioritized rather than genuinely
  // excluded, a large-enough budget would still include it. It never
  // should, regardless of budget.
  const staleCandidate = candidate('helper-stale', ['op-1'], 100, 0.99);
  const operations = [op('op-0'), op('op-1')];
  const result = await packOperationCandidates([staleCandidate], operations, 'java', options({ staleFilePaths: new Set([staleCandidate.match.filePath]), maxInputTokens: 100_000, safetyMargin: 1 }));
  assert.deepEqual(result.includedMatches, []);
  assert.equal(result.diagnostics.operationCoverage.find((c) => c.operationId === 'op-1')!.covered, false);
});

test('with NO staleFilePaths given, behavior is unchanged from before F08 (backward compatible default)', async () => {
  const candidates = [candidate('helper-a', ['op-0']), candidate('helper-b', ['op-1'])];
  const operations = [op('op-0'), op('op-1')];
  const result = await packOperationCandidates(candidates, operations, 'java', options());
  assert.deepEqual(result.includedMatches.map((m) => m.id).sort(), ['helper-a', 'helper-b']);
});

test('diagnostics always list every retrieved ID, whether included or omitted', async () => {
  const candidates = [candidate('helper-a', ['op-0'], 100, 0.9), candidate('helper-b', ['op-1'], 100, 0.5)];
  const operations = [op('op-0'), op('op-1')];
  const result = await packOperationCandidates(candidates, operations, 'java', options({ maxInputTokens: 30, safetyMargin: 1 }));
  const allAccountedFor = new Set([...result.diagnostics.includedIds, ...result.diagnostics.omitted.map((o) => o.id)]);
  assert.deepEqual([...allAccountedFor].sort(), result.diagnostics.retrievedIds.sort());
});
