import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AutomationMode, Language } from '../settings/settingsStore';
import { TtlCache } from '../cache/ttlCache';

/**
 * Caches the outcome of the Java/Maven/Python(+package) environment probe —
 * local in-memory only, keyed per (language, mode, ...) combination. These
 * checks are pure `execFile` round-trips (java -version, mvn -version,
 * python -c "import X", ...) that answer a question which is true for
 * minutes/hours at a time in practice ("is the JDK on PATH", "is playwright
 * importable"), so re-running the full probe on every single "Verify & Fix"
 * click is wasted process-spawn overhead for an answer that hasn't changed.
 *
 * Success and failure get different TTLs on purpose: a passing result is
 * cached longer (SUCCESS_TTL_MS) since a working toolchain rarely stops
 * working mid-session, while a failing result expires quickly
 * (FAILURE_TTL_MS) so a user who just installed the missing JDK/package and
 * clicks "Verify & Fix Code" again isn't stuck looking at a stale failure.
 */
const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 15_000;
const environmentCheckCache = new TtlCache<string, EnvironmentCheckResult & { pythonCommand?: string }>(20);

function cached(
  key: string,
  compute: () => Promise<EnvironmentCheckResult & { pythonCommand?: string }>
): Promise<EnvironmentCheckResult & { pythonCommand?: string }> {
  const hit = environmentCheckCache.get(key);
  if (hit) {
    return Promise.resolve(hit);
  }
  return compute().then((result) => {
    environmentCheckCache.set(key, result, result.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS);
    return result;
  });
}

/** Forces the next environment check (of any kind) to re-probe instead of
 * serving a cached result — not currently wired to a command, exposed for
 * an explicit "recheck" affordance and for tests. */
export function clearEnvironmentCheckCache(): void {
  environmentCheckCache.clear();
}

export interface EnvironmentCheckResult {
  ok: boolean;
  /** Human-readable summary for the Output channel / an error message —
   * either "all good" detail or exactly what's missing and how to fix it. */
  message: string;
}

/** Runs `command args...` and resolves with its combined stdout+stderr and
 * exit code — never rejects (a missing executable is a normal, expected
 * outcome here, not an exceptional one), so callers can just branch on
 * `code`.
 *
 * `shell` defaults to false (plain `execFile`, args passed through exactly
 * as given — required for `python -c "import x"`-style checks, since
 * `execFile`'s shell mode does NOT reliably re-quote an argument containing
 * spaces on Windows: verified it actually splits "import playwright" into
 * two separate argv entries at the cmd.exe level, breaking `-c`). Pass
 * `shell: true` only for a command that specifically needs it — `mvn`
 * resolves to a `.cmd`/`.bat` launcher on Windows, which plain `execFile`
 * cannot locate at all (Windows `CreateProcess` needs an exact executable,
 * no PATHEXT resolution, unless a shell does that resolution first); none
 * of the args `mvn` is ever called with here contain spaces, so shell mode
 * never hits the quoting problem above for it. */
function run(
  command: string,
  args: string[],
  cwd?: string,
  shell = false,
  timeoutMs = 30_000
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, windowsHide: true, timeout: timeoutMs, shell }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      // execFile's `error` for a plain non-zero exit still carries a
      // `.code` (the process's own exit code) — only fall back to -1 for a
      // genuine spawn failure (command not found, permissions, etc.).
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, output });
    });
  });
}

/** Extracts the JDK's own MAJOR version number from `java -version`'s
 * output (always printed to stderr, which `run()` already folds into
 * `output`) — handles both the modern single-number scheme (Java 9+, e.g.
 * `java version "17.0.9" ...` / `openjdk version "21.0.1" ...` -> 17 / 21)
 * and the legacy `1.x` scheme (Java 8 and earlier, e.g. `java version
 * "1.8.0_281"` -> 8, where the real major version is the SECOND
 * component). `undefined` if the output doesn't contain a recognizable
 * version string at all (a genuinely unexpected `java -version` output —
 * treated as "can't verify," never as a silent pass). */
export function parseJavaMajorVersion(versionOutput: string): number | undefined {
  const match = versionOutput.match(/version\s+"(\d+)(?:\.(\d+))?/);
  if (!match) {
    return undefined;
  }
  const first = parseInt(match[1], 10);
  return first === 1 && match[2] ? parseInt(match[2], 10) : first;
}

/**
 * "Take necessary steps beforehand to assert all the necessary Maven, Java
 * and other environmental parameters are in place" — verifies `java` and
 * `mvn` are both on PATH, report their versions, AND that the installed
 * JDK's own major version is actually new enough to compile/run for
 * `languageVersion` (the user's Settings selection — see
 * `LANGUAGE_VERSIONS.java` in settingsStore.ts, currently `['11','17','21']`)
 * — without installing or modifying anything: an enterprise/bank
 * environment is not somewhere this extension should silently mutate.
 *
 * The version check matters because `javac`/Maven's `maven.compiler.release`
 * can target any release UP TO the running JDK's own major version, never
 * a NEWER one — a JDK 11 installation genuinely cannot compile targeting
 * release 17 or 21 at all, regardless of what the generated code looks
 * like. Catching that HERE, with a clear, actionable message naming both
 * the selected version and what's actually installed, replaces what would
 * otherwise be a cryptic `javac`/Maven "invalid target release" error
 * discovered only much later, deep inside a "Verify & Fix Code" attempt,
 * and misleadingly blamed on the generated code rather than the
 * environment. A NEWER installed JDK targeting an OLDER selected version
 * (e.g. Settings says 11, the machine has JDK 21) is always fine — see
 * `testExecutor.ts`'s `javaPomXml()`, which uses `maven.compiler.release`
 * for exactly this reason (not separate `source`/`target`, which alone
 * wouldn't also reject accidental use of newer JDK APIs).
 */
export function checkJavaEnvironment(languageVersion: string): Promise<EnvironmentCheckResult> {
  return cached(`java:${languageVersion}`, () => checkJavaEnvironmentUncached(languageVersion));
}

async function checkJavaEnvironmentUncached(languageVersion: string): Promise<EnvironmentCheckResult> {
  const java = await run('java', ['-version']);
  if (java.code !== 0) {
    return {
      ok: false,
      message:
        'Java (JDK) was not found on PATH — "java -version" failed. Install a JDK ' +
        `(version ${languageVersion} or newer) and ensure it is on PATH before executing generated Java code.`
    };
  }
  const mvn = await run('mvn', ['-version'], undefined, true);
  if (mvn.code !== 0) {
    return {
      ok: false,
      message:
        'Apache Maven was not found on PATH — "mvn -version" failed. Install Maven ' +
        'and ensure it is on PATH before executing generated Java code.'
    };
  }
  const javaVersionLine = java.output.split('\n')[0]?.trim() || 'java';
  const mvnVersionLine = mvn.output.split('\n')[0]?.trim() || 'mvn';

  const requestedMajor = parseInt(languageVersion, 10);
  const installedMajor = parseJavaMajorVersion(java.output);
  if (installedMajor !== undefined && !Number.isNaN(requestedMajor) && installedMajor < requestedMajor) {
    return {
      ok: false,
      message:
        `Settings has Java ${languageVersion} selected, but the installed JDK reports version ${installedMajor} ` +
        `(${javaVersionLine}) — a JDK can only compile/run for its OWN version or older, never a newer one. ` +
        `Install a JDK ${languageVersion} or newer (a newer JDK can still target ${languageVersion}), or select ` +
        `${installedMajor} in Settings instead if that's the version you actually meant to test against.`
    };
  }

  return { ok: true, message: `${javaVersionLine} · ${mvnVersionLine}` };
}

// Import names vs. the pip package names required to install them —
// differ only for pytest-playwright (`pytest_playwright` import).
const OFFLINE_PYTHON_PACKAGES: Record<AutomationMode, { import: string; pipName: string }[]> = {
  api: [
    { import: 'requests', pipName: 'requests' },
    { import: 'pytest', pipName: 'pytest' }
  ],
  ui: [
    { import: 'playwright', pipName: 'playwright' },
    { import: 'pytest', pipName: 'pytest' },
    { import: 'pytest_playwright', pipName: 'pytest-playwright' }
  ]
};

function venvPythonPath(venvDir: string): string {
  return process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
}

function tailForMessage(output: string): string {
  const MAX = 800;
  return output.length > MAX ? `…${output.slice(-MAX)}` : output;
}

/**
 * Self-provisions the pip packages "Verify & Fix Code" needs — API mode's
 * `requests`/`pytest`, or UI mode's `playwright`/`pytest`/`pytest-playwright`
 * — entirely offline, from the extension's own bundled wheels under
 * `resources/python/wheels` (see resources/python/README.md for how that
 * folder is populated), so a bank/enterprise machine with no PyPI egress
 * never needs an internet-based `pip install` to run generated Python code.
 *
 * API mode's packages are pure-Python universal wheels, portable to any OS.
 * UI mode's `playwright` (and its native `greenlet` dependency) are NOT —
 * PyPI ships a real per-OS/per-Python-ABI binary for those (Playwright's
 * Python package bundles its own self-contained driver, Node.js binary
 * included, no external Node/browser-download step needed for the
 * `executable_path=<real Chrome/Edge>` pattern this extension always uses —
 * see codegenManager.ts) — so only Windows x64 builds are bundled here,
 * matching this extension's existing Windows-only scope (e.g. the
 * Program Files/LOCALAPPDATA executable-path resolution codegenManager.ts
 * injects into generated code). UI mode falls back to the old check-only
 * behavior (report what's missing, install nothing) on any other OS.
 *
 * Provisions (once, lazily — reused on every later call) a DEDICATED
 * virtual environment per (mode, languageVersion) pair under the
 * extension's own global storage, NEVER the user's system/base Python, so
 * this never mutates an environment outside the extension's own control.
 * Returns that venv's own python executable as `pythonCommand` — every
 * subsequent compile-check/pytest run uses it instead of the system
 * interpreter. Keyed by `languageVersion` too (not just `automationMode`)
 * — a venv is created FROM `basePythonCommand` and permanently inherits
 * its exact Python version, so reusing one venv directory across a
 * Settings switch between e.g. Python 3.9 and 3.11 would silently keep
 * running the OLD version's interpreter regardless of the new selection.
 */
async function ensureOfflinePythonEnv(
  basePythonCommand: string,
  resourcesRoot: string,
  storageDir: string,
  automationMode: AutomationMode,
  languageVersion: string
): Promise<EnvironmentCheckResult & { pythonCommand?: string }> {
  const packages = OFFLINE_PYTHON_PACKAGES[automationMode];
  const modeLabel = automationMode === 'api' ? 'API' : 'UI';
  const venvDir = path.join(storageDir, `${automationMode}-python-${languageVersion}-env`);
  const venvPython = venvPythonPath(venvDir);
  const wheelsDir = path.join(resourcesRoot, 'resources', 'python', 'wheels');

  if (!fs.existsSync(venvPython)) {
    const created = await run(basePythonCommand, ['-m', 'venv', venvDir], undefined, false, 60_000);
    if (created.code !== 0 || !fs.existsSync(venvPython)) {
      return {
        ok: false,
        message: `Could not create the offline Python environment for ${modeLabel} Automation verification (${venvDir}):\n${created.output}`
      };
    }
  }

  const missing: string[] = [];
  for (const pkg of packages) {
    const result = await run(venvPython, ['-c', `import ${pkg.import}`]);
    if (result.code !== 0) missing.push(pkg.pipName);
  }
  if (missing.length > 0) {
    if (!fs.existsSync(wheelsDir)) {
      return {
        ok: false,
        message:
          `The offline Python environment is missing ${missing.join(', ')}, and the extension's bundled ` +
          `offline package cache was not found at "${wheelsDir}" — try reinstalling the extension.`
      };
    }
    const install = await run(
      venvPython,
      ['-m', 'pip', 'install', '--no-index', '--find-links', wheelsDir, ...missing],
      undefined,
      false,
      120_000
    );
    if (install.code !== 0) {
      return {
        ok: false,
        message: `Failed to install bundled offline package(s) (${missing.join(', ')}) into the local ${modeLabel} Automation Python environment:\n${tailForMessage(install.output)}`
      };
    }
  }

  return {
    ok: true,
    pythonCommand: venvPython,
    message: `Offline ${modeLabel} Automation Python environment ready (${packages.map((p) => p.pipName).join(' + ')}, bundled with the extension — no internet required).`
  };
}

/** Extracts "major.minor" from a `python --version`/`py -X.Y --version`
 * output line, e.g. "Python 3.11.4" -> "3.11" — `undefined` if the output
 * doesn't look like a Python version line at all. */
export function extractPythonMajorMinor(versionOutput: string): string | undefined {
  const match = versionOutput.match(/Python\s+(\d+)\.(\d+)/i);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

/**
 * Resolves a real Python interpreter matching `languageVersion` (e.g.
 * "3.11") EXACTLY (major.minor) — the fix for Settings' Python version
 * selector previously being entirely decorative for "Verify & Fix Code":
 * this used to always grab whichever of `python`/`python3` happened to be
 * first on PATH, with no regard for which version the user actually
 * selected. Tried in this order, returning the first real match:
 *
 * 1. The Windows "py" launcher with an explicit version selector
 *    (`py -3.11`) — the standard, most reliable way multiple Python
 *    versions coexist on one Windows machine (this extension's stated
 *    scope for offline/bundled provisioning elsewhere in this file).
 *    Resolved to its own absolute interpreter path via `-c "import sys;
 *    print(sys.executable)"` so the returned value is a single, plain,
 *    directly-invocable executable path — matching what every
 *    `pythonCommand` consumer already expects (one command, not a
 *    launcher+flag pair).
 * 2. A directly-named `pythonX.Y` binary on PATH (common on macOS/Linux via
 *    pyenv/Homebrew/apt; occasionally present on Windows too from a manual
 *    install) — verified by actually running `--version` and checking it
 *    reports the SAME version, never assumed from the name alone.
 * 3. Whichever of `python`/`python3` is already on PATH, IF its own
 *    reported version already matches exactly — the common case where a
 *    user has exactly one Python installed, matching whatever they picked
 *    in Settings, so no extra resolution work is ever needed.
 *
 * `undefined` when NONE of the above resolves to the requested version —
 * the caller reports this as a clear, actionable "not found" message
 * naming the exact version, rather than silently falling back to a
 * MISMATCHED interpreter that would produce a confusing failure much
 * later, deep inside "Verify & Fix Code", misleadingly blamed on the
 * generated code instead of the environment.
 */
async function resolvePythonInterpreterForVersion(languageVersion: string): Promise<string | undefined> {
  if (process.platform === 'win32') {
    const viaLauncher = await run('py', [`-${languageVersion}`, '-c', 'import sys; print(sys.executable)']);
    if (viaLauncher.code === 0) {
      const resolvedPath = viaLauncher.output.trim().split('\n').pop()?.trim();
      if (resolvedPath && fs.existsSync(resolvedPath)) {
        return resolvedPath;
      }
    }
  }
  for (const candidate of [`python${languageVersion}`, `python${languageVersion.replace('.', '')}`]) {
    const result = await run(candidate, ['--version']);
    if (result.code === 0 && extractPythonMajorMinor(result.output) === languageVersion) {
      return candidate;
    }
  }
  for (const candidate of ['python', 'python3']) {
    const result = await run(candidate, ['--version']);
    if (result.code === 0 && extractPythonMajorMinor(result.output) === languageVersion) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Same idea for Python: verifies an interpreter matching `languageVersion`
 * (see `resolvePythonInterpreterForVersion()`) is available, then
 * self-provisions the pip packages the generated test file actually needs
 * — see `ensureOfflinePythonEnv()` — whenever `resourcesRoot` and
 * `storageDir` are supplied (the extension's real callers always pass
 * both; they're optional only so this function stays testable/callable
 * without a live extension context) and, for UI mode, the current OS is one
 * the bundled wheels actually support (Windows). Otherwise falls back to
 * the old check-only behavior: report exactly what pip package is missing
 * and the command to install it, installing nothing itself.
 */
export function checkPythonEnvironment(
  automationMode: AutomationMode = 'ui',
  resourcesRoot?: string,
  storageDir?: string,
  languageVersion = '3.11'
): Promise<EnvironmentCheckResult & { pythonCommand?: string }> {
  const key = `python:${automationMode}:${languageVersion}:${resourcesRoot ?? ''}:${storageDir ?? ''}`;
  return cached(key, () => checkPythonEnvironmentUncached(automationMode, languageVersion, resourcesRoot, storageDir));
}

async function checkPythonEnvironmentUncached(
  automationMode: AutomationMode,
  languageVersion: string,
  resourcesRoot?: string,
  storageDir?: string
): Promise<EnvironmentCheckResult & { pythonCommand?: string }> {
  const pythonCommand = await resolvePythonInterpreterForVersion(languageVersion);
  if (!pythonCommand) {
    return {
      ok: false,
      message:
        `Settings has Python ${languageVersion} selected, but no matching interpreter was found — neither the ` +
        `Windows "py -${languageVersion}" launcher, a "python${languageVersion}" binary, nor the default ` +
        `"python"/"python3" on PATH report version ${languageVersion}. Install Python ${languageVersion} and ` +
        `ensure it's discoverable (via the "py" launcher on Windows, or on PATH), or select a version you do have ` +
        `installed in Settings instead.`
    };
  }
  const versionLine = (await run(pythonCommand, ['--version'])).output.split('\n')[0]?.trim() || pythonCommand;

  const canGoOffline = resourcesRoot && storageDir && (automationMode === 'api' || process.platform === 'win32');
  if (canGoOffline) {
    return ensureOfflinePythonEnv(pythonCommand, resourcesRoot, storageDir, automationMode, languageVersion);
  }

  const required = OFFLINE_PYTHON_PACKAGES[automationMode].map((p) => p.import);
  const missing: string[] = [];
  for (const moduleName of required) {
    const result = await run(pythonCommand, ['-c', `import ${moduleName}`]);
    if (result.code !== 0) {
      missing.push(moduleName === 'pytest_playwright' ? 'pytest-playwright' : moduleName);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      pythonCommand,
      message:
        `${versionLine} found, but missing required pip package(s): ${missing.join(', ')}. Install them with:\n` +
        `    ${pythonCommand} -m pip install ${missing.join(' ')}\n` +
        (automationMode === 'api'
          ? ''
          : '(this never installs a browser — the generated code launches the real, already-installed Chrome/Edge.)')
    };
  }
  return { ok: true, pythonCommand, message: versionLine };
}

export function checkEnvironment(
  language: Language,
  automationMode: AutomationMode = 'ui',
  resourcesRoot?: string,
  storageDir?: string,
  languageVersion?: string
): Promise<EnvironmentCheckResult & { pythonCommand?: string }> {
  return language === 'java'
    ? checkJavaEnvironment(languageVersion ?? '17')
    : checkPythonEnvironment(automationMode, resourcesRoot, storageDir, languageVersion);
}
