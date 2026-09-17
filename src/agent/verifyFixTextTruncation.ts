import { Language } from '../settings/settingsStore';

/**
 * Shared by Standard mode's `objectSpyPanel.ts` and Total Agentic Mode's
 * `agenticModeController.ts` — both "Verify & Fix Code" wirings need to
 * bound how much of a raw compiler/test-runner error reaches a modal
 * confirmation dialog vs. a one-line panel status, and share the exact same
 * API-mode success wording, and there's no reason for the two to maintain
 * independent copies of these small, pure, dependency-free functions.
 * Pulled out here rather than one importing from the other — neither
 * panel's own module should depend on the other's (see
 * agenticModeController.ts's own "proper segregation" doc comment).
 */

/** Bounds how much of a raw compiler/test-runner error goes into a modal
 * confirmation dialog's `detail` text — a full multi-KB stack trace reads
 * fine in the Output channel but would just be an unreadable wall of text
 * in a small popup. Keeps the TAIL (same convention as
 * execution/testExecutor.ts's own tailOutput()) since the actual failure
 * reason is almost always at the end of compiler/test output, not the
 * start. Always points to the Output channel for the untruncated version. */
const MAX_DIALOG_ERROR_CHARS = 800;
export function truncateForDialog(output: string): string {
  const trimmed = output.trim();
  const body = trimmed.length > MAX_DIALOG_ERROR_CHARS ? `…${trimmed.slice(-MAX_DIALOG_ERROR_CHARS)}` : trimmed;
  return `${body}\n\n(Full output is in the SoftPlay Output channel.)`;
}

/** Same idea as `truncateForDialog()` but for a panel's one-line status
 * text (see AiCodePanel.setVerifyStatus()) — collapsed to a single line and
 * capped much shorter, so "Attempt 2 failed: <error>" reads as a status
 * line, not a dumped stack trace. */
const MAX_STATUS_LINE_ERROR_CHARS = 180;
export function truncateForStatusLine(output: string): string {
  const singleLine = output.trim().replace(/\s+/g, ' ');
  return singleLine.length > MAX_STATUS_LINE_ERROR_CHARS ? `…${singleLine.slice(-MAX_STATUS_LINE_ERROR_CHARS)}` : singleLine;
}

/**
 * The "Verify & Fix Code" success banner for API Automation mode, in both
 * Standard mode and Total Agentic Mode. Per the explicit product decision:
 * in API mode, "correct" means the generated code compiles/parses cleanly —
 * a real, live HTTP response of ANY status code is reported as-is, never
 * characterized as a pass or a fail, since the code's own assertion (or
 * lack of one) against that code is the generated test's own business
 * logic, not something this banner second-guesses. `httpStatusCodes` is
 * `execution/testExecutor.ts`'s `ExecutionResult.httpStatusCodes` — the
 * actual, observed status code(s) of every live call the generated code
 * made this run, captured independently of whatever assertion the code
 * itself contains (see that module for how). An empty array means the
 * code compiled but no live HTTP response was actually observed (e.g. the
 * call never completed) — reported honestly rather than inventing a code.
 */
export function buildApiVerifySuccessMessage(language: Language, httpStatusCodes: number[]): string {
  const codeLabel = language === 'java' ? 'RestAssured' : 'Python API test';
  if (httpStatusCodes.length === 0) {
    return (
      `Code Correctness Confirmed — no compilation errors were found in the generated ${codeLabel} code, but no ` +
      `live HTTP response was captured this run (see the SoftPlay Output channel for details).`
    );
  }
  const codesText =
    httpStatusCodes.length === 1 ? `HTTP response code ${httpStatusCodes[0]}` : `HTTP response codes ${httpStatusCodes.join(', ')}`;
  return `Code Correctness Confirmed — the code ran with ${codesText}. No compilation errors were found in the generated ${codeLabel} code.`;
}
