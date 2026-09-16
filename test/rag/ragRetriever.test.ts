import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildRagIndex } from '../../src/rag/ragIndexBuilder';
import { retrieveRagMatches, formatRagPromptSection } from '../../src/rag/ragRetriever';
import { RagRecipe } from '../../src/rag/ragTypes';
import { DEFAULT_RELEVANCE_GATE, RelevanceGateConfig } from '../../src/rag/ragRelevanceGate';

function makeRecipe(options: {
  id: string;
  title: string;
  body: string;
  tags?: string[];
  automationMode?: RagRecipe['frontmatter']['automationMode'];
  language?: RagRecipe['frontmatter']['language'];
  imports?: RagRecipe['frontmatter']['imports'];
  /** Defaults to a flat "<id>.md" at the rag root, matching every existing
   * fixture's prior behavior — pass an explicit nested path (e.g.
   * "database/cassandra/cassandra-helper.md") for tests specifically
   * exercising folder/filename-based matching. */
  relativePath?: string;
}): RagRecipe {
  const relativePath = options.relativePath ?? `${options.id}.md`;
  return {
    filePath: `/fake/.github/rag/${relativePath}`,
    relativePath,
    mtimeMs: 0,
    frontmatter: {
      id: options.id,
      title: options.title,
      tags: options.tags ?? [],
      automationMode: options.automationMode ?? ['ui', 'api'],
      language: options.language ?? ['java', 'python'],
      imports: options.imports
    },
    body: options.body
  };
}

const POSTGRES_RECIPE = makeRecipe({
  id: 'postgres-query-and-validate',
  title: 'Query a Postgres table and validate a result',
  body: '```java\nvar row = PostgresHelper.queryOne(conn, sql, id);\n```',
  tags: ['postgres', 'database', 'sql', 'query'],
  automationMode: ['api'],
  language: ['java'],
  imports: { java: ['com.acme.testutil.db.PostgresHelper'] }
});

const SCREENSHOT_RECIPE = makeRecipe({
  id: 'take-screenshot',
  title: 'Take a screenshot and save it to disk',
  body: '```python\ntake_screenshot(page, "out.png")\n```',
  tags: ['screenshot', 'ui', 'debugging'],
  automationMode: ['ui'],
  language: ['python'],
  imports: { python: ['testutil.screenshot'] }
});

test('retrieves the relevant recipe for a matching scenario and filters by mode/language', async () => {
  const index = await buildRagIndex([POSTGRES_RECIPE, SCREENSHOT_RECIPE]);
  const matches = await retrieveRagMatches(
    index,
    'Login to Postgres database, query a specific table using a query, validate the result',
    'java',
    'api'
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 'postgres-query-and-validate');
});

test('a recipe wrongly tagged for the OTHER automation mode still surfaces when its content is a strong match (the bug this fixes)', async () => {
  // Mirrors the real failure: "Generate RAG Corpus format" guesses
  // automationMode per file, in isolation, with no idea how it'll later be
  // searched — a shared DB utility easily gets tagged 'api'-only even
  // though a UI Automation scenario legitimately needs to validate a DB
  // value too. Before this fix, automationMode was a HARD filter, so this
  // recipe was excluded entirely (zero matches) despite an exact folder-
  // name + title match — the "RAG clearly has the right file but never
  // uses it" bug report this test locks in the fix for.
  const cassandraRecipe = makeRecipe({
    id: 'csql',
    title: 'Query Cassandra and validate a value',
    body: '```java\nvar row = CassandraHelper.queryOne(session, cql, id);\n```',
    tags: ['cassandra', 'database', 'query'],
    automationMode: ['api'], // mis-tagged relative to how it's about to be used
    language: ['java'],
    relativePath: 'bigdata/src/main/java/com/td/tds/tcoe/automation/cassandra/csql.md'
  });
  const index = await buildRagIndex([cassandraRecipe, SCREENSHOT_RECIPE]);
  const matches = await retrieveRagMatches(
    index,
    'Verify all the details validated on the UI page are also validated in this cassandra table, write a query to validate the table',
    'java',
    'ui' // the mode this recipe was NOT tagged for
  );
  assert.ok(matches.some((m) => m.id === 'csql'), 'expected the mode-mismatched-but-highly-relevant cassandra recipe to still surface');
});

test('a correctly-moded recipe still outranks an equally content-relevant, wrongly-moded one', async () => {
  const uiTaggedCassandra = makeRecipe({
    id: 'csql-ui-tagged',
    title: 'Query Cassandra and validate a value',
    body: '```java\nvar row = CassandraHelper.queryOne(session, cql, id);\n```',
    tags: ['cassandra', 'database', 'query'],
    automationMode: ['ui'],
    language: ['java']
  });
  const apiTaggedCassandra = makeRecipe({
    id: 'csql-api-tagged',
    title: 'Query Cassandra and validate a value',
    body: '```java\nvar row = CassandraHelper.queryOne(session, cql, id);\n```',
    tags: ['cassandra', 'database', 'query'],
    automationMode: ['api'],
    language: ['java']
  });
  const index = await buildRagIndex([uiTaggedCassandra, apiTaggedCassandra]);
  const matches = await retrieveRagMatches(index, 'connect to cassandra and validate a value', 'java', 'ui');
  assert.equal(matches[0].id, 'csql-ui-tagged', 'the correctly-moded recipe should still rank first when content relevance is otherwise identical');
});

test('a correctly-moded, highly-relevant recipe still surfaces in a corpus LARGER than the old fixed candidate-pool cap (the bug this fixes)', async () => {
  // Before this fix, only the raw (pre-mode-penalty) top 20 candidates by
  // score were ever handed to the automationMode rerank — in a corpus
  // bigger than that, a correctly-moded recipe ranked just outside the raw
  // top 20 could never even be CONSIDERED for the rerank, let alone win it,
  // no matter how much better its post-penalty score would have been.
  // Simulated here with 25 near-duplicate, mode-MISMATCHED "noise" recipes
  // that score EXACTLY as well on raw content relevance as the real target
  // (identical title/tags/body/relativePath -> identical embedding text ->
  // identical raw score -> a stable sort keeps them in insertion order) —
  // deterministically occupying the entire old top-20 window ahead of the
  // target, which is appended last.
  const SHARED_RELATIVE_PATH = 'database/cassandra/helper.md';
  const noiseRecipes = Array.from({ length: 25 }, (_, i) =>
    makeRecipe({
      id: `noise-${i}`,
      title: 'Query Cassandra and validate a value',
      body: '```java\nvar row = CassandraHelper.queryOne(session, cql, id);\n```',
      tags: ['cassandra', 'database', 'query'],
      automationMode: ['api'], // mismatched relative to the 'ui' query below
      language: ['java'],
      relativePath: SHARED_RELATIVE_PATH
    })
  );
  const correctlyModedTarget = makeRecipe({
    id: 'the-real-target',
    title: 'Query Cassandra and validate a value',
    body: '```java\nvar row = CassandraHelper.queryOne(session, cql, id);\n```',
    tags: ['cassandra', 'database', 'query'],
    automationMode: ['ui'], // matches the query below
    language: ['java'],
    relativePath: SHARED_RELATIVE_PATH
  });
  const index = await buildRagIndex([...noiseRecipes, correctlyModedTarget]);
  const matches = await retrieveRagMatches(index, 'connect to cassandra and validate a value', 'java', 'ui', 5);
  assert.ok(
    matches.some((m) => m.id === 'the-real-target'),
    'a correctly-moded recipe must still be reachable even in a corpus larger than any fixed candidate-pool cap'
  );
});

test('a recipe restricted to a different language never appears even if the text scores well', async () => {
  const index = await buildRagIndex([POSTGRES_RECIPE, SCREENSHOT_RECIPE]);
  // Same query, but asking for python/ui — postgres recipe is java/api only.
  const matches = await retrieveRagMatches(index, 'postgres database query table validate', 'python', 'ui');
  assert.equal(matches.find((m) => m.id === 'postgres-query-and-validate'), undefined);
});

test('an unrelated query returns no matches rather than the least-bad option', async () => {
  const index = await buildRagIndex([POSTGRES_RECIPE, SCREENSHOT_RECIPE]);
  const matches = await retrieveRagMatches(index, 'zzzzzz completely unrelated nonsense qqqqqq', 'java', 'api');
  assert.equal(matches.length, 0);
});

test('an empty query string returns no matches', async () => {
  const index = await buildRagIndex([POSTGRES_RECIPE, SCREENSHOT_RECIPE]);
  const matches = await retrieveRagMatches(index, '   ', 'java', 'api');
  assert.equal(matches.length, 0);
});

const CASSANDRA_RECIPE_NO_MENTION_IN_CONTENT = makeRecipe({
  id: 'connection-helper',
  // Deliberately generic title/tags/body — NONE of them mention
  // "cassandra" anywhere. Only the folder structure does.
  title: 'Connection helper',
  body: '```java\nvar row = ConnectionHelper.queryOne(session, cql, id);\n```',
  tags: ['database', 'query'],
  automationMode: ['ui', 'api'],
  language: ['java'],
  relativePath: 'database/cassandra/connection-helper.md'
});

test('a recipe is matchable purely by its FOLDER name, even when that word appears nowhere in title/tags/body', async () => {
  const index = await buildRagIndex([CASSANDRA_RECIPE_NO_MENTION_IN_CONTENT, SCREENSHOT_RECIPE]);
  const matches = await retrieveRagMatches(index, 'connect to cassandra and run a query', 'java', 'api');
  assert.ok(matches.some((m) => m.id === 'connection-helper'), 'expected the folder-name "cassandra" alone to surface this recipe');
});

test('folder-name matching works identically for UI Automation mode as it does for API Automation mode', async () => {
  const index = await buildRagIndex([CASSANDRA_RECIPE_NO_MENTION_IN_CONTENT, SCREENSHOT_RECIPE]);
  const uiMatches = await retrieveRagMatches(index, 'connect to cassandra and run a query', 'java', 'ui');
  assert.ok(uiMatches.some((m) => m.id === 'connection-helper'), 'the same folder-name match should surface for UI Automation mode too');
});

test('a recipe is matchable purely by its own FILENAME segment', async () => {
  const namedRecipe = makeRecipe({
    id: 'oauth-token-refresh',
    title: 'Token utility',
    body: '```java\nTokenUtil.get();\n```',
    tags: [],
    relativePath: 'auth/oauth-token-refresh.md'
  });
  const index = await buildRagIndex([namedRecipe, SCREENSHOT_RECIPE]);
  const matches = await retrieveRagMatches(index, 'refresh the oauth token before the request', 'java', 'api');
  assert.ok(matches.some((m) => m.id === 'oauth-token-refresh'), 'expected the filename words "oauth"/"token"/"refresh" alone to surface this recipe');
});

// ---------------------------------------------------------------------
// Path/filename keyword-match boost (PATH_FILENAME_MATCH_BOOST) — the
// existing folder/filename matching above (recipeToEmbeddingText()'s own
// 2x-weighted relativePath) only ever matches whole VOCABULARY TERMS the
// tokenizer actually produced from that path. It cannot find a query
// keyword that is merely a SUBSTRING of a longer, unsplittable fused path
// segment — e.g. "autosys" inside the single all-lowercase token
// "autosysjobmonitor", which has no case-change/underscore boundary for
// the identifier-splitter to find at all (see tfidfEmbeddings.ts's
// `splitIdentifierWords()`). These tests target exactly that gap.
// ---------------------------------------------------------------------

test('a recipe is matchable when the query keyword is only a SUBSTRING of a fused (no-separator) filename segment', async () => {
  const autosysRecipe = makeRecipe({
    id: 'autosysjobmonitor-execute',
    // Deliberately generic title/tags/body — none of them mention
    // "autosys" anywhere, and the ONLY place it appears in the path is
    // fused into "autosysjobmonitor" with no word-boundary at all (no
    // isolated "autosys" folder segment either, unlike the cassandra
    // fixture above) — exactly the case ordinary tokenized vocabulary
    // matching cannot find.
    title: 'Execute a scheduled job and check its logs',
    body: '```java\nJobRunner.executeAndCheckLogs(jobName);\n```',
    tags: ['job', 'scheduler'],
    relativePath: 'src/main/java/com/framework/monitoring/autosysjobmonitor-execute.md'
  });
  const index = await buildRagIndex([autosysRecipe, SCREENSHOT_RECIPE]);
  const matches = await retrieveRagMatches(index, 'run the autosys job and validate the job logs for no errors', 'java', 'api');
  assert.ok(
    matches.some((m) => m.id === 'autosysjobmonitor-execute'),
    'expected the "autosys" keyword to match via the fused filename segment even though it never appears as its own isolated token'
  );
});

test('a fused-filename path match still loses to a genuinely more content-relevant recipe (boost is a signal, not an override)', async () => {
  const weaklyPathMatched = makeRecipe({
    id: 'autosysjobmonitor-execute',
    title: 'Execute a scheduled job and check its logs',
    body: '```java\nJobRunner.executeAndCheckLogs(jobName);\n```',
    tags: ['job', 'scheduler'],
    relativePath: 'src/main/java/com/framework/monitoring/autosysjobmonitor-execute.md'
  });
  const stronglyContentMatched = makeRecipe({
    id: 'autosys-job-monitor-real-match',
    title: 'Run an Autosys job and validate its logs for errors',
    body: '```java\nAutosysHelper.runJobAndValidateLogs(jobName);\n```',
    tags: ['autosys', 'job', 'logs', 'validate'],
    relativePath: 'autosys/run-and-validate.md'
  });
  const index = await buildRagIndex([weaklyPathMatched, stronglyContentMatched]);
  const matches = await retrieveRagMatches(index, 'run the autosys job and validate the job logs for no errors', 'java', 'api');
  assert.equal(matches[0].id, 'autosys-job-monitor-real-match', 'a recipe whose title/tags/body genuinely and explicitly match should still outrank a mere path-substring hit');
});

test('a short (<4 char) query word never triggers a spurious path/filename boost', async () => {
  const recipeWithCoincidentalSubstring = makeRecipe({
    id: 'unrelated-db-pool-helper',
    // Deliberately shares NO real content words with the query below —
    // isolates the path/filename boost specifically, rather than also
    // picking up an ordinary TF-IDF content match for some other reason.
    title: 'Database connection pooling utility',
    body: '```java\nPool.getConnection();\n```',
    tags: ['database', 'pool'],
    // "run" (3 chars, below MIN_PATH_MATCH_KEYWORD_LENGTH) appears here
    // purely coincidentally as a substring of "running" — must not be
    // treated as a real path/filename keyword match.
    relativePath: 'misc/running-totals-helper.md'
  });
  const index = await buildRagIndex([recipeWithCoincidentalSubstring, SCREENSHOT_RECIPE]);
  const matches = await retrieveRagMatches(index, 'run the export batch job', 'java', 'api');
  assert.equal(
    matches.find((m) => m.id === 'unrelated-db-pool-helper'),
    undefined,
    'a short, coincidental substring ("run" inside "running") must not manufacture a match out of an otherwise unrelated recipe'
  );
});

test('every match carries the recipe\'s own source file path, for traceability', async () => {
  const index = await buildRagIndex([POSTGRES_RECIPE, SCREENSHOT_RECIPE]);
  const matches = await retrieveRagMatches(
    index,
    'Login to Postgres database, query a specific table using a query, validate the result',
    'java',
    'api'
  );
  assert.equal(matches[0].filePath, '/fake/.github/rag/postgres-query-and-validate.md');
});

test('formatRagPromptSection returns an empty section and no included matches for zero matches (zero prompt cost)', () => {
  const result = formatRagPromptSection([], 'java');
  assert.equal(result.section, '');
  assert.deepEqual(result.includedMatches, []);
});

test('formatRagPromptSection includes the title, body, and de-duplicated imports for the target language', () => {
  const { section, includedMatches } = formatRagPromptSection(
    [
      {
        id: 'a',
        title: 'Helper A',
        body: 'code A',
        imports: { java: ['com.acme.A', 'com.acme.Shared'] },
        score: 0.9,
        filePath: '/fake/.github/rag/a.md'
      },
      {
        id: 'b',
        title: 'Helper B',
        body: 'code B',
        imports: { java: ['com.acme.Shared'] },
        score: 0.5,
        filePath: '/fake/.github/rag/b.md'
      }
    ],
    'java'
  );
  assert.match(section, /Helper A/);
  assert.match(section, /Helper B/);
  assert.match(section, /code A/);
  assert.match(section, /code B/);
  assert.match(section, /com\.acme\.A/);
  // De-duplicated: "com.acme.Shared" appears in both recipes but should
  // only be listed once in the required-imports block.
  const sharedOccurrences = section.split('com.acme.Shared').length - 1;
  assert.equal(sharedOccurrences, 1);
  assert.equal(includedMatches.length, 2);
});

// --- F05: rendered imports are COMPLETE, unambiguous statements -------------

test('formatRagPromptSection renders a Java import as a complete "import x.y.Z;" statement, not a bare path', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'a', title: 'Helper A', body: 'code A', imports: { java: ['com.acme.db.PostgresHelper'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' }],
    'java'
  );
  assert.match(section, /`import com\.acme\.db\.PostgresHelper;`/);
});

test('formatRagPromptSection renders a Python import as a complete "import x.y.z" statement (no semicolon)', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'a', title: 'Helper A', body: 'code A', imports: { python: ['testutil.db.helper'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' }],
    'python'
  );
  assert.match(section, /`import testutil\.db\.helper`/);
  assert.doesNotMatch(section, /testutil\.db\.helper;/);
});

test('formatRagPromptSection normalizes a stray "import x;"-shaped stored value down to one bare-then-rendered statement, never a duplicate', () => {
  const { section } = formatRagPromptSection(
    [
      { id: 'a', title: 'Helper A', body: 'code A', imports: { java: ['import com.acme.db.PostgresHelper;'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' },
      { id: 'b', title: 'Helper B', body: 'code B', imports: { java: ['com.acme.db.PostgresHelper'] }, score: 0.8, filePath: '/fake/.github/rag/b.md' }
    ],
    'java'
  );
  const occurrences = section.split('import com.acme.db.PostgresHelper;').length - 1;
  assert.equal(occurrences, 1, 'the same import stored two different ways across two recipes should render exactly once, not twice');
});

// --- A04: import rendering preserves real, distinct import shapes ----------

test('A04: a Python "from X import Y" entry is rendered VERBATIM, never wrapped in a second "import" keyword (the exact reproduced bug)', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'a', title: 'Helper A', body: 'code A', imports: { python: ['from framework.db import fetch_rows'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' }],
    'python'
  );
  assert.match(section, /`from framework\.db import fetch_rows`/);
  assert.doesNotMatch(section, /import from framework/, 'must never double up the "import" keyword');
});

test('A04: a Python aliased import ("import X as Y") is preserved verbatim, including the alias', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'a', title: 'Helper A', body: 'code A', imports: { python: ['import framework.db as db'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' }],
    'python'
  );
  assert.match(section, /`import framework\.db as db`/);
});

test('A04: a Java static import keeps its "static" keyword when re-rendered (the exact reproduced bug — the OLD code silently dropped it, producing an invalid ordinary import)', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'a', title: 'Helper A', body: 'code A', imports: { java: ['import static acme.Helper.find;'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' }],
    'java'
  );
  assert.match(section, /`import static acme\.Helper\.find;`/);
});

test('A04: a Java static import stored WITHOUT the "import " prefix (just "static acme.Helper.find") still renders correctly', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'a', title: 'Helper A', body: 'code A', imports: { java: ['static acme.Helper.find'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' }],
    'java'
  );
  assert.match(section, /`import static acme\.Helper\.find;`/);
});

test('A04: a Java wildcard import renders correctly (never specially detected — it\'s just a bare path ending in ".*", already handled by the existing bare-path rendering)', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'a', title: 'Helper A', body: 'code A', imports: { java: ['com.acme.db.*'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' }],
    'java'
  );
  assert.match(section, /`import com\.acme\.db\.\*;`/);
});

test('A04: an ORDINARY Java import of the SAME dotted path as a static import is treated as a genuinely DIFFERENT entry, never collapsed into one', () => {
  const { section } = formatRagPromptSection(
    [
      { id: 'a', title: 'Helper A', body: 'code A', imports: { java: ['import static acme.Helper.find;'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' },
      { id: 'b', title: 'Helper B', body: 'code B', imports: { java: ['acme.Helper'] }, score: 0.8, filePath: '/fake/.github/rag/b.md' }
    ],
    'java'
  );
  assert.match(section, /`import static acme\.Helper\.find;`/);
  assert.match(section, /`import acme\.Helper;`/);
});

test('A04: two DIFFERENT Python from-imports from different modules both survive, never deduplicated into one', () => {
  const { section } = formatRagPromptSection(
    [
      { id: 'a', title: 'Helper A', body: 'code A', imports: { python: ['from framework.db import fetch_rows'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' },
      { id: 'b', title: 'Helper B', body: 'code B', imports: { python: ['from framework.api import post_json'] }, score: 0.8, filePath: '/fake/.github/rag/b.md' }
    ],
    'python'
  );
  assert.match(section, /`from framework\.db import fetch_rows`/);
  assert.match(section, /`from framework\.api import post_json`/);
});

test('A04: the exact SAME Python from-import stored twice across two recipes renders exactly once', () => {
  const { section } = formatRagPromptSection(
    [
      { id: 'a', title: 'Helper A', body: 'code A', imports: { python: ['from framework.db import fetch_rows'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' },
      { id: 'b', title: 'Helper B', body: 'code B', imports: { python: ['from framework.db import fetch_rows'] }, score: 0.8, filePath: '/fake/.github/rag/b.md' }
    ],
    'python'
  );
  const occurrences = section.split('from framework.db import fetch_rows').length - 1;
  assert.equal(occurrences, 1);
});

test('formatRagPromptSection omits python imports when formatting for java', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'a', title: 'Helper A', body: 'code A', imports: { python: ['testutil.a'] }, score: 0.9, filePath: '/fake/.github/rag/a.md' }],
    'java'
  );
  assert.doesNotMatch(section, /testutil\.a/);
});

test('formatRagPromptSection truncates an unusually large FENCE-LESS recipe body rather than injecting it whole', () => {
  const hugeBody = 'x'.repeat(10_000);
  const { section, includedMatches } = formatRagPromptSection(
    [{ id: 'huge', title: 'Huge Helper', body: hugeBody, score: 0.9, filePath: '/fake/.github/rag/huge.md' }],
    'java'
  );
  assert.ok(section.length < hugeBody.length, 'the section should be meaningfully smaller than the raw oversized body');
  assert.match(section, /truncated/);
  assert.equal(includedMatches.length, 1);
});

test('formatRagPromptSection never slices through a fenced code block, even when the body must be shortened', () => {
  // A body with a large prose description AND a fenced example that
  // together exceed the per-recipe cap — before the fix, a blind
  // character slice at 1,500 could land in the middle of the fence,
  // corrupting the example and dropping the closing ``` entirely.
  const prose = 'This helper connects to the database and runs a query. '.repeat(50); // ~2,850 chars of prose
  const code = '```java\nvar row = PostgresHelper.queryOne(conn, sql, id);\nreturn row;\n```';
  const { section, includedMatches } = formatRagPromptSection(
    [{ id: 'a', title: 'Helper A', body: `${prose}\n\n${code}`, score: 0.9, filePath: '/fake/.github/rag/a.md' }],
    'java'
  );
  assert.equal(includedMatches.length, 1);
  // The fence is intact — both delimiters present and the code between them verbatim.
  assert.match(section, /```java\nvar row = PostgresHelper\.queryOne\(conn, sql, id\);\nreturn row;\n```/);
});

// --- F10: calling-contract fields (Use:/Requires:/API:) are never truncated or dropped ---

test('formatRagPromptSection preserves Use:/Requires:/API: in FULL — byte-for-byte, no ellipsis — while still shortening ordinary trailing prose (the reproduced F10 bug)', () => {
  // Measured directly: leadingProse (Use:+Requires:+API:) is 195 chars,
  // the fenced code is 62 chars, and the extra trailing prose is 558
  // chars — 819 total, over a 350-char cap. leadingProse alone fits
  // comfortably within what's left after the code (288 chars), so it must
  // survive completely untouched; only the ordinary (unlabeled) trailing
  // prose is what gets shortened.
  const requires = 'Requires: an open, authenticated database connection already established via the connection pool.';
  const api = 'API: public List<Row> queryOne(String sql, Object... params)';
  const use = 'Use: short one-sentence description.';
  const leadingProse = `${use}\n${requires}\n${api}`;
  const code = '```java\nvar rows = PostgresHelper.queryOne(conn, sql, id);\n```';
  const trailing = 'This is some extra disposable trailing prose that explains more context and can safely be shortened or dropped entirely without losing anything essential to the calling contract itself. '.repeat(
    3
  );
  const body = `${leadingProse}\n\n${code}\n\n${trailing}`;
  const { section, includedMatches } = formatRagPromptSection([{ id: 'a', title: 'Helper A', body, score: 0.9, filePath: '/fake/.github/rag/a.md' }], 'java', {
    maxRecipeBodyChars: 350
  });
  assert.equal(includedMatches.length, 1);
  assert.match(section, new RegExp(requires.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'Requires: must survive completely intact, not truncated');
  assert.match(section, new RegExp(api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'API: must survive completely intact, not truncated');
  // The trailing (ordinary, non-contract) prose IS shortened — proving
  // this isn't just a larger overall cap making everything fit anyway.
  assert.doesNotMatch(section, new RegExp(trailing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the disposable trailing prose should have been shortened, not kept in full');
});

test('formatRagPromptSection omits the WHOLE recipe rather than publish a partially-cut Requires:/API: field when nothing else can be trimmed enough', () => {
  const requires = 'Requires: ' + 'a very specific precondition that is described at unusually great length here. '.repeat(20);
  const api = 'API: public List<Row> queryOne(String sql, Object... params)';
  const code = '```java\nvar rows = PostgresHelper.queryOne(conn, sql, id);\n```';
  const body = `Use: short.\n${requires}\n${api}\n\n${code}`;
  const { includedMatches } = formatRagPromptSection([{ id: 'a', title: 'Helper A', body, score: 0.9, filePath: '/fake/.github/rag/a.md' }], 'java', {
    maxRecipeBodyChars: 300 // too small for the oversized Requires: field alongside the code
  });
  assert.equal(includedMatches.length, 0, 'the recipe must be omitted whole rather than truncating a contract field');
});

test('formatRagPromptSection still shortens ORDINARY (non-contract) prose exactly as before, when a recipe has no recognized contract fields at all', () => {
  const prose = 'This helper connects to the database and runs a query. '.repeat(50);
  const code = '```java\nvar row = PostgresHelper.queryOne(conn, sql, id);\nreturn row;\n```';
  const { section, includedMatches } = formatRagPromptSection([{ id: 'a', title: 'Helper A', body: `${prose}\n\n${code}`, score: 0.9, filePath: '/fake/.github/rag/a.md' }], 'java');
  assert.equal(includedMatches.length, 1);
  assert.match(section, /…/, 'ordinary prose with no recognized contract field is still shortened with an ellipsis, unchanged from before F10');
});

test('formatRagPromptSection accepts a caller-supplied larger char ceiling (F10\'s second half — a large-context model is not artificially capped)', () => {
  const matches = Array.from({ length: 3 }, (_, i) => ({
    id: `helper-${i}`,
    title: `Helper ${i}`,
    body: `\`\`\`java\n${'y'.repeat(1_380)}\n\`\`\``,
    score: 0.9 - i * 0.01,
    filePath: `/fake/.github/rag/helper-${i}.md`
  }));
  const withDefaultCap = formatRagPromptSection(matches, 'java');
  assert.ok(withDefaultCap.includedMatches.length < 3, 'the default 4,000-char cap should NOT fit all three');

  const withLargerCap = formatRagPromptSection(matches, 'java', { maxTotalSectionChars: 20_000, maxRecipeBodyChars: 5_000 });
  assert.equal(withLargerCap.includedMatches.length, 3, 'a caller-supplied larger ceiling should let all three fit');
});

test('formatRagPromptSection with NO options given behaves EXACTLY as before F10 (backward compatible default)', () => {
  const hugeBody = 'x'.repeat(10_000);
  const { section, includedMatches } = formatRagPromptSection([{ id: 'huge', title: 'Huge Helper', body: hugeBody, score: 0.9, filePath: '/fake/.github/rag/huge.md' }], 'java');
  assert.ok(section.length < hugeBody.length);
  assert.match(section, /truncated/);
  assert.equal(includedMatches.length, 1);
});

test('formatRagPromptSection: two competing oversized fenced recipes both keep their imports — the exact bug this fixes', () => {
  // Reproduces the real-world report: two ~1,700-char fenced bodies used to
  // get sliced by a blind per-body cut, and imports (appended AFTER every
  // body, then sliced again by the total-cap cut) were lost entirely.
  const bigFencedBody = (marker: string) =>
    `Uses the shared helper to talk to the service.\n\n\`\`\`java\n// ${marker}\n${'x'.repeat(1_650)}\nreturn result;\n\`\`\``;
  const matches = [
    {
      id: 'helper-one',
      title: 'Helper One',
      body: bigFencedBody('ONE'),
      imports: { java: ['com.acme.testutil.HelperOne'] },
      score: 0.9,
      filePath: '/fake/.github/rag/helper-one.md'
    },
    {
      id: 'helper-two',
      title: 'Helper Two',
      body: bigFencedBody('TWO'),
      imports: { java: ['com.acme.testutil.HelperTwo'] },
      score: 0.8,
      filePath: '/fake/.github/rag/helper-two.md'
    }
  ];
  const { section, includedMatches } = formatRagPromptSection(matches, 'java');
  // Every included recipe's imports must actually be present — never
  // silently dropped by a later blind slice.
  for (const match of includedMatches) {
    assert.match(section, new RegExp(match.imports!.java![0].replace(/\./g, '\\.')), `expected ${match.id}'s import to survive`);
  }
  // No fence was cut through for whichever recipe(s) made it in — every
  // opening/closing ``` delimiter is paired.
  const fenceCount = (section.match(/```/g) || []).length;
  assert.equal(fenceCount % 2, 0, 'every fence delimiter must be paired — none was cut mid-block');
});

test('formatRagPromptSection caps the TOTAL section size by omitting whole lower-scored recipes, never by slicing through one', () => {
  const matches = Array.from({ length: 5 }, (_, i) => ({
    id: `helper-${i}`,
    title: `Helper ${i}`,
    body: `\`\`\`java\n${'y'.repeat(1_380)}\n\`\`\``, // fenced, under the per-recipe cap on its own
    score: 0.9 - i * 0.01, // strictly descending — helper-0 is the best match
    filePath: `/fake/.github/rag/helper-${i}.md`
  }));
  const { section, includedMatches } = formatRagPromptSection(matches, 'java');
  assert.ok(section.length <= 4_000, `expected the total section to stay within the 4,000-char cap, got ${section.length}`);
  assert.ok(includedMatches.length < matches.length, 'not all 5 could fit — some must be omitted whole');
  assert.ok(includedMatches.length > 0, 'at least the best match should fit');
  // Best-scored matches are kept over lower-scored ones.
  assert.equal(includedMatches[0].id, 'helper-0');
  // Every fence that DID make it into the section is complete (opened and closed).
  const fenceCount = (section.match(/```/g) || []).length;
  assert.equal(fenceCount % 2, 0, 'every fence delimiter must be paired — none was cut mid-block');
});

test('formatRagPromptSection: an unusually long imports list still leaves the total section within cap and every fence intact', () => {
  const manyImports = Array.from({ length: 30 }, (_, i) => `com.acme.testutil.very.long.package.path.HelperClassNumber${i}`);
  const { section, includedMatches } = formatRagPromptSection(
    [
      {
        id: 'a',
        title: 'Helper A',
        body: '```java\nvar row = HelperClassNumber0.queryOne(conn, sql, id);\n```',
        imports: { java: manyImports },
        score: 0.9,
        filePath: '/fake/.github/rag/a.md'
      }
    ],
    'java'
  );
  assert.equal(includedMatches.length, 1);
  assert.ok(section.length <= 4_000, `expected the section to respect the total cap even with a huge imports list, got ${section.length}`);
  const fenceCount = (section.match(/```/g) || []).length;
  assert.equal(fenceCount % 2, 0, 'the fence must remain intact even when the imports list is large');
});

test('formatRagPromptSection: a single recipe whose fenced code alone exceeds the total cap is omitted entirely, not mangled', () => {
  const hugeFencedBody = `\`\`\`java\n${'z'.repeat(5_000)}\n\`\`\``;
  const { section, includedMatches } = formatRagPromptSection(
    [{ id: 'too-big', title: 'Too Big', body: hugeFencedBody, score: 0.9, filePath: '/fake/.github/rag/too-big.md' }],
    'java'
  );
  assert.equal(includedMatches.length, 0);
  assert.doesNotMatch(section, /z{100}/, 'the oversized fenced code must never appear partially in the section');
  assert.ok(section.length <= 4_000);
});

test('formatRagPromptSection leaves a normally-sized recipe body completely untouched', () => {
  const normalBody = '```java\nvar row = PostgresHelper.queryOne(conn, sql, id);\n```';
  const { section } = formatRagPromptSection(
    [{ id: 'a', title: 'Helper A', body: normalBody, score: 0.9, filePath: '/fake/.github/rag/a.md' }],
    'java'
  );
  assert.match(section, /PostgresHelper\.queryOne/);
  assert.doesNotMatch(section, /truncated/);
});

test('formatRagPromptSection shows just the source FILENAME (never the full local path) for each recipe', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'postgres-query-and-validate', title: 'Helper', body: 'code', score: 0.9, filePath: '/Users/dev/project/.github/rag/postgres-query-and-validate.md' }],
    'java'
  );
  assert.match(section, /postgres-query-and-validate\.md/);
  assert.doesNotMatch(section, /\/Users\/dev\/project/);
});

test('formatRagPromptSection instructs the model to add a traceability comment referencing the id and source file', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'postgres-query-and-validate', title: 'Helper', body: 'code', score: 0.9, filePath: '/fake/.github/rag/postgres-query-and-validate.md' }],
    'java'
  );
  assert.match(section, /RAG match:/);
  assert.match(section, /TRACEABILITY/i);
});

test('formatRagPromptSection instructs the model to verify fit before reusing a component, and permits using none — the abstention gate', () => {
  const { section } = formatRagPromptSection(
    [{ id: 'postgres-query-and-validate', title: 'Helper', body: 'code', score: 0.9, filePath: '/fake/.github/rag/postgres-query-and-validate.md' }],
    'java'
  );
  // Retrieval is explicitly framed as unverified — a lexical match, not a
  // confirmed fit — so the model doesn't treat "it was retrieved" as
  // itself sufficient reason to use it.
  assert.match(section, /LEXICAL/);
  assert.match(section, /not verified fits/i);
  // The model is told what to actually check before reusing anything.
  assert.match(section, /operation, parameter types\/order, and preconditions/i);
  // Explicit, unambiguous permission to use none of the listed components.
  assert.match(section, /Using NONE of them is a valid outcome/i);
  // Explicit instruction against forcing a partial/unrelated fit.
  assert.match(section, /never force an\s+unrelated or partially-fitting component/i);
});

test('retrieveRagMatches with the DEFAULT gate reproduces its old behavior exactly — any positive score accepted', async () => {
  const index = await buildRagIndex([POSTGRES_RECIPE, SCREENSHOT_RECIPE]);
  const withoutExplicitConfig = await retrieveRagMatches(index, 'postgres database query table validate', 'java', 'api');
  const withDefaultConfig = await retrieveRagMatches(index, 'postgres database query table validate', 'java', 'api', 2, DEFAULT_RELEVANCE_GATE);
  assert.deepEqual(withoutExplicitConfig, withDefaultConfig);
});

test('retrieveRagMatches: a calibrated gate with a real minLexicalScore floor actually changes what is returned', async () => {
  const index = await buildRagIndex([POSTGRES_RECIPE, SCREENSHOT_RECIPE]);
  const query = 'postgres database query table validate';
  const withDefault = await retrieveRagMatches(index, query, 'java', 'api');
  assert.ok(withDefault.length > 0, 'the default gate should find the obviously-relevant postgres recipe');

  const strictConfig: RelevanceGateConfig = { ...DEFAULT_RELEVANCE_GATE, minLexicalScore: 0.999 };
  const withStrictFloor = await retrieveRagMatches(index, query, 'java', 'api', 2, strictConfig);
  assert.equal(withStrictFloor.length, 0, 'an unreachably high score floor should reject everything, proving the gate is genuinely wired in');
});

test('retrieveRagMatches: requireSymbolEvidence genuinely gates real retrieval output', async () => {
  const index = await buildRagIndex([POSTGRES_RECIPE, SCREENSHOT_RECIPE]);
  // A query about postgres that never mentions any token from either
  // recipe's own id ("postgres-query-and-validate" / "take-screenshot").
  const query = 'login and check a stored value in the persistence layer';
  const config: RelevanceGateConfig = { ...DEFAULT_RELEVANCE_GATE, requireSymbolEvidence: true };
  const withSymbolGate = await retrieveRagMatches(index, query, 'java', 'api', 2, config);
  assert.equal(withSymbolGate.length, 0, 'nothing in the query echoes either recipe\'s own id tokens');
});

// --- A08: freshness eligibility applied BEFORE topK, never merely filtered
// out of an already-truncated result afterward ---------------------------

test('A08: staleFilePaths excludes ineligible candidates BEFORE the topK cut — a fresh candidate takes an excluded one\'s place, the result stays fully populated', async () => {
  // Six recipes sharing enough vocabulary to all score positively for the
  // SAME query — the review's own reproduced shape ("four equally matching
  // recipes, the retrieved top three stale, fourth fresh") widened to six
  // so excluding the top three STILL leaves enough eligible candidates
  // (three) to fully repopulate a topK-3 window — proving REPLENISHMENT,
  // not just "the fresh one is somewhere in whatever's left."
  const recipes = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((name) =>
    makeRecipe({
      id: `helper-${name}`,
      title: `Postgres helper variant ${name}`,
      body: `\`\`\`java\n${name}Helper.queryOne(conn, sql, id);\n\`\`\``,
      tags: ['postgres', 'database', 'query'],
      automationMode: ['api'],
      language: ['java']
    })
  );
  const index = await buildRagIndex(recipes);
  const query = 'postgres database query';

  // Sanity check: with no exclusion at all, a topK of 3 would indeed only
  // ever surface 3 of the 6 — proving this test's setup genuinely exercises
  // the topK cut, not something else.
  const withoutExclusion = await retrieveRagMatches(index, query, 'java', 'api', 3);
  assert.equal(withoutExclusion.length, 3);

  // The three HIGHEST-scoring candidates (whichever they are) are marked
  // stale — deliberately derived from the unfiltered ranking itself, so
  // this test never depends on assuming a particular tie-breaking order.
  const staleFilePaths = new Set(withoutExclusion.map((m) => m.filePath));
  const eligibleRecipes = recipes.filter((r) => !staleFilePaths.has(r.filePath));
  assert.equal(eligibleRecipes.length, 3, 'three recipes must be left un-excluded');

  const withExclusion = await retrieveRagMatches(index, query, 'java', 'api', 3, DEFAULT_RELEVANCE_GATE, staleFilePaths);
  assert.equal(withExclusion.length, 3, 'the result must still be FULLY POPULATED — the eligible candidates take the excluded ones\' place, not just less content overall');
  assert.ok(
    eligibleRecipes.every((r) => withExclusion.some((m) => m.filePath === r.filePath)),
    'EVERY eligible candidate must be retrieved — a post-hoc filter over a topK=3 result could never have surfaced any of them, since none were in that result to begin with'
  );
  assert.ok(
    withExclusion.every((m) => !staleFilePaths.has(m.filePath)),
    'no excluded candidate may appear anywhere in the result'
  );
});

test('A08: staleFilePaths that excludes EVERY matching candidate correctly returns empty, never falls back to including a stale one', async () => {
  const index = await buildRagIndex([POSTGRES_RECIPE, SCREENSHOT_RECIPE]);
  const staleFilePaths = new Set([POSTGRES_RECIPE.filePath]);
  const result = await retrieveRagMatches(index, 'postgres database query table validate', 'java', 'api', 2, DEFAULT_RELEVANCE_GATE, staleFilePaths);
  assert.equal(result.length, 0);
});

test('A08: omitting staleFilePaths excludes nothing — today\'s exact prior behavior, unchanged', async () => {
  const index = await buildRagIndex([POSTGRES_RECIPE, SCREENSHOT_RECIPE]);
  const query = 'postgres database query table validate';
  const withoutParam = await retrieveRagMatches(index, query, 'java', 'api', 2, DEFAULT_RELEVANCE_GATE);
  const withEmptySet = await retrieveRagMatches(index, query, 'java', 'api', 2, DEFAULT_RELEVANCE_GATE, new Set());
  assert.deepEqual(withoutParam, withEmptySet);
});
