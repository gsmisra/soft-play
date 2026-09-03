import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { Language } from '../settings/settingsStore';

export interface ExecutionResult {
  success: boolean;
  /** True when this ran as a compile/collect-only check rather than an
   * actual headless browser run — see the module doc comment below for
   * exactly when and why that happens (BDD-mode Java always; BDD-mode
   * Python falls back to this only if it can't resolve its feature file). */
  compileOnly: boolean;
  /** Combined stdout+stderr, tail-trimmed to a size sane to hand to an LLM. */
  output: string;
}

const MAX_OUTPUT_CHARS = 6000;

// `shell` defaults to false and is passed `true` only for `mvn` calls — see
// environmentCheck.ts's `run()` for the full rationale (mvn resolves to a
// `.cmd` launcher on Windows that plain execFile can't locate at all;
// python/pytest calls stay shell:false since none of their own args here
// contain spaces either, and false is the safer default regardless).
function run(command: string, args: string[], cwd: string, shell = false): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, windowsHide: true, timeout: 180_000, maxBuffer: 20 * 1024 * 1024, shell }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, output });
    });
  });
}

function tailOutput(output: string): string {
  return output.length > MAX_OUTPUT_CHARS ? `…(truncated)…\n${output.slice(-MAX_OUTPUT_CHARS)}` : output;
}

/**
 * Executes AI-generated Playwright code in a disposable scratch project
 * (never the user's own workspace) and reports whether it ran cleanly.
 *
 * BDD-mode caveat (see "Execute & Verify Code"'s design notes in
 * objectSpyPanel.ts): the generated code for a linked scenario is ONLY step
 * definitions (per prompts/senior-qe-instructions.md section 5) — there is
 * no separate Cucumber "Suite" runner class generated, so **Java** BDD-mode
 * code can only be compile-checked here (`mvn test-compile`), never
 * actually executed end to end. **Python** BDD-mode (pytest-bdd) needs no
 * separate runner — its `@scenario(...)`/`scenarios(...)` bind directly to
 * a real pytest test — so it DOES get a real execution attempt, with the
 * originally linked .feature file copied into the scratch dir (best-effort,
 * under both the plain filename and a `features/` subfolder, covering the
 * two conventions the LLM is likely to have referenced it by); if neither
 * matches whatever path the generated code actually references, that
 * failure becomes real, useful feedback for the fix-loop to correct.
 */
export async function executeGeneratedCode(
  language: Language,
  code: string,
  scratchDir: string,
  linkedFeatureFilePath: string | undefined,
  pythonCommand: string
): Promise<ExecutionResult> {
  return language === 'java'
    ? executeJava(code, scratchDir)
    : executePython(code, scratchDir, linkedFeatureFilePath, pythonCommand);
}

function isBddCode(code: string): boolean {
  return /io\.cucumber|pytest_bdd|@(Given|When|Then)\(|@(given|when|then)\(/.test(code);
}

// ---------------------------------------------------------------------------
// Java (Maven)
// ---------------------------------------------------------------------------

const PLAYWRIGHT_JAVA_VERSION = '1.62.0';
const JUNIT_JUPITER_VERSION = '5.11.0';
const SLF4J_VERSION = '2.0.13';
const CUCUMBER_VERSION = '7.18.0';
const JUNIT_PLATFORM_SUITE_VERSION = '1.11.0';

function javaPomXml(bdd: boolean): string {
  const cucumberDeps = bdd
    ? `
    <dependency>
      <groupId>io.cucumber</groupId>
      <artifactId>cucumber-java</artifactId>
      <version>${CUCUMBER_VERSION}</version>
    </dependency>
    <dependency>
      <groupId>io.cucumber</groupId>
      <artifactId>cucumber-junit-platform-engine</artifactId>
      <version>${CUCUMBER_VERSION}</version>
    </dependency>
    <dependency>
      <groupId>org.junit.platform</groupId>
      <artifactId>junit-platform-suite</artifactId>
      <version>${JUNIT_PLATFORM_SUITE_VERSION}</version>
    </dependency>`
    : '';
  return `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.softplay.runner</groupId>
  <artifactId>softplay-runner</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.microsoft.playwright</groupId>
      <artifactId>playwright</artifactId>
      <version>${PLAYWRIGHT_JAVA_VERSION}</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>${JUNIT_JUPITER_VERSION}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-simple</artifactId>
      <version>${SLF4J_VERSION}</version>
    </dependency>${cucumberDeps}
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

async function executeJava(code: string, scratchDir: string): Promise<ExecutionResult> {
  const classMatch = code.match(/public\s+class\s+(\w+)/);
  if (!classMatch) {
    return { success: false, compileOnly: false, output: 'Could not find a "public class <Name>" declaration in the generated Java code.' };
  }
  const className = classMatch[1];
  const bdd = isBddCode(code);

  const srcDir = path.join(scratchDir, 'src', 'test', 'java');
  await fs.promises.mkdir(srcDir, { recursive: true });
  // Clear any previous run's class(es) — a stale second .java file (a
  // different class name from a prior attempt) would otherwise sit there
  // and either fail to compile against this run's code or get picked up by
  // `mvn test` alongside it.
  for (const entry of await fs.promises.readdir(srcDir).catch(() => [] as string[])) {
    if (entry.endsWith('.java')) {
      await fs.promises.rm(path.join(srcDir, entry), { force: true });
    }
  }
  await fs.promises.writeFile(path.join(srcDir, `${className}.java`), code, 'utf8');
  await fs.promises.writeFile(path.join(scratchDir, 'pom.xml'), javaPomXml(bdd), 'utf8');

  const args = bdd
    ? ['-q', '-B', '-Dstyle.color=never', 'test-compile']
    : ['-q', '-B', '-Dstyle.color=never', `-Dtest=${className}`, 'test'];
  const result = await run('mvn', args, scratchDir, true);
  return { success: result.code === 0, compileOnly: bdd, output: tailOutput(result.output) };
}

// ---------------------------------------------------------------------------
// Python (pytest)
// ---------------------------------------------------------------------------

const SCRATCH_PY_FILENAME = 'test_ai_generated.py';

async function executePython(
  code: string,
  scratchDir: string,
  linkedFeatureFilePath: string | undefined,
  pythonCommand: string
): Promise<ExecutionResult> {
  await fs.promises.mkdir(scratchDir, { recursive: true });
  await fs.promises.writeFile(path.join(scratchDir, SCRATCH_PY_FILENAME), code, 'utf8');

  if (linkedFeatureFilePath) {
    try {
      const featureContent = await fs.promises.readFile(linkedFeatureFilePath, 'utf8');
      const baseName = path.basename(linkedFeatureFilePath);
      // Best-effort: cover both conventions a `@scenario('...')`/
      // `scenarios('...')` reference is likely to use (bare filename, or
      // under a "features/" subfolder) — see the module doc comment above.
      await fs.promises.writeFile(path.join(scratchDir, baseName), featureContent, 'utf8');
      const featuresDir = path.join(scratchDir, 'features');
      await fs.promises.mkdir(featuresDir, { recursive: true });
      await fs.promises.writeFile(path.join(featuresDir, baseName), featureContent, 'utf8');
    } catch {
      // Linked file vanished/moved since it was linked — proceed without
      // it; a pytest-bdd FileNotFoundError becomes real fix-loop feedback.
    }
  }

  // Headless by default (pytest-playwright only switches to headed with an
  // explicit --headed flag, which is never passed here) — belt-and-braces
  // on top of whatever `headless` value the generated code's own
  // `browser_type_launch_args` override sets.
  const result = await run(pythonCommand, ['-m', 'pytest', SCRATCH_PY_FILENAME, '-q'], scratchDir);
  return { success: result.code === 0, compileOnly: false, output: tailOutput(result.output) };
}
