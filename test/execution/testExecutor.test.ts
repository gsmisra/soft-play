import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { javaPomXml } from '../../src/execution/testExecutor';

/**
 * The actual bug a user reported: "Verify & Fix Code" only ever worked for
 * Java 17 — Settings' Java 11/21 options were entirely decorative for this
 * feature, because the generated scratch `pom.xml` hardcoded
 * `maven.compiler.source`/`target` to `17` regardless of what was
 * selected. A JDK 11 install genuinely cannot compile targeting release
 * 17 at all (a JDK can only target its own version or older, never
 * newer), so anyone without a 17+ JDK installed hit a hard compile
 * failure no matter what the generated code looked like; conversely,
 * selecting 21 with a 21+ JDK installed still got code compiled AS IF it
 * were plain 17, rejecting genuinely valid 21-only syntax.
 *
 * These tests lock in the fix: `javaPomXml()` now uses
 * `maven.compiler.release` (stricter than separate source/target — it
 * ALSO rejects accidental use of a newer JDK's own APIs, not just newer
 * syntax) driven directly by the caller's `languageVersion` argument, for
 * every version Settings actually offers (LANGUAGE_VERSIONS.java —
 * '11'/'17'/'21').
 */

test('javaPomXml uses maven.compiler.release matching the requested version, for every Settings option', () => {
  for (const version of ['11', '17', '21']) {
    const pom = javaPomXml(false, 'ui', undefined, version);
    assert.match(pom, new RegExp(`<maven\\.compiler\\.release>${version}</maven\\.compiler\\.release>`), `expected release ${version} in the generated pom.xml`);
  }
});

test('javaPomXml never hardcodes a fixed source/target regardless of the requested version (the actual regression)', () => {
  const pom11 = javaPomXml(false, 'ui', undefined, '11');
  const pom21 = javaPomXml(false, 'ui', undefined, '21');
  assert.doesNotMatch(pom11, /<maven\.compiler\.source>/, 'must not use the old separate source/target properties at all');
  assert.doesNotMatch(pom11, /<maven\.compiler\.target>/);
  assert.doesNotMatch(pom11, /release>17</, 'a Java 11 request must never silently compile for 17');
  assert.doesNotMatch(pom21, /release>17</, 'a Java 21 request must never silently compile for 17');
});

test('javaPomXml still includes the right dependency set (API vs UI) regardless of languageVersion', () => {
  const apiPom = javaPomXml(false, 'api', undefined, '11');
  const uiPom = javaPomXml(false, 'ui', undefined, '21');
  assert.match(apiPom, /rest-assured/);
  assert.doesNotMatch(apiPom, /com\.microsoft\.playwright/);
  assert.match(uiPom, /com\.microsoft\.playwright/);
  assert.doesNotMatch(uiPom, /rest-assured/);
});

test('javaPomXml still includes Cucumber dependencies only for BDD-mode code, regardless of languageVersion', () => {
  const bddPom = javaPomXml(true, 'ui', undefined, '17');
  const nonBddPom = javaPomXml(false, 'ui', undefined, '17');
  assert.match(bddPom, /cucumber-java/);
  assert.doesNotMatch(nonBddPom, /cucumber-java/);
});
