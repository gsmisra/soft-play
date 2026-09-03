/**
 * Derives a test class name (Java) / module base name (Python) straight
 * from a linked Gherkin Scenario/Scenario Outline's own name — so the class
 * the LLM produces is recognizable as "the test for THIS scenario" rather
 * than a generic `TestExample`/`GeneratedTestAI`, per the explicit ask that
 * it match the scenario's name. English filler words (articles,
 * prepositions, conjunctions, auxiliary verbs, pronouns) are stripped first
 * so the result reads as a name, not a restated sentence — "Search for a
 * term and open the first result" becomes `SearchTermOpenFirstResult` /
 * `search_term_open_first_result`, not `SearchForATermAndOpenTheFirstResult`.
 */

// Deliberately a small, conservative set of genuinely meaningless-on-their-own
// English function words — never a domain word a real scenario name might
// need (e.g. "get", "set", "open", "close", "user", "page" all survive).
const STOP_WORDS = new Set([
  'a', 'an', 'the',
  'and', 'or', 'but', 'nor', 'so', 'yet',
  'of', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'over', 'under',
  'that', 'this', 'these', 'those', 'it', 'its',
  'i', 'me', 'my', 'you', 'your', 'he', 'she', 'we', 'they', 'his', 'her', 'our', 'their',
  'do', 'does', 'did', 'has', 'have', 'had', 'will', 'would', 'should', 'can', 'could',
  'not', 'no'
]);

/** Splits on anything that isn't a letter/digit, drops empty tokens and
 * stop words (case-insensitive) — what's left are the meaningful words a
 * class/module name should be built from. */
function meaningfulWords(scenarioName: string): string[] {
  return scenarioName
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word.toLowerCase()));
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** PascalCase, valid as a Java public class name — e.g. "Search for a term
 * and open the first result" -> "SearchTermOpenFirstResult". Falls back to
 * a safe default for an empty/all-stop-word/punctuation-only scenario name,
 * and prefixes a leading digit (an identifier can't start with one). */
export function deriveJavaClassName(scenarioName: string): string {
  const className = meaningfulWords(scenarioName).map(capitalize).join('');
  if (!className) {
    return 'GeneratedScenario';
  }
  return /^[0-9]/.test(className) ? `Scenario${className}` : className;
}

/** snake_case, valid as a Python module/file base name (no `.py` extension)
 * — e.g. "Search for a term and open the first result" ->
 * "search_term_open_first_result". Same fallback/leading-digit handling as
 * deriveJavaClassName(). */
export function derivePythonModuleName(scenarioName: string): string {
  const moduleName = meaningfulWords(scenarioName)
    .map((word) => word.toLowerCase())
    .join('_');
  if (!moduleName) {
    return 'generated_scenario';
  }
  return /^[0-9]/.test(moduleName) ? `scenario_${moduleName}` : moduleName;
}
