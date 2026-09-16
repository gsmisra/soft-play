import * as fs from 'fs';
import type * as vscode from 'vscode';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { executeGeneratedCode, ExecutionResult } from '../execution/testExecutor';
import { resolveWithinScratchDir } from './scratchPath';
import { AutomationMode, Language } from '../settings/settingsStore';

/** Matches `executeGeneratedCode()`'s signature exactly — the real function
 * is the default (see `createRunCodeTool()` below); tests substitute a
 * fake here to exercise the confirmRun/lastFailureOutput wiring around it
 * without needing a real Java/Python toolchain or an actually-compilable
 * file. `executeGeneratedCode()` itself has no `vscode` dependency (it's
 * plain fs/child_process), so this seam exists purely for test speed and
 * determinism, not to route around the Extension Host. */
type ExecuteGeneratedCodeFn = typeof executeGeneratedCode;

/**
 * The Verify & Fix Code agent's three tools — exactly the set named in the
 * feature request: run the candidate code, read a file from its own
 * scratch project, and read the linked Cucumber feature file. Each factory
 * closes over per-session state (the scratch directory, the confirmation
 * callback, ...) rather than the tools carrying that state as LLM-supplied
 * arguments — an agent must never be able to ask for a DIFFERENT scratch
 * directory, execution mode, or feature file than the one this specific
 * Verify & Fix Code click is actually operating on.
 *
 * This file is deliberately the only "vscode-adjacent" piece that isn't
 * unit tested directly (it doesn't import `vscode` itself, but
 * `executeGeneratedCode` and the confirmation callback it's given do reach
 * into the Extension Host) — see agent/verifyFixAgent.ts's doc comment for
 * why the control-flow core is tested instead, and agent/scratchPath.ts for
 * the one piece of pure, security-critical logic pulled out and tested on
 * its own.
 */

const MAX_READ_CHARS = 8000;

function truncate(content: string): string {
  return content.length > MAX_READ_CHARS ? `${content.slice(0, MAX_READ_CHARS)}\n…(truncated)` : content;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface RunCodeToolDeps {
  language: Language;
  /** The user's Settings selection (LANGUAGE_VERSIONS[language] — e.g.
   * "11"/"17"/"21" for Java, "3.9"-"3.12" for Python) — threaded through to
   * `executeGeneratedCode()` so the scratch project actually compiles/runs
   * for the version the user picked, not a hardcoded one. See
   * testExecutor.ts's `javaPomXml()` for why this matters for Java
   * specifically (a wrong hardcoded target previously made "Verify & Fix
   * Code" fail outright for anyone whose installed JDK didn't happen to
   * support exactly that one hardcoded version). */
  languageVersion: string;
  scratchDir: string;
  linkedFeatureFilePath: string | undefined;
  pythonCommand: string;
  automationMode: AutomationMode;
  resourcesRoot: string;
  secretEnv: Record<string, string>;
  /** Same role as ObjectSpyPanel.MAX_VERIFY_ATTEMPTS before this feature —
   * a hard cap on how many times code is actually EXECUTED (as opposed to
   * `maxSteps` in verifyFixAgent.ts, which bounds total agent turns
   * including non-executing tool calls like read_file). */
  maxAttempts: number;
  /** Shared, mutable across every tool call in one agent run so the cap
   * above is enforced across the whole session, not reset per call. */
  attemptCounter: { count: number };
  /** The previous attempt's raw failure output, if any — set after every
   * failed execution (see below) and handed to `confirmRun` on the NEXT
   * call, so the confirmation dialog can actually show the user why the
   * last attempt failed instead of asking them to approve another run
   * blind. `undefined` before the first attempt has run. */
  lastFailureOutput: { value: string | undefined };
  /** Shown before every single execution, with zero exceptions — the exact
   * same human-in-the-loop gate "Verify & Fix Code" has always had. `false`
   * short-circuits the whole agent run (see the 'declined' signal below).
   * `lastErrorOutput` is the previous attempt's failure output (undefined
   * on the very first call) — passed through so the confirmation itself can
   * show it, letting the user make an informed Yes/No decision rather than
   * approving another run with no idea what just went wrong. */
  confirmRun: (attempt: number, maxAttempts: number, lastErrorOutput?: string) => Promise<boolean>;
  onOutput: (line: string) => void;
  /** F03: rechecked IMMEDIATELY AFTER `confirmRun()` resolves, before
   * `execute()` is ever called — closes a real race `confirmRun()`'s own
   * await can't protect against on its own: a Clear Data/cancel firing
   * WHILE the confirmation dialog is still open, answered "Yes" anyway
   * once it's back. Checking cancellation only BETWEEN agent turns (the
   * orchestrator's own loop) can't catch this — the race is entirely
   * inside this one tool call's own await. Optional so an existing caller
   * that never passes it (there are none left after this fix, but the
   * field itself must not become a breaking required addition) behaves
   * exactly as before — never blocked. Shared by BOTH Standard mode's
   * `objectSpyPanel.ts` and Total Agentic Mode's `agenticModeController.ts`,
   * since this tool itself is shared. */
  cancellationToken?: vscode.CancellationToken;
  /** Test-only override for `executeGeneratedCode()` — see
   * `ExecuteGeneratedCodeFn` above. Never set by real callers
   * (verifyFixOrchestrator.ts), which always get the real implementation. */
  executeFn?: ExecuteGeneratedCodeFn;
}

/**
 * `run_code` — the agent's only way to find out whether its current
 * candidate actually works. Always takes the FULL file as input (never a
 * diff/snippet) so there is never any ambiguity about what was actually
 * executed. Returns a JSON string; on a passing run it includes
 * `{"signal":"success", code, ...}`, which agent/verifyFixAgent.ts treats
 * as the one and only trustworthy stopping condition — the model's own
 * commentary is never taken as proof of success.
 */
export function createRunCodeTool(deps: RunCodeToolDeps) {
  return tool(
    async ({ code }: { code: string }): Promise<string> => {
      if (deps.attemptCounter.count >= deps.maxAttempts) {
        return JSON.stringify({
          error: `The ${deps.maxAttempts}-attempt execution budget for this session is already used up — do not call run_code again; summarize the last known failure instead.`
        });
      }
      deps.attemptCounter.count += 1;
      const attempt = deps.attemptCounter.count;

      const proceed = await deps.confirmRun(attempt, deps.maxAttempts, deps.lastFailureOutput.value);
      if (!proceed) {
        return JSON.stringify({ signal: 'declined', summary: `The user declined to run attempt ${attempt} of ${deps.maxAttempts}.` });
      }
      // F03: rechecked HERE, immediately after confirmRun() resolves and
      // before execute() is ever called — the confirmation dialog's own
      // await is exactly the window a Clear Data/cancel firing WHILE it was
      // open, answered "Yes" afterward, would otherwise slip through.
      if (deps.cancellationToken?.isCancellationRequested) {
        return JSON.stringify({ signal: 'declined', summary: 'Cancelled before this attempt actually ran.' });
      }

      deps.onOutput(`Verify & Fix Code (agent) — running attempt ${attempt}/${deps.maxAttempts}…`);
      const execute = deps.executeFn ?? executeGeneratedCode;
      const result: ExecutionResult = await execute(
        deps.language,
        code,
        deps.scratchDir,
        deps.linkedFeatureFilePath,
        deps.pythonCommand,
        deps.automationMode,
        deps.resourcesRoot,
        deps.secretEnv,
        deps.languageVersion
      );
      deps.onOutput(
        `Verify & Fix Code (agent) — attempt ${attempt}: ${result.success ? 'PASSED' : 'FAILED'}` +
          `${result.compileOnly ? ' (compile/collect-only check)' : ''}` +
          `${result.apiCallOutcome !== 'not-run' ? ` — live API call ${result.apiCallOutcome}` : ''}\n${result.output}`
      );

      if (result.success) {
        deps.lastFailureOutput.value = undefined;
        return JSON.stringify({
          signal: 'success',
          code,
          compileOnly: result.compileOnly,
          apiCallOutcome: result.apiCallOutcome,
          summary: result.compileOnly ? 'Compiled successfully (compile/collect-only check).' : 'Ran headless without errors.'
        });
      }
      // Recorded so the NEXT confirmRun() call (see above) can show the
      // user exactly why this attempt failed before asking them to approve
      // another run.
      deps.lastFailureOutput.value = result.output;
      return JSON.stringify({
        attempt,
        maxAttempts: deps.maxAttempts,
        remainingAttempts: deps.maxAttempts - attempt,
        compileOnly: result.compileOnly,
        apiCallOutcome: result.apiCallOutcome,
        output: result.output
      });
    },
    {
      name: 'run_code',
      description:
        'Compiles/executes the given complete source file exactly as it would run for real, in a disposable scratch ' +
        'project, and reports whether it succeeded. Always pass the ENTIRE corrected file, never a diff or partial ' +
        'snippet. Your first call in this session should be the file exactly as given to you, before you make any ' +
        'changes, so the real error is captured before you start fixing anything. A human must approve every single ' +
        'execution; if they decline, stop immediately and do not try again.',
      schema: z.object({
        code: z.string().describe('The complete, corrected source file to compile/run — the whole file, not a diff.')
      })
    }
  );
}

/** `read_file` — lets the agent inspect a file inside its OWN disposable
 * scratch project (a generated pom.xml, a previous attempt's output, ...).
 * Every path is resolved through `resolveWithinScratchDir()` — see that
 * function's doc comment for exactly what it blocks. This tool can never
 * read anything outside the one scratch directory this session created,
 * no matter what path an LLM response asks for. */
export function createReadScratchFileTool(scratchDir: string) {
  return tool(
    async ({ relativePath }: { relativePath: string }): Promise<string> => {
      const resolved = resolveWithinScratchDir(scratchDir, relativePath);
      if (!resolved) {
        return JSON.stringify({ error: 'That path is outside this session\'s scratch project and cannot be read.' });
      }
      try {
        const stat = await fs.promises.stat(resolved);
        if (!stat.isFile()) {
          return JSON.stringify({ error: 'That path is not a file.' });
        }
        const content = await fs.promises.readFile(resolved, 'utf8');
        return JSON.stringify({ content: truncate(content) });
      } catch (err) {
        return JSON.stringify({ error: `Could not read "${relativePath}": ${describeError(err)}` });
      }
    },
    {
      name: 'read_file',
      description:
        'Reads a file from this session\'s disposable scratch project (e.g. a generated build file, or output an ' +
        'earlier run_code call left behind) by its path relative to the scratch project root. Cannot read anything ' +
        'outside that project.',
      schema: z.object({
        relativePath: z.string().describe('Path relative to the scratch project root, e.g. "pom.xml".')
      })
    }
  );
}

/** `read_feature_file` — read-only access to whatever `.feature` file the
 * user explicitly linked via "Link Feature file" BEFORE this agent run
 * ever started. Not a path the agent can influence at all (no arguments),
 * so there is no traversal surface here the way there is for `read_file`. */
export function createReadFeatureFileTool(featureFilePath: string | undefined) {
  return tool(
    async (): Promise<string> => {
      if (!featureFilePath) {
        return JSON.stringify({ content: null, note: 'No .feature file is linked for this session.' });
      }
      try {
        const content = await fs.promises.readFile(featureFilePath, 'utf8');
        return JSON.stringify({ content: truncate(content) });
      } catch (err) {
        return JSON.stringify({ error: `Could not read the linked feature file: ${describeError(err)}` });
      }
    },
    {
      name: 'read_feature_file',
      description:
        'Reads the Cucumber .feature file linked via "Link Feature file" for this session, if any — the Gherkin ' +
        'scenario the generated code is meant to satisfy. Takes no arguments.',
      schema: z.object({})
    }
  );
}
