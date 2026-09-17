import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { Language, AutomationMode } from '../settings/settingsStore';

export interface ExecutionResult {
  /** The pass/fail signal "Verify & Fix Code" actually acts on — whether
   * to loop back to the LLM for another fix. UI mode: a genuine headless
   * run passing (or, for BDD-mode Java with no generated runner, a clean
   * compile). API mode: compiling/parsing cleanly ALONE, regardless of
   * whether the live API call itself succeeded — see `apiCallOutcome`. */
  success: boolean;
  /** True when `success` reflects a compile/collect-only check rather than
   * an actual run — see the module doc comment below for exactly when and
   * why (BDD-mode Java always; BDD-mode Python only if it can't resolve
   * its feature file; every API-mode result whose live call didn't run). */
  compileOnly: boolean;
  /** API mode only — the live API call's own outcome, entirely separate
   * from `success`: a real HTTP error response (or connection failure) is
   * NOT a code bug and must never drive another fix-loop iteration, per
   * the explicit ask — it's reported to the user as "code is correct, the
   * API itself responded with an error, recheck the endpoint/credentials".
   * 'not-run' when compilation/syntax already failed (nothing to call) or
   * this was a BDD/UI-mode result where this concept doesn't apply. */
  apiCallOutcome: 'passed' | 'failed' | 'not-run';
  /** API mode only — the actual, observed HTTP status code(s) of every live
   * call the generated code made this run, in the order they happened.
   * Captured independently of whatever `.statusCode(...)`/
   * `assert response.status_code == ...` the generated code itself
   * contains (see `injectJavaHttpStatusCapture()`/the Python conftest.py
   * helper below) — per the explicit ask, ANY real status code is reported
   * to the user as-is, never characterized as a pass or a fail. Always
   * empty for UI mode, and for any API-mode result whose live call never
   * ran (a compile/syntax failure, or a BDD-mode Java result — see
   * `apiCallOutcome`'s own doc comment for when that applies). */
  httpStatusCodes: number[];
  /** Combined stdout+stderr, tail-trimmed to a size sane to hand to an LLM. */
  output: string;
}

const MAX_OUTPUT_CHARS = 6000;

/** A unique, greppable marker printed by the status-capture hooks below
 * (`injectJavaHttpStatusCapture()`, `pythonHttpStatusCaptureConftest()`) —
 * chosen specifically so it can never collide with ordinary compiler/test-
 * runner output, and read back by `extractHttpStatusCodes()` the same way
 * for both languages. */
const HTTP_STATUS_MARKER = 'SOFTPLAY_HTTP_STATUS:';
/** The status-capture hooks (`injectJavaHttpStatusCapture()`, the Python
 * conftest.py helper) write to a dedicated file rather than stdout — see
 * `readHttpStatusLog()`'s doc comment for exactly why stdout can't be
 * trusted for this. Written into the scratch project root, one directory
 * up from Java's `src/test/java` sources, alongside Python's own scratch
 * test file. */
const HTTP_STATUS_LOG_FILENAME = 'softplay_http_status.log';
// `(?!\d)` stops a genuine 3-digit status code from ever being read off the
// front of some unrelated longer number that happens to follow the marker.
const HTTP_STATUS_PATTERN = new RegExp(`${HTTP_STATUS_MARKER}(\\d{3})(?!\\d)`, 'g');

/** Scans arbitrary text for every status code a capture hook logged, in the
 * order they occurred — see `ExecutionResult.httpStatusCodes`. Exported and
 * kept as a pure function purely so it stays directly unit-testable; real
 * callers only ever feed it `readHttpStatusLog()`'s file content. */
export function extractHttpStatusCodes(output: string): number[] {
  const codes: number[] = [];
  for (const match of output.matchAll(HTTP_STATUS_PATTERN)) {
    codes.push(Number(match[1]));
  }
  return codes;
}

/**
 * Reads back whatever `injectJavaHttpStatusCapture()`/the Python
 * conftest.py helper actually logged for this run — deliberately a
 * dedicated file, never the test runner's own stdout. Confirmed by real,
 * live end-to-end execution (not just a unit test) that this matters: by
 * default, **pytest silently drops a PASSING test's captured stdout from
 * its own report** (`Captured stdout call` is only ever shown for a
 * FAILING test) — exactly the common, expected case (the generated code's
 * own assertion matches reality) is precisely the case a stdout-based
 * marker would have gone missing for. Writing to this file from inside the
 * capture hook itself, independent of either runner's console/capture
 * behavior, is the only way to reliably observe every live call regardless
 * of whether the generated code's own assertion passed or failed. A
 * missing file (no live call was ever made — a compile/syntax failure, or
 * code that never actually calls out) is not an error — resolves to `[]`.
 */
async function readHttpStatusLog(logFilePath: string): Promise<number[]> {
  try {
    const content = await fs.promises.readFile(logFilePath, 'utf8');
    return extractHttpStatusCodes(content);
  } catch {
    return [];
  }
}

/** Backslashes and double-quotes are the only characters that matter inside
 * a Java double-quoted string literal for a Windows absolute path (e.g.
 * `C:\Users\...`) — this is deliberately narrow (a real file-system path
 * from `path.join()`, never arbitrary/attacker-controlled text). */
function escapeForJavaStringLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// `shell` defaults to false and is passed `true` only for `mvn` calls — see
// environmentCheck.ts's `run()` for the full rationale (mvn resolves to a
// `.cmd` launcher on Windows that plain execFile can't locate at all;
// python/pytest calls stay shell:false since none of their own args here
// contain spaces either, and false is the safer default regardless).
function run(
  command: string,
  args: string[],
  cwd: string,
  shell = false,
  extraEnv?: Record<string, string>
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // `env` omitted (undefined) preserves the exact prior behavior — plain
    // inheritance of the extension host's own environment — for every
    // caller that doesn't pass extraEnv; only "Verify & Fix Code" passes it
    // (see executeGeneratedCode()'s secretEnv param), to hand the AI
    // generated code's own SecretVault.decrypt()/decrypt_secret() calls the
    // SoftPlay_SECRET_KEY they need (see security/secretVault.ts).
    const env = extraEnv ? { ...process.env, ...extraEnv } : undefined;
    execFile(command, args, { cwd, windowsHide: true, timeout: 180_000, maxBuffer: 20 * 1024 * 1024, shell, env }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, output });
    });
  });
}

function tailOutput(output: string): string {
  return output.length > MAX_OUTPUT_CHARS ? `…(truncated)…\n${output.slice(-MAX_OUTPUT_CHARS)}` : output;
}

/**
 * Executes AI-generated code in a disposable scratch project (never the
 * user's own workspace) and reports whether it's correct.
 *
 * **UI mode**: "correct" means a genuine headless Playwright run passing —
 * see the BDD-mode caveat below for the one exception.
 *
 * **API mode**: "correct" means the code compiles/parses cleanly — a real
 * HTTP error response from the live API call it then attempts is reported
 * separately (`apiCallOutcome`) and never fails `success`, per the explicit
 * ask: a genuine API-side error (wrong credentials, endpoint down, etc.) is
 * not a code bug, so it must never drive another LLM fix-loop iteration.
 * The actual status code(s) observed are reported too (`httpStatusCodes`),
 * captured independently of the generated code's own assertions — see
 * `injectJavaHttpStatusCapture()` and the Python `conftest.py` helper below.
 *
 * **BDD-mode caveat** (a linked scenario was used — see "Execute & Verify
 * Code"'s design notes in objectSpyPanel.ts): the generated code is ONLY
 * step definitions (per prompts/senior-qe-instructions.md section 5 /
 * prompts/api-automation-instructions.md section 7) — there is no separate
 * Cucumber "Suite" runner class generated, so **Java** BDD-mode code can
 * only ever be compile-checked here (`mvn test-compile`), never actually
 * executed end to end, in EITHER mode. **Python** BDD-mode (pytest-bdd)
 * needs no separate runner — its `@scenario(...)`/`scenarios(...)` bind
 * directly to a real pytest test — so it DOES get a real execution attempt,
 * with the originally linked .feature file copied into the scratch dir
 * (best-effort, under both the plain filename and a `features/` subfolder,
 * covering the two conventions the LLM is likely to have referenced it by);
 * if neither matches whatever path the generated code actually references,
 * that failure becomes real, useful feedback for the fix-loop to correct.
 */
export async function executeGeneratedCode(
  language: Language,
  code: string,
  scratchDir: string,
  linkedFeatureFilePath: string | undefined,
  pythonCommand: string,
  automationMode: AutomationMode,
  resourcesRoot?: string,
  /** SoftPlay_SECRET_KEY (see security/secretVault.ts), handed to the child
   * process's environment so the generated code's own SecretVault.decrypt()
   * / decrypt_secret() call — present whenever "Auto Password Encryption"
   * encrypted at least one credential into the code — can actually resolve
   * the real value at run time. Harmless to always pass: unused entirely by
   * code that contains no encrypted values. */
  secretEnv?: Record<string, string>,
  /** The user's Settings selection (`LANGUAGE_VERSIONS.java`, e.g. "11" /
   * "17" / "21") — Java only; ignored for Python, whose interpreter
   * (`pythonCommand`) is already resolved to the correct version-specific
   * executable BEFORE this is ever called (see environmentCheck.ts's
   * `resolvePythonInterpreterForVersion()`), so there is no separate
   * "target version" concept to apply at execution time the way Java's
   * compiler needs one. Defaults to '17' only so an existing caller that
   * never passes this (there should be none left after this fix) keeps
   * its previous exact behavior rather than breaking outright. */
  languageVersion = '17'
): Promise<ExecutionResult> {
  return language === 'java'
    ? executeJava(code, scratchDir, automationMode, resourcesRoot, secretEnv, languageVersion)
    : executePython(code, scratchDir, linkedFeatureFilePath, pythonCommand, automationMode, secretEnv);
}

function isBddCode(code: string): boolean {
  return /io\.cucumber|pytest_bdd|@(Given|When|Then)\(|@(given|when|then)\(/.test(code);
}

// ---------------------------------------------------------------------------
// Java (Maven)
// ---------------------------------------------------------------------------

const PLAYWRIGHT_JAVA_VERSION = '1.62.0';
const REST_ASSURED_VERSION = '5.5.0';
const JUNIT_JUPITER_VERSION = '5.11.0';
const SLF4J_VERSION = '2.0.13';
const CUCUMBER_VERSION = '7.18.0';
const JUNIT_PLATFORM_SUITE_VERSION = '1.11.0';
const SUREFIRE_PLUGIN_VERSION = '3.2.5';
/** The ONLY version of `maven-compiler-plugin` actually vendored in
 * `resources/java/m2repo` (see that folder's own README) — explicitly
 * pinned in the generated pom (see `javaPomXml()` below) rather than left
 * to Maven's own environment-dependent default-plugin-binding resolution,
 * which is exactly what caused a real, reported failure: on a locked-down
 * machine with no Maven Central egress, Maven silently fell back to
 * whatever its own defaults resolved to given only this bundled repo —
 * this SAME 3.1 — but with NOTHING in the pom pinning it explicitly, that
 * was an accident of environment rather than a guarantee. Deliberately
 * this old (pre-`maven.compiler.release`-support) version, not a newer
 * one — see `javaPomXml()`'s own doc comment on why `source`/`target`
 * (not `release`) are used for exactly this reason. */
const COMPILER_PLUGIN_VERSION = '3.1';

/**
 * Playwright Java's own "driver-bundle" dependency ships Node.js binaries
 * for EVERY supported OS combined into one ~200MB jar (Playwright's Java
 * bindings shell out to a bundled Node.js process — that's the actual
 * driver; "driver-bundle" is just Node itself). Bundling that whole thing
 * would dwarf everything else in resources/java/m2repo, so instead this
 * extension excludes it and ships ONE plain, official Node.js Windows
 * binary instead (resources/java/node-win-x64/node.exe, ~70MB, see
 * resources/java/README.md) — Playwright Java reads `PLAYWRIGHT_NODEJS_PATH`
 * to use exactly that instead of hunting for its own bundled one, which is
 * both smaller and avoids needing driver-bundle in the repo at all. Windows-
 * only for now (matches this extension's existing Windows-only scope, e.g.
 * the Program Files/LOCALAPPDATA executable-path resolution codegenManager.ts
 * injects into generated code) — falls back to leaving
 * Playwright's dependency untouched (its own driver-bundle download) on any
 * other OS/if the bundled node.exe isn't found, e.g. a dev checkout that
 * hasn't run the resources prep step.
 */
function bundledNodeExePath(resourcesRoot: string | undefined): string | undefined {
  if (!resourcesRoot || process.platform !== 'win32') return undefined;
  const nodeExe = path.join(resourcesRoot, 'resources', 'java', 'node-win-x64', 'node.exe');
  return fs.existsSync(nodeExe) ? nodeExe : undefined;
}

export function javaPomXml(bdd: boolean, automationMode: AutomationMode, resourcesRoot: string | undefined, languageVersion: string): string {
  const cucumberDeps = bdd
    ? `
    <dependency>
      <groupId>io.cucumber</groupId>
      <artifactId>cucumber-java</artifactId>
      <version>${CUCUMBER_VERSION}</version>
    </dependency>
    <dependency>
      <groupId>io.cucumber</groupId>
      <artifactId>cucumber-junit-platform-engine</artifactId>
      <version>${CUCUMBER_VERSION}</version>
    </dependency>
    <dependency>
      <groupId>org.junit.platform</groupId>
      <artifactId>junit-platform-suite</artifactId>
      <version>${JUNIT_PLATFORM_SUITE_VERSION}</version>
    </dependency>`
    : '';
  // API mode's generated code uses REST Assured, never Playwright (no
  // browser is ever involved); UI mode is the reverse — declaring only
  // what's actually needed keeps the scratch build lean. See
  // bundledNodeExePath()'s doc comment for why the exclusion is conditional.
  const bundledNode = automationMode === 'ui' ? bundledNodeExePath(resourcesRoot) : undefined;
  const primaryDep =
    automationMode === 'api'
      ? `
    <dependency>
      <groupId>io.rest-assured</groupId>
      <artifactId>rest-assured</artifactId>
      <version>${REST_ASSURED_VERSION}</version>
    </dependency>`
      : `
    <dependency>
      <groupId>com.microsoft.playwright</groupId>
      <artifactId>playwright</artifactId>
      <version>${PLAYWRIGHT_JAVA_VERSION}</version>${
          bundledNode
            ? `
      <exclusions>
        <exclusion>
          <groupId>com.microsoft.playwright</groupId>
          <artifactId>driver-bundle</artifactId>
        </exclusion>
      </exclusions>`
            : ''
        }
    </dependency>`;
  const surefireConfig = bundledNode
    ? `
        <configuration>
          <environmentVariables>
            <PLAYWRIGHT_NODEJS_PATH>${bundledNode}</PLAYWRIGHT_NODEJS_PATH>
          </environmentVariables>
        </configuration>`
    : '';
  return `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.SoftPlay.runner</groupId>
  <artifactId>SoftPlay-runner</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.source>${languageVersion}</maven.compiler.source>
    <maven.compiler.target>${languageVersion}</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>${primaryDep}
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>${JUNIT_JUPITER_VERSION}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-simple</artifactId>
      <version>${SLF4J_VERSION}</version>
    </dependency>${cucumberDeps}
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>${COMPILER_PLUGIN_VERSION}</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>${SUREFIRE_PLUGIN_VERSION}</version>${surefireConfig}
      </plugin>
    </plugins>
  </build>
</project>
`;
}

/**
 * "-Dmaven.repo.local=..." pointed at the extension's own bundled Maven
 * repository (resources/java/m2repo — REST Assured, Playwright (minus its
 * driver-bundle, see bundledNodeExePath()), JUnit Jupiter, SLF4J, and
 * Cucumber's own jars, pre-resolved and shipped inside the .vsix; see
 * resources/java/README.md for how that folder is populated), so a bank/
 * enterprise machine with no Maven Central egress can still run "Verify &
 * Fix Code" for both UI and API Automation entirely offline. This is a
 * local-repo LOCATION override, not `-o`/offline mode — Maven still reaches
 * out to its normally configured repositories for anything not already
 * cached there, so nothing breaks if some other dependency is ever needed.
 * Omitted entirely if the bundled repo isn't present (e.g. a dev checkout that
 * hasn't run the resources prep step) — falls back to Maven's own default
 * local repo exactly as before.
 */
function bundledMavenRepoArgs(resourcesRoot: string | undefined): string[] {
  if (!resourcesRoot) return [];
  const bundledRepo = path.join(resourcesRoot, 'resources', 'java', 'm2repo');
  return fs.existsSync(bundledRepo) ? [`-Dmaven.repo.local=${bundledRepo}`] : [];
}

/**
 * API mode only: registers a REST Assured filter — via `RestAssured.filters(...)`,
 * a global, one-time hook on the static DSL entry point every `given()` call
 * goes through — that logs the actual HTTP status code of every live call
 * the generated code makes, completely independently of whatever
 * `.statusCode(...)` assertion (or lack of one) the generated code itself
 * contains. That independence is the whole point: per the explicit ask, the
 * user is told the real status code regardless of whether the generated
 * code's own assertion happens to match it. Inserted right after the
 * class's own opening brace (found via the same `public class` shape
 * `executeJava()` already parses for the class name) so the static
 * initializer runs before any test method — using fully-qualified REST
 * Assured/`java.nio.file` type names throughout so this never collides
 * with, or depends on, whatever the generated code itself imports.
 *
 * Appends to `httpStatusLogPath` directly (see `readHttpStatusLog()`'s doc
 * comment for why a file, not `System.out.println`) — `httpStatusLogPath`
 * is this session's own scratch directory, an absolute path this code
 * generated, never attacker/LLM-controlled text.
 */
export function injectJavaHttpStatusCapture(code: string, httpStatusLogPath: string): string {
  const classDeclMatch = code.match(/public\s+class\s+\w+[^{]*\{/);
  if (!classDeclMatch || classDeclMatch.index === undefined) {
    return code;
  }
  const insertAt = classDeclMatch.index + classDeclMatch[0].length;
  const escapedLogPath = escapeForJavaStringLiteral(httpStatusLogPath);
  const filterBlock = `
  static {
    io.restassured.RestAssured.filters((io.restassured.specification.FilterableRequestSpecification softPlayReq,
        io.restassured.specification.FilterableResponseSpecification softPlayResSpec,
        io.restassured.filter.FilterContext softPlayCtx) -> {
      io.restassured.response.Response softPlayResponse = softPlayCtx.next(softPlayReq, softPlayResSpec);
      try {
        java.nio.file.Files.write(
            java.nio.file.Paths.get("${escapedLogPath}"),
            ("${HTTP_STATUS_MARKER}" + softPlayResponse.getStatusCode() + System.lineSeparator()).getBytes(java.nio.charset.StandardCharsets.UTF_8),
            java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
      } catch (java.io.IOException softPlayIoException) {
        // Best-effort logging only — never let it break the actual test.
      }
      return softPlayResponse;
    });
  }
`;
  return code.slice(0, insertAt) + filterBlock + code.slice(insertAt);
}

async function executeJava(
  code: string,
  scratchDir: string,
  automationMode: AutomationMode,
  resourcesRoot: string | undefined,
  secretEnv: Record<string, string> | undefined,
  languageVersion: string
): Promise<ExecutionResult> {
  const classMatch = code.match(/public\s+class\s+(\w+)/);
  if (!classMatch) {
    return {
      success: false,
      compileOnly: false,
      apiCallOutcome: 'not-run',
      httpStatusCodes: [],
      output: 'Could not find a "public class <Name>" declaration in the generated Java code.'
    };
  }
  const className = classMatch[1];
  const bdd = isBddCode(code);
  const httpStatusLogPath = path.join(scratchDir, HTTP_STATUS_LOG_FILENAME);
  // Harmless to apply even for a BDD-mode result (compile-only, never
  // actually run below — see the `bdd` branch) or one that ultimately
  // fails to compile: it only ever adds one static initializer that
  // references classes already on the classpath for any API-mode build.
  const codeToWrite = automationMode === 'api' ? injectJavaHttpStatusCapture(code, httpStatusLogPath) : code;
  // Cleared up front so a stale log from an earlier "Verify & Fix Code"
  // attempt reusing this same scratch directory can never leak into THIS
  // attempt's result — mirrors the ".java file cleanup right below.
  await fs.promises.rm(httpStatusLogPath, { force: true });

  const srcDir = path.join(scratchDir, 'src', 'test', 'java');
  await fs.promises.mkdir(srcDir, { recursive: true });
  // Clear any previous run's class(es) — a stale second .java file (a
  // different class name from a prior attempt) would otherwise sit there
  // and either fail to compile against this run's code or get picked up by
  // `mvn test` alongside it.
  for (const entry of await fs.promises.readdir(srcDir).catch(() => [] as string[])) {
    if (entry.endsWith('.java')) {
      await fs.promises.rm(path.join(srcDir, entry), { force: true });
    }
  }
  await fs.promises.writeFile(path.join(srcDir, `${className}.java`), codeToWrite, 'utf8');
  await fs.promises.writeFile(path.join(scratchDir, 'pom.xml'), javaPomXml(bdd, automationMode, resourcesRoot, languageVersion), 'utf8');

  // Compile is always checked first and on its own — the ONLY signal that
  // ever drives another fix-loop iteration in API mode (see this module's
  // doc comment); UI mode still needs the real `mvn test` run below to
  // know whether the headless browser flow actually passed.
  const repoArgs = bundledMavenRepoArgs(resourcesRoot);
  const compileResult = await run('mvn', ['-q', '-B', '-Dstyle.color=never', ...repoArgs, 'test-compile'], scratchDir, true, secretEnv);
  if (compileResult.code !== 0) {
    return { success: false, compileOnly: false, apiCallOutcome: 'not-run', httpStatusCodes: [], output: tailOutput(compileResult.output) };
  }
  if (bdd) {
    // No generated Suite runner to actually execute against, in either
    // mode — compiling is the whole check (see doc comment above).
    return { success: true, compileOnly: true, apiCallOutcome: 'not-run', httpStatusCodes: [], output: tailOutput(compileResult.output) };
  }

  const testResult = await run('mvn', ['-q', '-B', '-Dstyle.color=never', ...repoArgs, `-Dtest=${className}`, 'test'], scratchDir, true, secretEnv);
  const combinedOutput = tailOutput(`${compileResult.output}\n${testResult.output}`);
  if (automationMode === 'api') {
    // Compiling cleanly already satisfies "success" here — the live API
    // call's own pass/fail is informational only (apiCallOutcome), per the
    // explicit ask that a real API-side error never drive another fix.
    return {
      success: true,
      compileOnly: false,
      apiCallOutcome: testResult.code === 0 ? 'passed' : 'failed',
      httpStatusCodes: await readHttpStatusLog(httpStatusLogPath),
      output: combinedOutput
    };
  }
  return { success: testResult.code === 0, compileOnly: false, apiCallOutcome: 'not-run', httpStatusCodes: [], output: combinedOutput };
}

// ---------------------------------------------------------------------------
// Python (pytest)
// ---------------------------------------------------------------------------

const SCRATCH_PY_FILENAME = 'test_ai_generated.py';
const CONFTEST_FILENAME = 'conftest.py';

/**
 * API mode only: pytest automatically imports every `conftest.py` in a
 * test's directory before collecting/running anything there, with no
 * import needed in the test file itself — the Python analogue of
 * `injectJavaHttpStatusCapture()`'s static initializer, but without any of
 * that approach's "where in the file is it safe to insert code" concerns
 * (a Python module's own leading shebang/encoding declaration/docstring/
 * `from __future__ import` statements are never touched, since this file
 * is entirely separate). Monkey-patches `requests.Session.send` — the one
 * method EVERY `requests` call funnels through underneath, whether the
 * generated code used `requests.get(...)` directly or built its own
 * `requests.Session()` — so the actual HTTP status code of every live call
 * is observed regardless of what assertion (or lack of one) the generated
 * code itself makes against it.
 *
 * Appends to `httpStatusLogPath` directly rather than printing — see
 * `readHttpStatusLog()`'s doc comment: confirmed by real end-to-end
 * execution that pytest's default output capturing silently DISCARDS a
 * PASSING test's captured stdout from its own report, which is exactly the
 * common case (a matching assertion) a print-based marker would have gone
 * missing for.
 */
function pythonHttpStatusCaptureConftest(httpStatusLogPath: string): string {
  const escapedLogPath = httpStatusLogPath.replace(/\\/g, '\\\\');
  return `import requests as _softplay_requests

_softplay_original_send = _softplay_requests.Session.send


def _softplay_patched_send(self, request, **kwargs):
    response = _softplay_original_send(self, request, **kwargs)
    try:
        with open("${escapedLogPath}", "a", encoding="utf-8") as _softplay_log:
            _softplay_log.write(f"${HTTP_STATUS_MARKER}{response.status_code}\\n")
    except OSError:
        pass
    return response


_softplay_requests.Session.send = _softplay_patched_send
`;
}

async function executePython(
  code: string,
  scratchDir: string,
  linkedFeatureFilePath: string | undefined,
  pythonCommand: string,
  automationMode: AutomationMode,
  secretEnv?: Record<string, string>
): Promise<ExecutionResult> {
  await fs.promises.mkdir(scratchDir, { recursive: true });
  const scratchFile = path.join(scratchDir, SCRATCH_PY_FILENAME);
  await fs.promises.writeFile(scratchFile, code, 'utf8');
  const httpStatusLogPath = path.join(scratchDir, HTTP_STATUS_LOG_FILENAME);
  // Kept in sync with the CURRENT automationMode every run — a stale
  // conftest.py from an earlier API-mode attempt in the same scratch dir
  // must not silently keep patching requests.Session once the mode changes.
  // The log itself is also cleared up front so a PREVIOUS attempt's status
  // codes (reusing this same scratch dir) never leak into this attempt's
  // result.
  const conftestPath = path.join(scratchDir, CONFTEST_FILENAME);
  await fs.promises.rm(httpStatusLogPath, { force: true });
  if (automationMode === 'api') {
    await fs.promises.writeFile(conftestPath, pythonHttpStatusCaptureConftest(httpStatusLogPath), 'utf8');
  } else {
    await fs.promises.rm(conftestPath, { force: true });
  }

  if (linkedFeatureFilePath) {
    try {
      const featureContent = await fs.promises.readFile(linkedFeatureFilePath, 'utf8');
      const baseName = path.basename(linkedFeatureFilePath);
      // Best-effort: cover both conventions a `@scenario('...')`/
      // `scenarios('...')` reference is likely to use (bare filename, or
      // under a "features/" subfolder) — see the module doc comment above.
      await fs.promises.writeFile(path.join(scratchDir, baseName), featureContent, 'utf8');
      const featuresDir = path.join(scratchDir, 'features');
      await fs.promises.mkdir(featuresDir, { recursive: true });
      await fs.promises.writeFile(path.join(featuresDir, baseName), featureContent, 'utf8');
    } catch {
      // Linked file vanished/moved since it was linked — proceed without
      // it; a pytest-bdd FileNotFoundError becomes real fix-loop feedback.
    }
  }

  // Syntax-only check first — `py_compile` never imports/executes the
  // module, so it can't catch a missing dependency or a runtime API error,
  // only a genuine syntax error. That's exactly the "success" bar for API
  // mode (see this module's doc comment); UI mode still needs the real
  // pytest run below regardless, since compiling cleanly says nothing
  // about whether the headless browser flow actually passed.
  const compileResult = await run(pythonCommand, ['-m', 'py_compile', scratchFile], scratchDir);
  if (compileResult.code !== 0) {
    return { success: false, compileOnly: false, apiCallOutcome: 'not-run', httpStatusCodes: [], output: tailOutput(compileResult.output) };
  }

  // Headless by default (pytest-playwright only switches to headed with an
  // explicit --headed flag, which is never passed here) — belt-and-braces
  // on top of whatever `headless` value the generated code's own
  // `browser_type_launch_args` override sets. API mode has no browser
  // involved at all, so this flag is simply inert there.
  const testResult = await run(pythonCommand, ['-m', 'pytest', SCRATCH_PY_FILENAME, '-q'], scratchDir, false, secretEnv);
  const combinedOutput = tailOutput(testResult.output);
  if (automationMode === 'api') {
    return {
      success: true,
      compileOnly: false,
      apiCallOutcome: testResult.code === 0 ? 'passed' : 'failed',
      httpStatusCodes: await readHttpStatusLog(httpStatusLogPath),
      output: combinedOutput
    };
  }
  return { success: testResult.code === 0, compileOnly: false, apiCallOutcome: 'not-run', httpStatusCodes: [], output: combinedOutput };
}
