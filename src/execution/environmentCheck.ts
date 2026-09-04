import { execFile } from 'child_process';
import { AutomationMode, Language } from '../settings/settingsStore';

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
function run(command: string, args: string[], cwd?: string, shell = false): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, windowsHide: true, timeout: 30_000, shell }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      // execFile's `error` for a plain non-zero exit still carries a
      // `.code` (the process's own exit code) — only fall back to -1 for a
      // genuine spawn failure (command not found, permissions, etc.).
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, output });
    });
  });
}

/**
 * "Take necessary steps beforehand to assert all the necessary Maven, Java
 * and other environmental parameters are in place" — verifies `java` and
 * `mvn` are both on PATH and report their versions, without installing or
 * modifying anything: an enterprise/bank environment is not somewhere this
 * extension should silently mutate. On failure, `message` names exactly
 * what's missing and points at the standard way to install it.
 */
export async function checkJavaEnvironment(): Promise<EnvironmentCheckResult> {
  const java = await run('java', ['-version']);
  if (java.code !== 0) {
    return {
      ok: false,
      message:
        'Java (JDK) was not found on PATH — "java -version" failed. Install a JDK ' +
        '(17 or newer recommended) and ensure it is on PATH before executing generated Java code.'
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
  return { ok: true, message: `${javaVersionLine} · ${mvnVersionLine}` };
}

/**
 * Same idea for Python: verifies a `python` (or `python3`) interpreter is on
 * PATH, then that the pip packages the generated test file actually needs
 * are importable — UI mode: `playwright` (the library import, never its
 * own browser binaries — those are never installed, see
 * codegenManager.ts), `pytest`, and `pytest-playwright` (supplies the
 * `page`/`browser_type_launch_args` fixtures the generated code overrides);
 * API mode: `requests` and `pytest` (no Playwright/browser involvement at
 * all in API automation). Reports exactly what's missing and the pip
 * command to install it; never installs anything itself.
 */
export async function checkPythonEnvironment(
  automationMode: AutomationMode = 'ui'
): Promise<EnvironmentCheckResult & { pythonCommand?: string }> {
  const candidates = ['python', 'python3'];
  let pythonCommand: string | undefined;
  let versionLine = '';
  for (const candidate of candidates) {
    const result = await run(candidate, ['--version']);
    if (result.code === 0) {
      pythonCommand = candidate;
      versionLine = result.output.split('\n')[0]?.trim() || candidate;
      break;
    }
  }
  if (!pythonCommand) {
    return {
      ok: false,
      message: 'Python was not found on PATH — neither "python --version" nor "python3 --version" succeeded. Install Python 3 and ensure it is on PATH before executing generated Python code.'
    };
  }

  const required = automationMode === 'api' ? ['requests', 'pytest'] : ['playwright', 'pytest', 'pytest_playwright'];
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

export function checkEnvironment(language: Language, automationMode: AutomationMode = 'ui'): Promise<EnvironmentCheckResult> {
  return language === 'java' ? checkJavaEnvironment() : checkPythonEnvironment(automationMode);
}
