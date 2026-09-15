/**
 * Shared by Standard mode's `objectSpyPanel.ts` and Total Agentic Mode's
 * `agenticModeController.ts` — both "Verify & Fix Code" wirings need to
 * bound how much of a raw compiler/test-runner error reaches a modal
 * confirmation dialog vs. a one-line panel status, and there's no reason
 * for the two to maintain independent copies of two small, pure,
 * dependency-free functions. Pulled out here rather than one importing
 * from the other — neither panel's own module should depend on the other's
 * (see agenticModeController.ts's own "proper segregation" doc comment).
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
