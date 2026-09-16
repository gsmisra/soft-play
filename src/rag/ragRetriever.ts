import * as path from 'path';
import type { RagIndex, RagRecipeMetadata } from './ragIndexBuilder';
import type { RagAutomationMode, RagLanguage } from './ragTypes';
import { applyRelevanceGate, DEFAULT_RELEVANCE_GATE, GateCandidate, RelevanceGateConfig } from './ragRelevanceGate';
import { TfIdfEmbeddings } from './tfidfEmbeddings';

/**
 * Turns a built `RagIndex` (ragIndexBuilder.ts) plus a query into the
 * prompt section `buildLlmPrompt()`/`buildApiLlmPrompt()` (objectSpyPanel.ts)
 * inject before sending a "Start AI Code Generation" request. Zero `vscode`
 * dependency — fully unit-testable with a hand-built index.
 */

export interface RagMatch {
  id: string;
  title: string;
  body: string;
  imports?: { java?: string[]; python?: string[] };
  /** TF-IDF cosine similarity (automationMode penalty already applied) for
   * a match returned by `retrieveRagMatches()` — but see
   * rag/ragHybridRetriever.ts's `retrieveHybridMatches()`, whose returned
   * matches carry a Reciprocal-Rank-Fusion score in this SAME field
   * instead, on a completely different, non-comparable scale. Never
   * compare or threshold this field the same way across matches that might
   * have come from either function without first checking which one
   * produced them. */
  score: number;
  /** The recipe's own source `.md` file's absolute path — carried through
   * so a caller (objectSpyPanel.ts) can point a user at EXACTLY which
   * `.github/rag/` file a piece of generated code was traced back to. Kept
   * as the raw absolute path here (this module has no `vscode` import to
   * compute a workspace-relative one); `formatRagPromptSection()` below
   * only ever shows the plain filename (`path.basename`), never the full
   * local path, in text that's sent to the LLM. */
  filePath: string;
}

/** `automationMode` is a soft ranking signal, not a hard requirement — see
 * `retrieveRagMatches()`'s own doc comment for why. A mode-mismatched
 * recipe's score is scaled down by this factor rather than zeroed out, so
 * it still loses to an equally-relevant, correctly-moded recipe, but can
 * still surface when its actual content relevance (folder name, filename,
 * title, tags, body) is strong enough to outweigh the penalty — exactly
 * the case a bulk-imported real framework needs: a shared utility a
 * per-file, no-context LLM guess mis-tagged as "api-only" is still findable
 * from a UI Automation scenario that clearly needs it. */
export const AUTOMATION_MODE_MISMATCH_PENALTY = 0.4;

/** Multiplicative score boost (see `AUTOMATION_MODE_MISMATCH_PENALTY` above
 * for the same "ranking signal, never a hard filter/override" posture) for
 * a candidate whose own folder/filename (`RagRecipeMetadata.relativePath`)
 * literally contains a meaningful keyword from the query, as a plain
 * substring — see `matchesPathOrFilename()`'s own doc comment for exactly
 * why this needs to be a SEPARATE, deterministic check rather than relying
 * only on `relativePath` already being folded into the TF-IDF embedding
 * text (`ragTypes.ts`'s `recipeToEmbeddingText()`, weighted 2x there): that
 * embedding only ever matches whole VOCABULARY TERMS the tokenizer actually
 * produced, so a query keyword that's merely a substring of a longer,
 * unsplittable fused path/filename token (e.g. "autosys" inside the single
 * all-lowercase token "autosysjobmonitor", which has no case-change or
 * underscore boundary for `tfidfEmbeddings.ts`'s own identifier-splitter to
 * find) never becomes a shared vocabulary term at all, and so contributes
 * nothing to the cosine score no matter how obviously relevant the file
 * actually is. 1.5x is deliberately modest, not an automatic top rank — a
 * path/filename hit still has to coexist with (and can still lose to) a
 * genuinely more content-relevant recipe on real substance; it exists to
 * reliably tip an otherwise-plausible, currently-under-scored path match
 * over the relevance gate and into the returned top-`topK`, not to override
 * ranking outright. */
export const PATH_FILENAME_MATCH_BOOST = 1.5;

/** Minimum keyword length counted for the path/filename substring check —
 * same value and same rationale as `ragRelevanceGate.ts`'s own
 * `MIN_SYMBOL_TOKEN_LENGTH`: short common words (e.g. "run", "the", "for")
 * routinely appear as accidental substrings of unrelated path segments and
 * carry too little signal on their own to justify a boost. */
const MIN_PATH_MATCH_KEYWORD_LENGTH = 4;

/** The meaningful keywords from a free-text query, for the path/filename
 * substring check below — reuses `TfIdfEmbeddings.tokenize()` (the exact
 * same lowercasing/word-boundary rules already used to build the query's
 * own embedding) rather than a separate ad hoc splitter, so this check's
 * notion of "a word in the query" never drifts from the tokenizer's. */
function queryKeywordsForPathMatch(queryText: string): string[] {
  return Array.from(new Set(TfIdfEmbeddings.tokenize(queryText).filter((token) => token.length >= MIN_PATH_MATCH_KEYWORD_LENGTH)));
}

/** True when ANY meaningful query keyword (see `queryKeywordsForPathMatch()`)
 * appears as a literal, case-insensitive SUBSTRING anywhere in
 * `relativePath` — every folder segment AND the filename itself, e.g. a
 * query mentioning "autosys" matches
 * "src/main/java/com/framework/autosys/autosysjobmonitor-execute.md" both
 * via the standalone "autosys" folder segment (which the ordinary TF-IDF
 * vocabulary match already finds on its own) AND via the concatenated
 * filename stem "autosysjobmonitor" (which it cannot — see
 * `PATH_FILENAME_MATCH_BOOST`'s own doc comment for why). Deliberately a
 * plain substring test, not a re-tokenization of the path — the entire
 * point is to catch exactly the fused-compound-word case a tokenizer-based
 * comparison would still miss. */
function matchesPathOrFilename(relativePath: string | undefined, queryKeywords: string[]): boolean {
  if (!relativePath || queryKeywords.length === 0) {
    return false;
  }
  const lowerPath = relativePath.toLowerCase();
  return queryKeywords.some((keyword) => lowerPath.includes(keyword));
}

/** How many raw candidates to pull from the vector store (filtered by
 * `language` only) BEFORE applying the automationMode-aware re-ranking —
 * ALL of them, i.e. `index.store.size` (never a fixed cap): every
 * language-compatible recipe needs a real chance to be compared post-
 * penalty, not just whichever ones happened to rank in the raw (pre-
 * penalty) top few. A fixed cap here (this used to be a flat 20) silently
 * reintroduces the same "the RAG clearly has the right file but never uses
 * it" failure the automationMode soft-penalty above exists to prevent —
 * once a corpus grows past the cap, a correctly-moded, highly-relevant
 * recipe ranked just outside it (by raw, un-penalized score) can never
 * even be CONSIDERED for the post-penalty rerank, let alone win it,
 * regardless of how much better its adjusted score would have been.
 * Genuinely free to do for every recipe — this store is an exact linear
 * scan over a realistically dozens-to-a-few-hundred-recipe corpus (see
 * flatVectorStore.ts's own doc comment), not an approximate index with a
 * real cost curve that a cap would meaningfully protect. */
function candidatePoolSize(index: RagIndex): number {
  return index.store.size;
}

/** Retrieves the top `topK` recipes relevant to `queryText`.
 *
 * `language` is a HARD filter — a Python-only recipe is never shown when
 * generating Java, even if its text scores well, since the resulting code
 * would be genuinely unusable (wrong syntax, an import that doesn't
 * exist), not just a worse suggestion.
 *
 * `automationMode`, by contrast, is a SOFT preference (see
 * `AUTOMATION_MODE_MISMATCH_PENALTY`) — it used to be a hard filter too,
 * but that meant a recipe generated by "Generate RAG Corpus format" (an
 * LLM guessing `automationMode` for ONE file at a time, with no knowledge
 * of how it'll later be searched) that got tagged e.g. `api`-only could
 * never surface for a UI Automation scenario even when its folder name,
 * filename, and content were an obvious, strong match — the exact "RAG
 * clearly has the right file, but never uses it" failure this exists to
 * prevent.
 *
 * RANKING (TF-IDF scoring + the automationMode penalty above) is
 * deliberately separate from ACCEPTANCE (Phase 4's `ragRelevanceGate.ts`
 * — whether a ranked candidate clears the bar to be returned at all): this
 * function computes and sorts scores, then hands the ranked list to
 * `applyRelevanceGate()` to decide inclusion, rather than baking an
 * acceptance rule directly into this function's own filter. `gateConfig`
 * defaults to `DEFAULT_RELEVANCE_GATE`, which reproduces this function's
 * OLD behavior byte-for-byte (any positive score accepted) — see that
 * default's own doc comment for why it stays conservative until real
 * evidence justifies a different production default.
 *
 * `staleFilePaths` (A08) is applied BEFORE the `topK` slice, not after —
 * the fix for a real reproduced gap: a caller (agenticModeController.ts,
 * objectSpyPanel.ts) used to retrieve `topK` matches FIRST and only THEN
 * discard whichever of those happened to be `stale`/`missing`, so a
 * genuinely fresh, usable recipe ranked just outside the `topK` window
 * (e.g. 4th, with `topK` 3) was never even RETRIEVED in the first place —
 * no amount of later filtering can recover a candidate retrieval already
 * dropped. Filtering here, before the slice, means the eligible candidate
 * takes the ineligible one's PLACE in the returned top-`topK` instead of
 * the result silently shrinking (or, in the reproduced case, becoming
 * empty even though a fresh, indexed helper genuinely exists). Optional;
 * omitting it (or passing an empty set) excludes nothing — today's exact
 * prior behavior, and the correct behavior for any caller with no
 * freshness data to apply (a benchmark/calibration run against synthetic
 * fixtures, a hand-authored-only corpus with nothing to ever mark stale,
 * ...). */
export async function retrieveRagMatches(
  index: RagIndex,
  queryText: string,
  language: RagLanguage,
  automationMode: RagAutomationMode,
  // Lowered from 3 to 2 — automationMode moving from a hard filter to a
  // soft preference means a query now legitimately matches MORE recipes
  // than before (mode mismatches no longer disqualify a recipe outright),
  // so the same topK now injects more total content into the prompt on
  // average than it used to. Fewer, higher-scoring components is a safer
  // default against a real provider failure mode this extension has hit in
  // practice — see runLlmRefinement()'s own retry-without-RAG fallback and
  // RAG_MAX_RECIPE_BODY_CHARS below, both hardening the SAME risk from a
  // different angle.
  topK = 2,
  gateConfig: RelevanceGateConfig = DEFAULT_RELEVANCE_GATE,
  staleFilePaths?: ReadonlySet<string>
): Promise<RagMatch[]> {
  if (!queryText.trim()) {
    return [];
  }
  const queryVector = await index.embeddings.embedQuery(queryText);
  const candidates = await index.store.similaritySearchVectorWithScore(queryVector, candidatePoolSize(index), { language });
  const pathMatchKeywords = queryKeywordsForPathMatch(queryText);
  const ranked: GateCandidate[] = candidates
    .map(([doc, rawScore]) => {
      const metadata = doc.metadata as RagRecipeMetadata;
      const modeMatches = (metadata.automationMode as string[]).includes(automationMode);
      let score = modeMatches ? rawScore : rawScore * AUTOMATION_MODE_MISMATCH_PENALTY;
      if (matchesPathOrFilename(metadata.relativePath, pathMatchKeywords)) {
        score *= PATH_FILENAME_MATCH_BOOST;
      }
      const match: RagMatch = { id: metadata.id, title: metadata.title, body: doc.pageContent, imports: metadata.imports, score, filePath: metadata.filePath };
      return { match, score, modeMatches };
    })
    .filter((candidate) => !staleFilePaths?.has(candidate.match.filePath))
    .sort((a, b) => b.score - a.score);
  return applyRelevanceGate(ranked, queryText, gateConfig)
    .filter((decision) => decision.accepted)
    .map((decision) => decision.match)
    .slice(0, topK);
}

/** Hard safety net on a SINGLE recipe body's contribution to the prompt —
 * "Generate RAG Corpus format" (ragCorpusGenerator.ts) accepts source
 * files up to 200KB and asks Copilot to write a recipe from one, with no
 * cap on how much of that the model echoes back into the body it returns.
 * Without this, one unusually verbose auto-generated recipe (or a
 * hand-written one someone pasted a large class into) can silently make
 * "Start AI Code Generation"'s ALREADY sizeable prompt (built-in
 * instructions + every checked custom .md file + the full recorded/API
 * code) too large for the model — while "Start AI Feature File
 * Generation", which never includes RAG content at all, keeps working
 * fine with the exact same recipe library, misleadingly looking like "RAG
 * itself is broken" when the real cause is one oversized recipe tipping a
 * request that was already close to the model's own context limit.
 * Lowered from 4,000 to 1,500 for the same reason `topK` was lowered above
 * — automationMode is now a soft preference rather than a hard filter, so
 * a real request measurably injects RAG content more often than it used
 * to; a smaller per-recipe ceiling keeps the WORST case bounded even
 * against that. */
export const RAG_MAX_RECIPE_BODY_CHARS = 1_500;

/** A second, TOTAL cap across every matched recipe combined — belt and
 * suspenders on top of the per-recipe cap above. `topK * RAG_MAX_RECIPE_BODY_CHARS`
 * bounds the worst case mathematically, but this catches it explicitly
 * too rather than relying on that arithmetic staying true if either
 * constant is tuned again later without updating the other. */
export const RAG_MAX_TOTAL_SECTION_CHARS = 4_000;

const RECIPE_TRUNCATION_NOTICE = "\n… (truncated — this recipe's body is unusually large; consider trimming it in .github/rag/)";

/** The recipe-contract field labels this format's own generation template
 * (prompts/generate-rag-recipe.md) always emits as ONE-LINE fields BEFORE
 * the fenced example — "Use:", "Requires:", and "API:" ARE the calling
 * contract itself (what to call, under what preconditions, with what
 * exact signature), not decorative description. `packRecipeBody()`
 * previously treated ALL prose surrounding the fenced code as equally
 * disposable, so a body whose prose (including these fields) ran long
 * could have "Requires:"/"API:" silently shortened or dropped entirely —
 * exactly the "preserve calling contracts, not merely code fences"
 * failure this fix (F10) closes. Matched case-sensitively, anchored to
 * the start of a line, against the EXACT labels the template emits; a
 * hand-authored recipe using different wording for its own prose simply
 * doesn't match, and falls back to being treated as ordinary trimmable
 * text, same as before this fix — this is a targeted protection for the
 * known template shape, not a general-purpose structured-field parser. */
const PROTECTED_CONTRACT_LINE_PATTERN = /^(?:Use|Requires|API):/m;

/** Splits a recipe body into the CODE-BEARING "core" (from its first fenced
 * code block's opening ``` through its last one's closing ```) plus the
 * prose immediately before/after it. `packRecipeBody()` below only ever
 * shortens the prose parts — the fix for truncation that used to slice
 * straight through a fence (and, once the body was cut off mid-example,
 * often through the "Required imports" section appended after it too,
 * since that used the SAME blind whole-string slice). A recipe with no
 * fenced code block at all has no "core" to protect — this returns
 * `undefined` and the whole body is treated as ordinary trimmable prose,
 * same as before this fix. */
function splitRecipeBody(body: string): { leadingProse: string; core: string; trailingProse: string } | undefined {
  const fenceMatches = Array.from(body.matchAll(/```[^\n]*\n[\s\S]*?```/g));
  if (fenceMatches.length === 0) {
    return undefined;
  }
  const first = fenceMatches[0];
  const last = fenceMatches[fenceMatches.length - 1];
  const coreStart = first.index!;
  const coreEnd = last.index! + last[0].length;
  return {
    leadingProse: body.slice(0, coreStart).trimEnd(),
    core: body.slice(coreStart, coreEnd),
    trailingProse: body.slice(coreEnd).trimStart()
  };
}

/** Fits one prose block (leading or trailing) into `remaining` chars.
 * WHOLE-BLOCK protection (F10): if `prose` contains any recognized
 * contract field label at all, it is NEVER partially shortened — either
 * it fits in full, or (for `allowDrop`) it's dropped in full, or (when
 * dropping isn't allowed either — the leading block, which is where
 * "Use:"/"Requires:"/"API:" actually live) this returns `undefined` to
 * tell the caller the WHOLE recipe must be omitted rather than publish a
 * truncated contract. Ordinary (non-contract) prose keeps the OLD
 * ellipsis-truncation behavior, unchanged. */
function fitProseBlock(prose: string, remaining: number, allowDrop: boolean): string | undefined {
  if (prose.length === 0) {
    return '';
  }
  if (remaining <= 1) {
    return allowDrop || !PROTECTED_CONTRACT_LINE_PATTERN.test(prose) ? '' : undefined;
  }
  if (prose.length <= remaining) {
    return prose;
  }
  if (PROTECTED_CONTRACT_LINE_PATTERN.test(prose)) {
    return allowDrop ? '' : undefined; // never partially cut a contract field
  }
  return `${prose.slice(0, remaining - 1)}…`;
}

/** Packs a single recipe body into at most `maxChars` WITHOUT ever cutting
 * through a fenced code block OR a calling-contract field ("Use:"/
 * "Requires:"/"API:" — F10 fix, see `PROTECTED_CONTRACT_LINE_PATTERN`'s own
 * doc comment). Only ORDINARY descriptive prose is shortened (leading
 * prose first, since that's what a reviewer reads first); if the fenced
 * code — or a protected leading contract field — doesn't fit `maxChars`
 * even with every last bit of ordinary prose removed, returns `undefined`
 * so the caller omits the WHOLE recipe rather than emitting mangled,
 * contract-incomplete content. Trailing prose (rare — the template never
 * places a contract field after the code) is dropped in full rather than
 * omitting the whole recipe when it doesn't fit, since it was never
 * required to appear at all. */
function packRecipeBody(body: string, maxChars: number): string | undefined {
  if (body.length <= maxChars) {
    return body;
  }
  const split = splitRecipeBody(body);
  if (!split) {
    // No fenced code to protect in this recipe — plain, safe truncation.
    const budget = Math.max(0, maxChars - RECIPE_TRUNCATION_NOTICE.length);
    return budget > 0 ? `${body.slice(0, budget)}${RECIPE_TRUNCATION_NOTICE}` : undefined;
  }
  const { leadingProse, core, trailingProse } = split;
  if (core.length > maxChars) {
    return undefined; // The code alone doesn't fit — never slice it; the caller omits this recipe entirely.
  }
  let remaining = maxChars - core.length;
  const leading = fitProseBlock(leadingProse, remaining, false);
  if (leading === undefined) {
    return undefined; // A protected leading field (Use:/Requires:/API:) doesn't fit — omit the whole recipe, never a partial contract.
  }
  remaining -= leading.length > 0 ? leading.length + 2 : 0; // + the blank-line separator added below
  const trailing = fitProseBlock(trailingProse, remaining, true) ?? '';
  return [leading, core, trailing].filter((part) => part.length > 0).join('\n\n');
}

// --- A04 (import rendering must preserve real, distinct import shapes) -----
//
// The gap this section closes: `normalizeJavaImportPath()` (ragSourceGrounding.ts)
// was built for, and is still correctly used for, an entirely different
// job — F05's package-PREFIX check, which only ever needs a bare dotted
// path to compare against a known package string. Reusing that SAME
// reduction here, for RENDERING a complete statement back out, was lossy
// in two real ways this section fixes: (1) stripping "static " from
// `import static acme.Helper.find;` silently turned a STATIC MEMBER
// import into an ordinary (and for a member reference, syntactically
// INVALID) type import once re-rendered; (2) a Python `from framework.db
// import fetch_rows` never even matches that function's own "starts with
// import" check (it starts with "from"), so it passed through completely
// UNREDUCED and then got a SECOND, spurious "import " keyword prepended
// in front of its own — rendering the nonsensical `import from
// framework.db import fetch_rows`. An aliased Python import (`import X as
// Y`) has the exact same problem: reducing it to a bare path and
// re-deriving `import X` would silently drop the alias every future
// caller of that recipe's example code depends on.
//
// Fix: recognize these REAL, information-carrying shapes and either
// reconstruct them precisely (Java static imports, whose only extra
// information is the "static" keyword itself) or preserve them CHARACTER-
// FOR-CHARACTER rather than attempt to reduce-then-rebuild them at all
// (Python from-imports and aliased imports, whose imported NAMES/alias a
// bare dotted path structurally cannot represent — there's no reliable,
// general way to tell where a dotted module path ends and an imported
// name begins by re-splitting it later). Anything that doesn't match one
// of these special shapes still reduces to a bare path and renders exactly
// as before (F05's own original, still-correct behavior) — this is
// strictly ADDITIVE, never a narrowing of what already worked.

/** One import entry, in whichever of the several REAL shapes a model might
 * have stored it. */
type ParsedImportEntry =
  | { kind: 'bare-path'; path: string }
  | { kind: 'java-static'; path: string }
  /** A Python `from <module> import <names>` or `import <module> as
   * <alias>` line — preserved character-for-character; see this section's
   * own top-level doc comment for why re-deriving either from a bare path
   * would lose real information. */
  | { kind: 'verbatim'; statement: string };

const PYTHON_FROM_IMPORT_PATTERN = /^from\s+\S+\s+import\s+/;
const PYTHON_ALIASED_IMPORT_PATTERN = /^import\s+\S+\s+as\s+\S+/;
const JAVA_STATIC_IMPORT_PATTERN = /^static\s+(.+?);?\s*$/;

/** Recognizes which real shape `raw` (one stored `imports.java`/
 * `imports.python` entry) actually is — see this section's own top-level
 * doc comment for the three shapes and why each needs different
 * treatment. */
function parseImportEntry(raw: string, language: RagLanguage): ParsedImportEntry {
  const trimmed = raw.trim();
  if (language === 'python') {
    if (PYTHON_FROM_IMPORT_PATTERN.test(trimmed) || PYTHON_ALIASED_IMPORT_PATTERN.test(trimmed)) {
      return { kind: 'verbatim', statement: trimmed };
    }
    return { kind: 'bare-path', path: trimmed.replace(/^import\s+/, '').trim() };
  }
  const withoutImportKeyword = trimmed.replace(/^import\s+/, '');
  const staticMatch = withoutImportKeyword.match(JAVA_STATIC_IMPORT_PATTERN);
  if (staticMatch) {
    return { kind: 'java-static', path: staticMatch[1].trim() };
  }
  return { kind: 'bare-path', path: withoutImportKeyword.replace(/;\s*$/, '').trim() };
}

/** A stable dedup key for one parsed entry — `kind` is part of the key
 * (not just the path/statement text) since a STATIC import and an
 * ordinary import of the exact same dotted path are two genuinely
 * DIFFERENT real imports, never interchangeable duplicates of each
 * other. */
function importEntryKey(entry: ParsedImportEntry): string {
  return entry.kind === 'verbatim' ? `verbatim:${entry.statement}` : `${entry.kind}:${entry.path}`;
}

/** The import entries a set of matches declares for `language`,
 * deduplicated by their real shape+content (A04) — see this section's own
 * top-level doc comment for why a model's stored `imports.java`/
 * `imports.python` entries can't all be reduced to one bare-path shape
 * before rendering. */
function importsFor(matches: RagMatch[], language: RagLanguage): ParsedImportEntry[] {
  const byKey = new Map<string, ParsedImportEntry>();
  for (const match of matches) {
    const imports = match.imports?.[language];
    if (!Array.isArray(imports)) {
      continue;
    }
    for (const raw of imports) {
      const entry = parseImportEntry(raw, language);
      const key = importEntryKey(entry);
      if (!byKey.has(key)) {
        byKey.set(key, entry);
      }
    }
  }
  return Array.from(byKey.values());
}

/** Renders ONE parsed import entry (see `importsFor()`) as a COMPLETE,
 * directly-pasteable statement in `language`'s own real syntax (F05's
 * original fix, extended by A04 to the two additional real shapes above)
 * — the RAG section previously showed a bare path like
 * `com.acme.db.PostgresHelper` under "Required imports" with no `import `
 * keyword or trailing `;` at all, leaving the CONSUMING model to guess
 * whether that text was already a complete statement or just a path
 * fragment it needed to build one from itself. A bare Java path gets a
 * trailing `;` (required Java syntax); a bare Python path's own `import
 * <dotted.path>` statement has no such terminator; a Java static import
 * gets its `static` keyword restored; a Python from-import/aliased import
 * is already a complete statement and is returned exactly as stored. */
function formatImportStatement(entry: ParsedImportEntry, language: RagLanguage): string {
  switch (entry.kind) {
    case 'verbatim':
      return entry.statement;
    case 'java-static':
      return `import static ${entry.path};`;
    case 'bare-path':
      return language === 'java' ? `import ${entry.path};` : `import ${entry.path}`;
  }
}

const RAG_SECTION_HEADER = [
  '\n## Reusable components available — reuse ONLY the ones that genuinely fit',
  'These are LEXICAL retrieval matches, not verified fits — each surfaced because its title/tags/path/code ' +
    "shares vocabulary with this request, not because it was confirmed to be right for this specific step. " +
    "Before reusing one, check its operation, parameter types/order, and preconditions actually match what this " +
    "step needs. If they do, you MUST use it instead of writing equivalent logic yourself from scratch — call it " +
    "exactly as shown in its example, without modifying its own implementation, AND copy its import statement " +
    "EXACTLY as printed under \"Required imports\" below, character for character — never invent, abbreviate, " +
    "shorten, or restructure the package path, even if a different path looks equally plausible to you. If they " +
    "don't genuinely fit (different operation, mismatched parameters, an unmet precondition, or just the wrong " +
    "tool), write fresh code instead — never force an unrelated or partially-fitting component in just because it " +
    "was retrieved. Using NONE of them is a valid outcome when none genuinely fit. TRACEABILITY (only for a " +
    "component you actually use): the first time you call it, add a one-line comment directly above the call, in " +
    'this exact form (this language\'s own comment syntax): "RAG match: <component id> (from <source file>)", ' +
    'using the exact id/source file shown below.'
].join('\n');

/** `importEntries` are parsed import entries (see `importsFor()`) —
 * rendered here as complete, directly-pasteable statements in `language`'s
 * own syntax (F05's original fix, extended by A04 — see
 * `formatImportStatement()`'s own doc comment). */
function assembleSection(entries: { headerLine: string; body: string }[], importEntries: ParsedImportEntry[], language: RagLanguage): string {
  const parts = [RAG_SECTION_HEADER];
  for (const entry of entries) {
    parts.push(entry.headerLine, entry.body);
  }
  if (importEntries.length > 0) {
    const importLines = importEntries.map((entry) => formatImportStatement(entry, language));
    parts.push(`\n### Required imports for the component(s) used above\n${importLines.map((line) => `\`${line}\``).join('\n')}`);
  }
  return parts.join('\n');
}

export interface RagPromptSection {
  section: string;
  /** The matches that actually ended up in `section` — a subset of the
   * matches passed in when one or more had to be omitted (rather than
   * mangled) to fit the total size cap. Callers building a traceability
   * banner MUST use this list, not the original `matches` array — crediting
   * a recipe the model was never actually shown would be misleading. */
  includedMatches: RagMatch[];
}

export interface FormatRagPromptSectionOptions {
  /** Overrides `RAG_MAX_RECIPE_BODY_CHARS`. */
  maxRecipeBodyChars?: number;
  /** Overrides `RAG_MAX_TOTAL_SECTION_CHARS`. */
  maxTotalSectionChars?: number;
}

/** Pure formatter — returns an empty section (and no included matches) when
 * there's nothing to show, so a request with no relevant reusable
 * component costs exactly zero extra prompt tokens, never a "no matches
 * found" placeholder.
 *
 * Packs COMPLETE recipe units (id, source, imports, and the recipe's own
 * fenced example code, verbatim) rather than blindly slicing raw text:
 * each recipe's body is first packed against the per-recipe cap
 * (`RAG_MAX_RECIPE_BODY_CHARS` by default), then recipes are added to the
 * section, best match first, only while the running total still fits the
 * overall cap (`RAG_MAX_TOTAL_SECTION_CHARS` by default) — a recipe that
 * would push the total over is omitted WHOLE rather than truncated
 * further, so the cap is enforced by construction and a recipe that IS
 * included is never missing its imports or a half-written code example.
 * Required imports are computed only from the recipes that actually made
 * it in, for the same reason.
 *
 * `options` lets a caller with its OWN real, measured token budget
 * (rag/ragOperationPacking.ts's `packOperationCandidates()` — Phase 3) use
 * a larger char ceiling than the fixed defaults below (F10's second half:
 * those two constants were sized for a conservative, small-context worst
 * case, and — being fixed regardless of the ACTUAL resolved model's real
 * context window — silently capped a large-context model's usable RAG
 * budget far below what it could genuinely afford, even though that
 * caller's own real per-request `countTokens` check remains the
 * authoritative final guard either way). Every OTHER caller (the older,
 * non-token-aware whole-query retrieval path, and every existing test)
 * omits `options` and gets the exact same fixed defaults as before this
 * parameter existed. */
export function formatRagPromptSection(matches: RagMatch[], language: RagLanguage, options: FormatRagPromptSectionOptions = {}): RagPromptSection {
  const maxRecipeBodyChars = options.maxRecipeBodyChars ?? RAG_MAX_RECIPE_BODY_CHARS;
  const maxTotalSectionChars = options.maxTotalSectionChars ?? RAG_MAX_TOTAL_SECTION_CHARS;
  if (matches.length === 0) {
    return { section: '', includedMatches: [] };
  }

  type Entry = { match: RagMatch; headerLine: string; body: string };
  const packedEntries: Entry[] = [];
  matches.forEach((match, i) => {
    const packedBody = packRecipeBody(match.body, maxRecipeBodyChars);
    if (packedBody === undefined) {
      return; // This recipe's own code exceeds even the per-recipe cap alone — omit it, never slice its code.
    }
    packedEntries.push({
      match,
      headerLine: `\n### ${i + 1}. ${match.title} (id: \`${match.id}\`, source file: \`${path.basename(match.filePath)}\`)`,
      body: packedBody
    });
  });

  // Greedily add whole recipes, best match first, only while the running
  // total (header + every included recipe + the imports it implies) still
  // fits the overall cap. A recipe that doesn't fit is skipped — never
  // truncated further — but later (lower-scored, possibly smaller) recipes
  // still get a chance, rather than stopping at the first that doesn't fit.
  const included: Entry[] = [];
  for (const entry of packedEntries) {
    const candidate = [...included, entry];
    const candidateSection = assembleSection(candidate, importsFor(candidate.map((e) => e.match), language), language);
    if (candidateSection.length <= maxTotalSectionChars) {
      included.push(entry);
    }
  }

  if (included.length === 0) {
    // Nothing fit at all — surface that plainly instead of silently
    // returning an empty section indistinguishable from "no matches".
    const notice = `\n… (no matched component fit within the ${maxTotalSectionChars.toLocaleString()}-char RAG section limit — consider trimming .github/rag/ recipes.)`;
    return { section: `${RAG_SECTION_HEADER}${notice}`, includedMatches: [] };
  }

  const section = assembleSection(included, importsFor(included.map((e) => e.match), language), language);
  return { section, includedMatches: included.map((e) => e.match) };
}
