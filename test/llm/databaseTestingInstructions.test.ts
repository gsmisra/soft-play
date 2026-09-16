import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * databaseTestingInstructions.ts's own `readFileCachedSync()` call goes
 * through `../cache/fileCache`, which has a top-level `import * as vscode
 * from 'vscode'` — so simply `require()`-ing the compiled module outside a
 * real Extension Host throws `Cannot find module 'vscode'` before any test
 * body even runs. Same `Module._load` interception technique as
 * test/rag/ragCorpusGenerator.cancellation.test.ts: a bare stub for
 * 'vscode' (fileCache's `readFileCachedSync` never actually touches it —
 * only the separate `readWorkspaceFileCached` does, which this module
 * never calls), and a `../cache/fileCache` fake that reads the REAL
 * bundled file from its actual repo-relative path — `__dirname` inside the
 * compiled `out-test/` tree does not sit at the same depth relative to the
 * repo root as the real packaged `out/` tree does, so the production
 * `readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', ...))`
 * call resolves to the wrong location under this test config; using the
 * real content here (rather than a placeholder) exercises the same
 * behavior production actually has.
 */

const REAL_INSTRUCTIONS_PATH = path.join(__dirname, '..', '..', '..', 'prompts', 'database_testing_instructions.md');

const fakeFileCache = {
  readFileCachedSync: () => fs.readFileSync(REAL_INSTRUCTIONS_PATH, 'utf8')
};

function loadDatabaseTestingInstructionsWithFakes(): typeof import('../../src/llm/databaseTestingInstructions') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (id: string, parent: { filename?: string } | undefined, isMain: boolean) {
    if (id === 'vscode') {
      return {};
    }
    if (parent?.filename?.endsWith(path.join('llm', 'databaseTestingInstructions.js')) && id === '../cache/fileCache') {
      return fakeFileCache;
    }
    // eslint-disable-next-line prefer-rest-params
    return originalLoad.apply(this, arguments);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../src/llm/databaseTestingInstructions');
  } finally {
    Module._load = originalLoad;
  }
}

const { mentionsDatabaseTesting, withDatabaseTestingInstructions } = loadDatabaseTestingInstructionsWithFakes();

test('mentionsDatabaseTesting: fires on named database engines', () => {
  assert.equal(mentionsDatabaseTesting('Connect to MongoDB and check the results collection'), true);
  assert.equal(mentionsDatabaseTesting('Write a PostgreSQL query for this'), true);
  assert.equal(mentionsDatabaseTesting('This runs against Oracle DB'), true);
  assert.equal(mentionsDatabaseTesting('Use Cassandra to store the events'), true);
  assert.equal(mentionsDatabaseTesting('The backend is MySQL'), true);
  assert.equal(mentionsDatabaseTesting('We use SQL Server for reporting'), true);
});

test('mentionsDatabaseTesting: fires on generic connect/verify/query + database/table phrasing', () => {
  assert.equal(mentionsDatabaseTesting('Please connect to the database and verify a table'), true);
  assert.equal(mentionsDatabaseTesting('Run a query against the orders table'), true);
  assert.equal(mentionsDatabaseTesting('verify the users table has the right row count'), true);
  assert.equal(mentionsDatabaseTesting('database testing for the orders schema'), true);
  assert.equal(mentionsDatabaseTesting('db testing needed here'), true);
});

test('mentionsDatabaseTesting: does not fire on unrelated UI/API automation text', () => {
  assert.equal(mentionsDatabaseTesting('Click the login button and verify the welcome banner'), false);
  assert.equal(mentionsDatabaseTesting('Add a bearer token to the API request'), false);
  assert.equal(mentionsDatabaseTesting('Generate a feature file for the checkout flow'), false);
  assert.equal(mentionsDatabaseTesting(''), false);
  assert.equal(mentionsDatabaseTesting(undefined), false);
  assert.equal(mentionsDatabaseTesting(null), false);
});

test('withDatabaseTestingInstructions: no-op when no supplied text mentions database testing', () => {
  const instructions = [{ path: 'foo.md', content: 'foo' }];
  const result = withDatabaseTestingInstructions(instructions, 'Click the submit button');
  assert.equal(result, instructions); // same array reference — genuinely a no-op
});

test('withDatabaseTestingInstructions: appends the REAL bundled file when a supplied text mentions database testing', () => {
  const instructions = [{ path: 'foo.md', content: 'foo' }];
  const result = withDatabaseTestingInstructions(instructions, 'Connect to Postgres and verify the orders table');
  assert.equal(result.length, 2);
  assert.equal(result[0], instructions[0]);
  assert.equal(result[1].path, 'database_testing_instructions.md');
  assert.ok(result[1].content.length > 1000, 'expected the real, substantial bundled file content, not a stub');
  for (const engine of ['MongoDB', 'PostgreSQL', 'Oracle', 'Cassandra']) {
    assert.ok(result[1].content.includes(engine), `expected the instructions file to mention ${engine}`);
  }
});

test('withDatabaseTestingInstructions: checks ALL supplied texts, not just the first', () => {
  const result = withDatabaseTestingInstructions<{ path: string; content: string }>([], 'unrelated text', 'now mention MongoDB');
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'database_testing_instructions.md');
});

test('withDatabaseTestingInstructions: never duplicates an already-present entry', () => {
  const instructions = [{ path: 'database_testing_instructions.md', content: 'already here' }];
  const result = withDatabaseTestingInstructions(instructions, 'connect to MongoDB');
  assert.equal(result, instructions);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, 'already here');
});

test('the bundled prompts/database_testing_instructions.md file actually exists and is non-trivial', () => {
  assert.ok(fs.existsSync(REAL_INSTRUCTIONS_PATH), `expected ${REAL_INSTRUCTIONS_PATH} to exist`);
  const content = fs.readFileSync(REAL_INSTRUCTIONS_PATH, 'utf8');
  assert.ok(content.length > 1000, 'expected a substantial instructions file, not a stub');
  for (const engine of ['MongoDB', 'PostgreSQL', 'Oracle', 'Cassandra']) {
    assert.ok(content.includes(engine), `expected the instructions file to mention ${engine}`);
  }
});
