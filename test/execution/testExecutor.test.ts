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
 * First fix attempt used `maven.compiler.release` instead (stricter — it
 * also rejects accidental use of a newer JDK's own APIs, not just newer
 * syntax), but that broke a DIFFERENT, real environment: a locked-down
 * corporate machine with `-Dmaven.repo.local` pointed at this extension's
 * own bundled offline repo (`resources/java/m2repo`, for machines with no
 * Maven Central egress) has ONLY `maven-compiler-plugin` 3.1 available
 * there — a version old enough (pre-2017) to predate `release` support
 * entirely. Left unpinned, Maven silently fell back to exactly that
 * cached 3.1, which doesn't recognize `release` at all and silently
 * defaulted to its own ancient built-in source/target level 5 —
 * confirmed via a real reported failure ("[ERROR] Fatal error compiling:
 * release version 11 not supported", "falling back to compiler plugin
 * 3.1"). Final fix: back to separate `source`/`target` properties (fully
 * supported by 3.1 and every later version alike) PLUS an EXPLICIT
 * `<version>3.1</version>` pin on `maven-compiler-plugin` itself, matching
 * exactly what's guaranteed present offline — deterministic everywhere,
 * never dependent on whatever a given machine's own Maven happens to
 * default to.
 */

test('javaPomXml uses source/target matching the requested version, for every Settings option', () => {
  for (const version of ['11', '17', '21']) {
    const pom = javaPomXml(false, 'ui', undefined, version);
    assert.match(pom, new RegExp(`<maven\\.compiler\\.source>${version}</maven\\.compiler\\.source>`), `expected source ${version} in the generated pom.xml`);
    assert.match(pom, new RegExp(`<maven\\.compiler\\.target>${version}</maven\\.compiler\\.target>`), `expected target ${version} in the generated pom.xml`);
  }
});

test('javaPomXml never uses maven.compiler.release (unsupported by the bundled offline compiler-plugin) and never hardcodes 17 for a different request', () => {
  const pom11 = javaPomXml(false, 'ui', undefined, '11');
  const pom21 = javaPomXml(false, 'ui', undefined, '21');
  assert.doesNotMatch(pom11, /maven\.compiler\.release/, 'the bundled offline maven-compiler-plugin (3.1) does not support this property at all');
  assert.doesNotMatch(pom11, /compiler\.(?:source|target)>17</, 'a Java 11 request must never silently compile for 17');
  assert.doesNotMatch(pom21, /compiler\.(?:source|target)>17</, 'a Java 21 request must never silently compile for 17');
});

test('javaPomXml explicitly pins maven-compiler-plugin to the exact version bundled offline, never left to environment-dependent defaults', () => {
  const pom = javaPomXml(false, 'ui', undefined, '17');
  assert.match(pom, /<artifactId>maven-compiler-plugin<\/artifactId>\s*<version>3\.1<\/version>/, 'expected an explicit, deterministic compiler-plugin version pin');
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
