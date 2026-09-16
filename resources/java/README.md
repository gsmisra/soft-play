# Bundled offline Maven repository (`m2repo/`)

Ships REST Assured, Playwright (Java), JUnit Jupiter, SLF4J, and Cucumber's
own jars — pre-resolved and vendored here — so **"Verify & Fix Code" (Java,
both UI and API Automation mode)** never has to reach Maven Central to
compile/run the AI-generated code. This is exactly what a bank/enterprise
machine with restricted or no internet egress needs.

`src/execution/testExecutor.ts` passes `-Dmaven.repo.local=<this folder>` to
every `mvn` invocation when it's present. That's a local-repo **location**
override, not `-o`/offline mode — Maven still reaches its normally configured
repositories for anything not already cached here, so nothing breaks if some
other dependency is ever needed. If this folder is missing (e.g. a fresh dev
checkout before running the prep step below), the flag is simply omitted and
Maven falls back to its own default local repo — no behavior change.

## Playwright's driver-bundle is deliberately NOT here

Playwright Java shells out to a bundled Node.js process to actually drive a
browser — its `driver-bundle` dependency is Node.js binaries for **every**
supported OS combined into one ~200MB jar. Vendoring that would dwarf
everything else here, so `javaPomXml()` excludes `driver-bundle` from the
`playwright` dependency and instead points Playwright at
`resources/java/node-win-x64/node.exe` (a single plain, official Node.js
Windows build, ~70MB) via the `PLAYWRIGHT_NODEJS_PATH` env var, set on the
surefire plugin. Windows-only — matches this extension's existing
Windows-only scope (see `detectPrimaryScreenSize()` in codegenManager.ts).
On any other OS, or if `node-win-x64/node.exe` is missing, the exclusion is
skipped and Playwright resolves its own (full, all-platform) `driver-bundle`
normally.

## Regenerating it

Only needed when the dependency versions in `testExecutor.ts`'s
`javaPomXml()` change (`REST_ASSURED_VERSION`, `PLAYWRIGHT_JAVA_VERSION`,
`JUNIT_JUPITER_VERSION`, `SLF4J_VERSION`, `CUCUMBER_VERSION`,
`JUNIT_PLATFORM_SUITE_VERSION`) or the Maven/JDK toolchain used to build
changes. From a machine with normal internet access:

```bash
mkdir -p /tmp/SoftPlay-javaprep && cd /tmp/SoftPlay-javaprep
cat > pom.xml <<'EOF'
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.SoftPlay.runner</groupId>
  <artifactId>SoftPlay-runner</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency><groupId>io.rest-assured</groupId><artifactId>rest-assured</artifactId><version>5.5.0</version></dependency>
    <dependency>
      <groupId>com.microsoft.playwright</groupId><artifactId>playwright</artifactId><version>1.62.0</version>
      <exclusions>
        <exclusion><groupId>com.microsoft.playwright</groupId><artifactId>driver-bundle</artifactId></exclusion>
      </exclusions>
    </dependency>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.11.0</version><scope>test</scope></dependency>
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-simple</artifactId><version>2.0.13</version></dependency>
    <dependency><groupId>io.cucumber</groupId><artifactId>cucumber-java</artifactId><version>7.18.0</version></dependency>
    <dependency><groupId>io.cucumber</groupId><artifactId>cucumber-junit-platform-engine</artifactId><version>7.18.0</version></dependency>
    <dependency><groupId>org.junit.platform</groupId><artifactId>junit-platform-suite</artifactId><version>1.11.0</version></dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.1</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version>
        <configuration>
          <environmentVariables>
            <PLAYWRIGHT_NODEJS_PATH>${playwright.nodejs.path}</PLAYWRIGHT_NODEJS_PATH>
          </environmentVariables>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
EOF
# 1) Resolve every dependency jar into the bundled repo (driver-bundle is
#    excluded above, so this never downloads that ~200MB all-platform blob).
mvn -q -B -Dmaven.repo.local=<repo>/resources/java/m2repo dependency:go-offline
# 2) Also pull in the Maven *plugin* jars the build lifecycle itself needs
#    (compiler/resources/surefire) by actually compiling+running real test
#    files against this same repo — dependency:go-offline alone does not
#    resolve plugin dependencies. Needs a real Chrome install and a plain
#    Node.js Windows binary extracted to <node.exe path> (download the
#    "win-x64" zip from https://nodejs.org/en/download and pull out just
#    node.exe — that's <repo>/resources/java/node-win-x64/node.exe).
mkdir -p src/test/java
cat > src/test/java/SampleApiTest.java <<'EOF'
import static io.restassured.RestAssured.given;
import org.junit.jupiter.api.Test;
public class SampleApiTest {
  @Test public void getRequestSucceeds() { given().when().get("https://httpbin.org/get").then().statusCode(200); }
}
EOF
cat > src/test/java/SampleUiTest.java <<'EOF'
import com.microsoft.playwright.*;
import org.junit.jupiter.api.Test;
public class SampleUiTest {
  @Test public void launchesRealChromeHeadless() {
    try (Playwright playwright = Playwright.create()) {
      Browser browser = playwright.chromium().launch(new BrowserType.LaunchOptions()
        .setExecutablePath(java.nio.file.Paths.get("C:/Program Files/Google/Chrome/Application/chrome.exe"))
        .setHeadless(true));
      browser.newPage().navigate("https://example.com");
      browser.close();
    }
  }
}
EOF
mvn -q -B -Dmaven.repo.local=<repo>/resources/java/m2repo -Dplaywright.nodejs.path=<repo>/resources/java/node-win-x64/node.exe test
# 3) Verify it's now fully self-contained:
mvn -q -B -o -Dmaven.repo.local=<repo>/resources/java/m2repo -Dplaywright.nodejs.path=<repo>/resources/java/node-win-x64/node.exe test
```

Confirm no `*.lastUpdated` files were left behind (`find resources/java/m2repo
-name "*.lastUpdated"` — a non-empty result means a download failed), and
confirm `com/microsoft/playwright/driver-bundle/` did NOT get vendored
(delete it if `dependency:go-offline` ever pulls it in anyway — some
Playwright versions resolve it eagerly regardless of the exclusion above),
before committing.
