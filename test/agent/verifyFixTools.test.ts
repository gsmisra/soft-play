import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRunCodeTool, RunCodeToolDeps } from '../../src/agent/verifyFixTools';
import type { ExecutionResult } from '../../src/execution/testExecutor';

/**
 * Directly exercises the bug fix requested by the user: the confirmation
 * shown before every code execution must carry the PREVIOUS attempt's real
 * failure output, so a "re-run?" decision is informed rather than blind.
 * Uses the `executeFn` test seam (see verifyFixTools.ts) to substitute a
 * scripted fake for the real compiler/test-runner — no Java/Python
 * toolchain, no real file execution, fully deterministic.
 */

function makeExecutionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return { success: false, compileOnly: false, apiCallOutcome: 'not-run', httpStatusCodes: [], output: '', ...overrides };
}

function baseDeps(overrides: Partial<RunCodeToolDeps> = {}): RunCodeToolDeps {
  return {
    language: 'python',
    languageVersion: '3.11',
    scratchDir: '/fake/scratch',
    linkedFeatureFilePath: undefined,
    pythonCommand: 'python',
    automationMode: 'ui',
    resourcesRoot: '/fake/resources',
    secretEnv: {},
    maxAttempts: 5,
    attemptCounter: { count: 0 },
    lastFailureOutput: { value: undefined },
    confirmRun: async () => true,
    onOutput: () => {},
    ...overrides
  };
}

test('the first confirmRun call carries no previous error (nothing has failed yet)', async () => {
  const seenErrors: (string | undefined)[] = [];
  const deps = baseDeps({
    confirmRun: async (_attempt, _max, lastErrorOutput) => {
      seenErrors.push(lastErrorOutput);
      return true;
    },
    executeFn: async () => makeExecutionResult({ success: true })
  });
  const runCode = createRunCodeTool(deps);
  await runCode.invoke({ code: 'print(1)' });
  assert.deepEqual(seenErrors, [undefined]);
});

test('the second confirmRun call carries the exact error from the first failed attempt', async () => {
  const seenErrors: (string | undefined)[] = [];
  let call = 0;
  const deps = baseDeps({
    confirmRun: async (_attempt, _max, lastErrorOutput) => {
      seenErrors.push(lastErrorOutput);
      return true;
    },
    executeFn: async () => {
      call += 1;
      return call === 1
        ? makeExecutionResult({ success: false, output: 'SyntaxError: unexpected indent on line 12' })
        : makeExecutionResult({ success: true });
    }
  });
  const runCode = createRunCodeTool(deps);

  await runCode.invoke({ code: 'broken v1' });
  await runCode.invoke({ code: 'fixed v2' });

  assert.deepEqual(seenErrors, [undefined, 'SyntaxError: unexpected indent on line 12']);
});

test('lastFailureOutput is cleared once an attempt actually succeeds', async () => {
  let call = 0;
  const lastFailureOutput = { value: undefined as string | undefined };
  const deps = baseDeps({
    lastFailureOutput,
    executeFn: async () => {
      call += 1;
      return call === 1
        ? makeExecutionResult({ success: false, output: 'boom' })
        : makeExecutionResult({ success: true });
    }
  });
  const runCode = createRunCodeTool(deps);

  await runCode.invoke({ code: 'v1' });
  assert.equal(lastFailureOutput.value, 'boom');

  await runCode.invoke({ code: 'v2' });
  assert.equal(lastFailureOutput.value, undefined);
});

test('a declined confirmation never calls executeFn and reports the decline signal', async () => {
  let executed = false;
  const deps = baseDeps({
    confirmRun: async () => false,
    executeFn: async () => {
      executed = true;
      return makeExecutionResult({ success: true });
    }
  });
  const runCode = createRunCodeTool(deps);
  const raw = await runCode.invoke({ code: 'v1' });
  const parsed = JSON.parse(raw as string);
  assert.equal(parsed.signal, 'declined');
  assert.equal(executed, false);
});

test('refuses to execute once the attempt budget is exhausted, without consulting confirmRun again', async () => {
  let confirmCalls = 0;
  let executions = 0;
  const attemptCounter = { count: 2 };
  const deps = baseDeps({
    maxAttempts: 2,
    attemptCounter,
    confirmRun: async () => {
      confirmCalls += 1;
      return true;
    },
    executeFn: async () => {
      executions += 1;
      return makeExecutionResult({ success: false, output: 'still broken' });
    }
  });
  const runCode = createRunCodeTool(deps);
  const raw = await runCode.invoke({ code: 'v3' });
  const parsed = JSON.parse(raw as string);
  assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
  assert.equal(confirmCalls, 0);
  assert.equal(executions, 0);
});

// A user reported "Verify & Fix Code" ignoring Settings' selected Java/
// Python version entirely (only Java 17 ever worked) — root cause was
// executeGeneratedCode() never even receiving the selected version at all.
// This locks in that RunCodeToolDeps.languageVersion actually reaches the
// real execute() call, for both languages Settings offers a version
// selector for.
test('deps.languageVersion is passed through to execute() exactly as given, for Java', async () => {
  let receivedLanguageVersion: string | undefined;
  const deps = baseDeps({
    language: 'java',
    languageVersion: '11',
    executeFn: async (_language, _code, _scratchDir, _linkedFeatureFilePath, _pythonCommand, _automationMode, _resourcesRoot, _secretEnv, languageVersion) => {
      receivedLanguageVersion = languageVersion;
      return makeExecutionResult({ success: true });
    }
  });
  const runCode = createRunCodeTool(deps);
  await runCode.invoke({ code: 'public class Foo {}' });
  assert.equal(receivedLanguageVersion, '11');
});

test('deps.languageVersion is passed through to execute() exactly as given, for Python', async () => {
  let receivedLanguageVersion: string | undefined;
  const deps = baseDeps({
    language: 'python',
    languageVersion: '3.9',
    executeFn: async (_language, _code, _scratchDir, _linkedFeatureFilePath, _pythonCommand, _automationMode, _resourcesRoot, _secretEnv, languageVersion) => {
      receivedLanguageVersion = languageVersion;
      return makeExecutionResult({ success: true });
    }
  });
  const runCode = createRunCodeTool(deps);
  await runCode.invoke({ code: 'print(1)' });
  assert.equal(receivedLanguageVersion, '3.9');
});
