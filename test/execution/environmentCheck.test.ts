import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseJavaMajorVersion, extractPythonMajorMinor } from '../../src/execution/environmentCheck';

/**
 * A user reported "Verify & Fix Code" failing outright for Java 11 and 21
 * (only 17 ever worked), and asked that Python's own version selector
 * (Settings' LANGUAGE_VERSIONS) actually be respected too. Root cause,
 * confirmed by reading the code: `testExecutor.ts`'s generated `pom.xml`
 * hardcoded `maven.compiler.source`/`target` to `17` regardless of
 * Settings, and `checkPythonEnvironment()` always grabbed whichever of
 * `python`/`python3` happened to resolve FIRST on PATH, with zero regard
 * for the selected version.
 *
 * These two functions are the pure, deterministic parsing logic behind the
 * fix — `checkJavaEnvironment()`'s own version-mismatch guard (is the
 * installed JDK new enough for the SELECTED version?) and
 * `resolvePythonInterpreterForVersion()`'s own "does this candidate
 * actually report the requested version?" check both depend on parsing
 * `java -version`/`python --version` output correctly. Deliberately
 * tested in isolation from the real `execFile` probing itself (which needs
 * a real, installed toolchain and isn't unit tested directly anywhere in
 * this codebase — see agent/verifyFixTools.ts's own doc comment on that
 * same posture) — this is the actual logic that was wrong, not the
 * process-spawning mechanics around it.
 */

test('parseJavaMajorVersion: modern single-number scheme (Java 9+)', () => {
  assert.equal(parseJavaMajorVersion('java version "17.0.9" 2023-10-17 LTS'), 17);
  assert.equal(parseJavaMajorVersion('openjdk version "21.0.1" 2023-10-17'), 21);
  assert.equal(parseJavaMajorVersion('java version "11.0.20" 2023-07-18'), 11);
});

test('parseJavaMajorVersion: legacy "1.x" scheme (Java 8 and earlier) uses the SECOND component', () => {
  assert.equal(parseJavaMajorVersion('java version "1.8.0_281"'), 8);
});

test('parseJavaMajorVersion: a single-digit modern version (e.g. a hypothetical Java 9) is not mistaken for the legacy scheme', () => {
  assert.equal(parseJavaMajorVersion('java version "9.0.1"'), 9);
});

test('parseJavaMajorVersion: unrecognized output returns undefined, never a wrong guess', () => {
  assert.equal(parseJavaMajorVersion('command not found'), undefined);
  assert.equal(parseJavaMajorVersion(''), undefined);
});

test('extractPythonMajorMinor: a normal version line', () => {
  assert.equal(extractPythonMajorMinor('Python 3.11.4'), '3.11');
  assert.equal(extractPythonMajorMinor('Python 3.9.0'), '3.9');
  assert.equal(extractPythonMajorMinor('Python 3.12.1'), '3.12');
});

test('extractPythonMajorMinor: case-insensitive and tolerant of surrounding text', () => {
  assert.equal(extractPythonMajorMinor('python 3.10.2'), '3.10');
});

test('extractPythonMajorMinor: unrecognized output returns undefined, never a wrong guess', () => {
  assert.equal(extractPythonMajorMinor('command not found'), undefined);
  assert.equal(extractPythonMajorMinor(''), undefined);
});
