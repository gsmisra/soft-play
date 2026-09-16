import * as path from 'path';
import { readFileCachedSync } from '../cache/fileCache';

/**
 * Deterministic, regex-based database-testing intent detector — same
 * "aggressive by design" posture as secretVault.ts's own
 * `looksLikeSecretField()`/`SECRET_FIELD_PATTERN`: a false positive here
 * just means `database_testing_instructions.md` (prompts/database_testing_instructions.md)
 * gets included in the prompt when it wasn't strictly needed, which is
 * harmless — never an extra LLM call, never a behavior change beyond a
 * larger prompt. A false negative just means the user gets normal
 * behavior with no database-specific guidance, same as before this
 * feature existed. Matches either a named database engine/technology, or
 * a generic "connect/verify/query a database or table" phrasing.
 */
export const DATABASE_TESTING_PATTERN =
  /\b(mongodb|mongo\s*db|postgres(?:ql)?|oracle\s*db|cassandra|cql|mysql|maria\s*db|sql\s*server|mssql|sqlite|jdbc|nosql|dynamodb|dynamo\s*db)\b|\bdatabase\s*test(?:ing)?\b|\bdb\s*test(?:ing)?\b|\b(?:connect(?:ing|ion)?|query|querying|verify|verif(?:y|ies|ication))\b[^.\n]{0,40}\b(database|db|table|tables|schema|keyspace|collection|stored\s*procedure)\b|\b(database|db|table|tables|schema|keyspace|collection)\b[^.\n]{0,40}\b(connect(?:ing|ion)?|quer(?:y|ies|ying)|verify|verif(?:y|ies|ication))\b/i;

/** See `DATABASE_TESTING_PATTERN`'s own doc comment. */
export function mentionsDatabaseTesting(text: string | undefined | null): boolean {
  return !!text && DATABASE_TESTING_PATTERN.test(text);
}

const DATABASE_TESTING_INSTRUCTIONS_PATH = 'database_testing_instructions.md';

/** Same pattern as readSeniorQeInstructions()/readApiAutomationInstructions()
 * (objectSpyPanel.ts) — a bundled prompts/*.md file, cached by mtime via
 * cache/fileCache.ts. */
function readDatabaseTestingInstructions(): string {
  return readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', DATABASE_TESTING_INSTRUCTIONS_PATH));
}

/**
 * Conditionally appends `database_testing_instructions.md` to an existing
 * `{path, content}[]` project-instructions array — the SAME shape/rendering
 * both Standard mode (objectSpyPanel.ts's `buildLlmPrompt`/`buildApiLlmPrompt`)
 * and Total Agentic Mode (agenticModeController.ts's `buildSystemInstructions`)
 * already use for checked Custom .github/*.md files, so this reuses 100% of
 * the existing prompt-rendering logic with zero new formatting code.
 *
 * Fires when ANY of `texts` (typically the "Instant instructions to LLM"
 * chat-box content, and/or the checked custom-instruction files' own text)
 * mentions database testing per `mentionsDatabaseTesting()`. Never adds a
 * duplicate entry if one is already present (e.g. a project's own checked
 * .github/database_testing_instructions.md).
 */
export function withDatabaseTestingInstructions<T extends { path: string; content: string }>(
  instructions: T[],
  ...texts: (string | undefined | null)[]
): T[] {
  if (instructions.some((f) => f.path === DATABASE_TESTING_INSTRUCTIONS_PATH)) {
    return instructions;
  }
  if (!texts.some((t) => mentionsDatabaseTesting(t))) {
    return instructions;
  }
  return [...instructions, { path: DATABASE_TESTING_INSTRUCTIONS_PATH, content: readDatabaseTestingInstructions() } as T];
}
