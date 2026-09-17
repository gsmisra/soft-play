import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { javaPomXml, extractHttpStatusCodes, injectJavaHttpStatusCapture } from '../../src/execution/testExecutor';

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

/**
 * "Verify & Fix Code" in API Automation mode: per the explicit product
 * decision, ANY real HTTP status code is reported to the user as-is — the
 * generated code's own `.statusCode(...)`/`assert response.status_code ==
 * ...` assertion is never second-guessed. `extractHttpStatusCodes()` reads
 * back exactly what `injectJavaHttpStatusCapture()` (Java) and the Python
 * conftest.py hook LOG TO A FILE (never stdout — see `readHttpStatusLog()`'s
 * own doc comment: a real, live end-to-end run against pytest proved that
 * pytest's default output capturing silently drops a PASSING test's
 * captured stdout, which is exactly the common case a print-based marker
 * would go missing for), independently of the test's own pass/fail.
 */
test('extractHttpStatusCodes finds every marker occurrence, in the order logged, ignoring unrelated build/test noise', () => {
  const output = [
    '[INFO] Scanning for projects...',
    'SOFTPLAY_HTTP_STATUS:200',
    'Tests run: 1, Failures: 1',
    'SOFTPLAY_HTTP_STATUS:404',
    'BUILD SUCCESS'
  ].join('\n');
  assert.deepEqual(extractHttpStatusCodes(output), [200, 404]);
});

test('extractHttpStatusCodes returns an empty array when no live call ever happened', () => {
  assert.deepEqual(extractHttpStatusCodes('[ERROR] Connection refused\nBUILD FAILURE'), []);
});

test('extractHttpStatusCodes never reads a real 3-digit code off the front of a longer, unrelated number', () => {
  assert.deepEqual(extractHttpStatusCodes('SOFTPLAY_HTTP_STATUS:20012345'), []);
});

test('injectJavaHttpStatusCapture inserts a REST Assured global filter immediately after the class\'s own opening brace, leaving the rest of the class untouched', () => {
  const original = [
    'import static io.restassured.RestAssured.*;',
    '',
    'public class GetUsersTest {',
    '  @Test',
    '  void getUsers() {',
    '    given().when().get("/users").then().statusCode(200);',
    '  }',
    '}'
  ].join('\n');
  const injected = injectJavaHttpStatusCapture(original, 'C:\\scratch\\softplay_http_status.log');

  // The exact original body (everything after the opening brace) must still
  // be present, unmodified and in order — this is an INSERTION, never a
  // rewrite of the generated code's own logic.
  const braceIndex = original.indexOf('{');
  const originalBody = original.slice(braceIndex + 1);
  assert.ok(injected.endsWith(originalBody), 'the original class body must be preserved verbatim after the injected block');

  // The injected static block itself must come BEFORE that original body,
  // register a global RestAssured filter, and append the exact marker
  // extractHttpStatusCodes() looks for to the given log file path (with the
  // Windows path's backslashes correctly doubled for a Java string literal).
  const injectedPrefix = injected.slice(0, injected.length - originalBody.length);
  assert.match(injectedPrefix, /public class GetUsersTest \{/);
  assert.match(injectedPrefix, /static \{/);
  assert.match(injectedPrefix, /io\.restassured\.RestAssured\.filters\(/);
  assert.match(injectedPrefix, /java\.nio\.file\.Paths\.get\("C:\\\\scratch\\\\softplay_http_status\.log"\)/);
  assert.match(injectedPrefix, /"SOFTPLAY_HTTP_STATUS:" \+ softPlayResponse\.getStatusCode\(\)/);
  assert.match(injectedPrefix, /StandardOpenOption\.CREATE, java\.nio\.file\.StandardOpenOption\.APPEND/);
});

test('injectJavaHttpStatusCapture escapes a Windows log path\'s backslashes correctly for a Java string literal', () => {
  const injected = injectJavaHttpStatusCapture('public class T {}', 'C:\\Users\\Test User\\scratch\\softplay_http_status.log');
  // Exactly one literal Java string containing the doubled-backslash form —
  // asserted precisely (not just "contains backslash") so a future change
  // to the escaping logic can't silently under- or over-escape.
  assert.match(injected, /Paths\.get\("C:\\\\Users\\\\Test User\\\\scratch\\\\softplay_http_status\.log"\)/);
});

test('injectJavaHttpStatusCapture handles a class declaration with an extends/implements clause', () => {
  const original = 'public class GetUsersTest extends BaseApiTest implements Runnable {\n  void run() {}\n}';
  const injected = injectJavaHttpStatusCapture(original, 'C:\\scratch\\softplay_http_status.log');
  assert.match(injected, /public class GetUsersTest extends BaseApiTest implements Runnable \{[\s\S]*static \{[\s\S]*void run\(\) \{\}/);
});

test('injectJavaHttpStatusCapture is a no-op (returns the input unchanged) when no "public class" declaration is found', () => {
  const original = 'class NotPublic {}';
  assert.equal(injectJavaHttpStatusCapture(original, 'C:\\scratch\\softplay_http_status.log'), original);
});
