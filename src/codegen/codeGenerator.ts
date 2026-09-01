import { LocatorType, BrowserChannel } from '../browser/browserManager';
import { Language } from '../settings/settingsStore';

export type ActionType = 'click' | 'fill' | 'selectOption' | 'check' | 'uncheck' | 'press';

export interface RecordedAction {
  actionType: ActionType;
  tag: string;
  text: string;
  /** Short camelCase name (see agent/pageAgent.js elementNameFor()) — the
   * source for this locator's generated constant name (see LocatorConstant). */
  elementName: string;
  locatorType: LocatorType;
  locator: string;
  tier: 'testid' | 'id' | 'aria' | 'css' | 'sibling' | 'index' | 'xpath';
  qualityLabel: string;
  matches: number;
  value?: string;
  /** True for a click on an <a>, a submit button, or an input[type=submit|button]. */
  submitLike?: boolean;
}

interface LocatorConstant {
  constName: string;
  locator: string;
}

interface Step {
  methodName: string;
  action: RecordedAction;
  takesValue: boolean;
}

/**
 * Maps recorded browser actions to enterprise-grade Playwright automation
 * code in Java or Python, per the Master Build Prompt (§3.6). This is a
 * from-scratch template layer — it does NOT depend on any of Playwright's
 * internal/unexported codegen classes, which are not public API and would
 * break across Playwright versions.
 *
 * Output is Page-Object-ready rather than a flat script: one generated
 * "GeneratedPage" class exposes one fluent method per unique
 * (action type, locator) pair, and a separate test composes them in the
 * order they were recorded. Re-recording the same locator (e.g. typing into
 * the same field twice) reuses its existing method instead of duplicating
 * one. Wait/assertion strategy: Playwright's own action methods
 * (click/fill/...) already auto-wait for actionability, so no arbitrary
 * sleeps are ever emitted; on top of that, a fill/select/check step asserts
 * the field actually reflects the value afterward, and a click identified
 * as submit-like (an <a>, a submit button, or input[type=submit|button])
 * is followed by a load-state wait, so a flow that navigates doesn't race
 * the next step against a still-loading page.
 *
 * Locators are never inlined as string literals in the Page Object methods
 * — every unique locator gets one named constant (in a generated `Locators`
 * class/holder, keyed by the same elementName used in the Elements table
 * and its JSON/.properties export) that methods reference symbolically, so
 * a locator only ever needs updating in one place and the flow methods stay
 * readable and properly parameterized rather than hardcoded.
 */
export class CodeGenerator {
  private readonly actions: RecordedAction[] = [];

  addAction(action: RecordedAction): void {
    this.actions.push(action);
  }

  reset(): void {
    this.actions.length = 0;
  }

  getActions(): readonly RecordedAction[] {
    return this.actions;
  }

  /**
   * `pageTitle` — the last-navigated page's <title>, used to name the
   * generated class (e.g. "Apple" -> ApplePage/AppleTest) instead of a
   * generic "GeneratedPage"/"GeneratedTest". Falls back to "Generated" when
   * empty or unusable as an identifier.
   *
   * `browserChannel` — Chrome or Edge, per Settings. The generated Java
   * launch call uses Playwright's `channel` option so it drives the real,
   * already-installed browser rather than downloading Playwright's own
   * bundled Chromium (this extension only ever depends on `playwright-core`
   * itself for the same reason — see chromeFinder.ts). Python's generated
   * test relies on the `pytest-playwright` plugin's `page` fixture, which
   * takes the channel from a `--browser-channel` CLI flag instead of inline
   * code — a header comment tells the user which one to pass.
   */
  generate(language: Language, languageVersion: string, pageTitle: string, browserChannel: BrowserChannel): string {
    const { callSteps, definitionSteps } = buildSteps(this.actions, language);
    const locatorConstants = buildLocatorConstants(this.actions);
    const className = classNameFromTitle(pageTitle);
    return language === 'java'
      ? generateJava(callSteps, definitionSteps, languageVersion, className, browserChannel, locatorConstants)
      : generatePython(callSteps, definitionSteps, languageVersion, className, browserChannel, locatorConstants);
  }
}

/**
 * One named constant per unique locator (deduped by the locator string
 * itself, independent of which action(s) use it — e.g. a checkbox that gets
 * both clicked and checked shares one constant) — named after elementName,
 * the same key already used for the Elements table and its JSON/.properties
 * export, so the two stay obviously in sync. Collisions get a numeric
 * suffix, same convention as method naming below.
 */
function buildLocatorConstants(actions: RecordedAction[]): Map<string, LocatorConstant> {
  const byKey = new Map<string, LocatorConstant>();
  const usedNames = new Set<string>();

  for (const action of actions) {
    const key = action.locatorType + '|' + action.locator;
    if (byKey.has(key)) {
      continue;
    }
    // Reuse the Element Name column's value verbatim as the code identifier
    // — no case transformation (no UPPER_SNAKE_CASE) — so the exact same
    // string a user sees in the Locator Output table is what shows up in
    // the generated code. elementNameFor() (agent/pageAgent.js) already
    // guarantees this is letters/digits only and never starts with a digit;
    // sanitizeIdentifier() is just a defensive fallback for the rare case
    // where elementName is missing and slugSource() is used instead.
    const base = sanitizeIdentifier(action.elementName || slugSource(action));
    let constName = base;
    let suffix = 2;
    while (usedNames.has(constName)) {
      constName = `${base}${suffix}`;
      suffix++;
    }
    usedNames.add(constName);
    byKey.set(key, { constName, locator: action.locator });
  }

  return byKey;
}

function locatorConstantFor(action: RecordedAction, locatorConstants: Map<string, LocatorConstant>): string {
  const key = action.locatorType + '|' + action.locator;
  // Always present -- buildLocatorConstants() covers every action passed to
  // buildSteps()/this function from the very same this.actions array.
  return locatorConstants.get(key)!.constName;
}

/** Guarantees a valid Java/Python identifier without changing the casing of
 * an already-valid one — letters/digits only, never starting with a digit. */
function sanitizeIdentifier(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]/g, '').replace(/^[0-9]+/, '');
  return cleaned || 'locator';
}

/** Sanitizes a page title into a PascalCase identifier suitable as a Java/
 * Python class name base — e.g. "Apple Store - Buy iPhone" -> "AppleStoreBuyIPhone". */
function classNameFromTitle(title: string): string {
  const words = title
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const base = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  // Identifiers can't start with a digit; strip any leading ones.
  const cleaned = base.replace(/^[0-9]+/, '');
  return cleaned || 'Generated';
}

/** "AppleStoreBuyIPhone" -> "apple_store_buy_i_phone" — used for Python's
 * instance variable / test function naming, derived from classNameFromTitle's
 * PascalCase output rather than re-deriving from the raw title. */
function pascalToSnake(pascal: string): string {
  return pascal.replace(/([A-Z])/g, (_match, letter: string, offset: number) =>
    (offset > 0 ? '_' : '') + letter.toLowerCase()
  );
}

// ---------------------------------------------------------------------
// Shared step-building: dedupe actions into named Page Object methods
// ---------------------------------------------------------------------

/**
 * Returns two lists sharing method names but not step identity:
 *  - callSteps: one entry per *recorded* action, in order — each carries
 *    that specific occurrence's own value (e.g. the same field filled twice
 *    with two different values must call the same method twice, each time
 *    with ITS OWN value, not the first occurrence's).
 *  - definitionSteps: one entry per unique (action type, locator) pair, used
 *    only to emit each Page Object method once.
 */
function buildSteps(actions: RecordedAction[], language: Language): { callSteps: Step[]; definitionSteps: Step[] } {
  const callSteps: Step[] = [];
  const definitionSteps: Step[] = [];
  const nameByKey = new Map<string, string>();
  const usedNames = new Set<string>();

  for (const action of actions) {
    const key = action.actionType + '|' + action.locatorType + '|' + action.locator;
    const takesValue = action.actionType === 'fill' || action.actionType === 'selectOption';
    let methodName = nameByKey.get(key);
    if (methodName === undefined) {
      methodName = uniqueMethodName(action, usedNames, language);
      nameByKey.set(key, methodName);
      definitionSteps.push({ methodName, action, takesValue });
    }
    // Each call in the flow keeps ITS OWN action (and thus its own value) —
    // only the definition is deduplicated.
    callSteps.push({ methodName, action, takesValue });
  }

  return { callSteps, definitionSteps };
}

function uniqueMethodName(action: RecordedAction, used: Set<string>, language: Language): string {
  const verb: Record<ActionType, string> = {
    click: 'click',
    fill: 'fill',
    selectOption: 'select',
    check: 'check',
    uncheck: 'uncheck',
    press: 'press'
  };
  const words = wordsFrom(slugSource(action));
  let base = language === 'java' ? toCamelCase(verb[action.actionType], words) : toSnakeCase(verb[action.actionType], words);

  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = base + suffix;
    suffix++;
  }
  used.add(name);
  return name;
}

/** Picks the most human-readable hint available for naming a step's method. */
function slugSource(action: RecordedAction): string {
  if (action.text) {
    return action.text;
  }
  const testIdMatch = action.locator.match(/data-(?:testid|test|qa|cy|automation-id)="([^"]+)"/);
  if (testIdMatch) {
    return testIdMatch[1];
  }
  const nameMatch = action.locator.match(/\[name="([^"]+)"\]/);
  if (nameMatch) {
    return nameMatch[1];
  }
  const placeholderMatch = action.locator.match(/placeholder="([^"]+)"/);
  if (placeholderMatch) {
    return placeholderMatch[1];
  }
  const idMatch = action.locator.match(/#([\w-]+)/) || action.locator.match(/@id='([^']+)'/);
  if (idMatch) {
    return idMatch[1];
  }
  return action.tag || 'element';
}

function wordsFrom(text: string): string[] {
  return text
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5); // keep method names readable
}

function toCamelCase(verb: string, words: string[]): string {
  const rest = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  return verb + rest;
}

function toSnakeCase(verb: string, words: string[]): string {
  const rest = words.map((w) => w.toLowerCase()).join('_');
  return rest ? verb + '_' + rest : verb;
}

// ---------------------------------------------------------------------
// Java (JUnit 5) template
// ---------------------------------------------------------------------

function generateJava(
  callSteps: Step[],
  definitionSteps: Step[],
  version: string,
  className: string,
  browserChannel: BrowserChannel,
  locatorConstants: Map<string, LocatorConstant>
): string {
  // §3.5: version affects idioms, not behavior. NOTE: `var` is only legal
  // for a local variable declared with an inline initializer — never for a
  // field (even on Java 21, `var playwright;` is a compile error). So the
  // idiom applies to each Page Object method's local `target` declaration
  // below, not to the test class's fields, which stay explicitly typed.
  const useVar = parseInt(version, 10) >= 17;
  const playwrightChannel = browserChannel === 'edge' ? 'msedge' : 'chrome';
  const pageClass = `${className}Page`;
  const testClass = `${className}Test`;
  const instanceVar = pageClass.charAt(0).toLowerCase() + pageClass.slice(1);

  const pageObjectMethods = definitionSteps
    .map((step) => javaPageObjectMethod(step, useVar, pageClass, locatorConstants))
    .join('\n\n');

  const locatorsClass =
    locatorConstants.size > 0
      ? `/**
 * Centralized locator constants — never hardcoded inline in ${pageClass}, so
 * an application change only ever needs updating in exactly one place.
 * Field names intentionally match the Locator Output table's Element Name
 * column and its JSON/.properties export exactly (camelCase, not the usual
 * Java UPPER_SNAKE_CASE for constants) so the same name identifies a
 * locator everywhere — the table, the exported file, and here.
 */
class Locators {
${Array.from(locatorConstants.values())
  .map((c) => `  static final String ${c.constName} = ${javaString(c.locator)};`)
  .join('\n')}

  private Locators() {}
}

`
      : '';

  const flowCalls =
    callSteps.length === 0
      ? '    // No actions recorded yet — interact with the browser while Generate Code is running.'
      : `    ${instanceVar}\n` + callSteps.map((s) => `      .${s.methodName}(${javaCallArgs(s)})`).join('\n') + ';';

  return `package com.example.tests;

import com.microsoft.playwright.*;

import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;

${locatorsClass}/**
 * Page Object generated by softPlay, named for the page it was recorded on.
 * Locators are short and relative (never absolute XPath or a full-path CSS
 * selector) and were verified unique against the live page at capture time.
 */
class ${pageClass} {
  private final Page page;

  ${pageClass}(Page page) {
    this.page = page;
  }

${pageObjectMethods || '  // No actions recorded yet.'}
}

/**
 * Generated by softPlay. See ${pageClass} for the page object itself —
 * this test only composes its methods in the order they were recorded.
 */
public class ${testClass} {
  Playwright playwright;
  Browser browser;
  Page page;
  ${pageClass} ${instanceVar};

  @BeforeEach
  void setUp() {
    playwright = Playwright.create();
    // channel("${playwrightChannel}") drives the real, already-installed
    // browser — Playwright never downloads its own bundled browser binary
    // when a channel is specified.
    browser = playwright.chromium().launch(new BrowserType.LaunchOptions().setHeadless(false).setChannel("${playwrightChannel}"));
    page = browser.newPage();
    ${instanceVar} = new ${pageClass}(page);
  }

  @AfterEach
  void tearDown() {
    browser.close();
    playwright.close();
  }

  @Test
  void recordedFlow() {
${flowCalls}
  }
}
`;
}

function javaPageObjectMethod(
  step: Step,
  useVar: boolean,
  pageClass: string,
  locatorConstants: Map<string, LocatorConstant>
): string {
  const { action, methodName, takesValue } = step;
  const params = takesValue ? 'String value' : '';
  const locatorExpr = `page.locator(Locators.${locatorConstantFor(action, locatorConstants)})`;
  const targetType = useVar ? 'var' : 'Locator'; // legal here: a local with an inline initializer
  // A line comment, not a /** */ block: describeAction()'s text is
  // arbitrary page content and could in principle contain "*/", which would
  // terminate a block comment early.
  const lines: string[] = [
    `  // ${describeAction(action)}`,
    `  ${pageClass} ${methodName}(${params}) {`,
    `    ${targetType} target = ${locatorExpr};`
  ];

  switch (action.actionType) {
    case 'click':
      lines.push('    target.click();');
      if (action.submitLike) {
        lines.push('    page.waitForLoadState(); // submit-like click — let a navigation settle before the next step');
      }
      break;
    case 'fill':
      lines.push('    target.fill(value);');
      lines.push('    assertThat(target).hasValue(value);');
      break;
    case 'selectOption':
      lines.push('    target.selectOption(value);');
      lines.push('    assertThat(target).hasValue(value);');
      break;
    case 'check':
      lines.push('    target.check();');
      lines.push('    assertThat(target).isChecked();');
      break;
    case 'uncheck':
      lines.push('    target.uncheck();');
      lines.push('    assertThat(target).not().isChecked();');
      break;
    case 'press':
      lines.push(`    target.press(${javaString(action.value ?? 'Enter')});`);
      break;
  }

  lines.push('    return this;');
  lines.push('  }');
  return lines.join('\n');
}

function javaCallArgs(step: Step): string {
  return step.takesValue ? javaString(step.action.value ?? '') : '';
}

function javaString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ---------------------------------------------------------------------
// Python (pytest) template
// ---------------------------------------------------------------------

function generatePython(
  callSteps: Step[],
  definitionSteps: Step[],
  version: string,
  className: string,
  browserChannel: BrowserChannel,
  locatorConstants: Map<string, LocatorConstant>
): string {
  const typed = compareVersions(version, '3.9') >= 0; // all supported versions accept type hints
  const playwrightChannel = browserChannel === 'edge' ? 'msedge' : 'chrome';
  const pageClass = `${className}Page`;
  const instanceVar = pascalToSnake(className) || 'generated_page';
  const testName = `test_${instanceVar}_flow`;

  const pageObjectMethods = definitionSteps
    .map((step) => pythonPageObjectMethod(step, typed, pageClass, locatorConstants))
    .join('\n\n');

  const flowCalls =
    callSteps.length === 0
      ? '    # No actions recorded yet — interact with the browser while Generate Code is running.'
      : `    (\n        ${instanceVar}\n` +
        callSteps.map((s) => `        .${s.methodName}(${pythonCallArgs(s)})`).join('\n') +
        '\n    )';

  const signature = typed ? `def ${testName}(page: Page) -> None:` : `def ${testName}(page):`;

  const locatorsClass =
    locatorConstants.size > 0
      ? `class Locators:
    """Centralized locator constants -- never hardcoded inline in ${pageClass},
    so an application change only ever needs updating in exactly one place.
    Attribute names intentionally match the Locator Output table's Element
    Name column and its JSON/.properties export exactly (camelCase, not the
    usual Python UPPER_SNAKE_CASE for constants) so the same name identifies
    a locator everywhere -- the table, the exported file, and here.
    """

${Array.from(locatorConstants.values())
  .map((c) => `    ${c.constName} = ${pythonString(c.locator)}`)
  .join('\n')}


`
      : '';

  return `# Run with: pytest --browser-channel=${playwrightChannel}
# (drives the real, already-installed browser -- Playwright never downloads
# its own bundled browser binary when a channel is specified)
import pytest
from playwright.sync_api import Page, expect


${locatorsClass}class ${pageClass}:
    """Page Object generated by softPlay, named for the page it was recorded
    on. Locators are short and relative (never absolute XPath or a
    full-path CSS selector) and were verified unique against the live page
    at capture time.
    """

    def __init__(self, page${typed ? ': Page' : ''}) -> None:
        self.page = page

${pageObjectMethods || '    # No actions recorded yet.'}


${signature}
    ${instanceVar} = ${pageClass}(page)
${flowCalls}
`;
}

function pythonPageObjectMethod(
  step: Step,
  typed: boolean,
  pageClass: string,
  locatorConstants: Map<string, LocatorConstant>
): string {
  const { action, methodName, takesValue } = step;
  const params = takesValue ? (typed ? ', value: str' : ', value') : '';
  const returnType = typed ? ` -> "${pageClass}"` : '';
  // A plain comment, not a docstring: describeAction()'s text can itself
  // contain a trailing double-quote (e.g. `Click "Log In"`), which would
  // collide with a """..."""-style docstring's own closing delimiter.
  const lines: string[] = [
    `    # ${describeAction(action)}`,
    `    def ${methodName}(self${params})${returnType}:`,
    `        target = self.page.locator(Locators.${locatorConstantFor(action, locatorConstants)})`
  ];

  switch (action.actionType) {
    case 'click':
      lines.push('        target.click()');
      if (action.submitLike) {
        lines.push('        self.page.wait_for_load_state()  # submit-like click — let a navigation settle');
      }
      break;
    case 'fill':
      lines.push('        target.fill(value)');
      lines.push('        expect(target).to_have_value(value)');
      break;
    case 'selectOption':
      lines.push('        target.select_option(value)');
      lines.push('        expect(target).to_have_value(value)');
      break;
    case 'check':
      lines.push('        target.check()');
      lines.push('        expect(target).to_be_checked()');
      break;
    case 'uncheck':
      lines.push('        target.uncheck()');
      lines.push('        expect(target).not_to_be_checked()');
      break;
    case 'press':
      lines.push(`        target.press(${pythonString(action.value ?? 'Enter')})`);
      break;
  }

  lines.push('        return self');
  return lines.join('\n');
}

function pythonCallArgs(step: Step): string {
  return step.takesValue ? pythonString(step.action.value ?? '') : '';
}

function pythonString(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function describeAction(action: RecordedAction): string {
  const target = action.text ? `"${action.text}"` : action.tag;
  switch (action.actionType) {
    case 'click':
      return `Click ${target}`;
    case 'fill':
      return `Type into ${target}`;
    case 'selectOption':
      return `Select an option in ${target}`;
    case 'check':
      return `Check ${target}`;
    case 'uncheck':
      return `Uncheck ${target}`;
    case 'press':
      return `Press "${action.value}" on ${target}`;
    default:
      return '';
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
