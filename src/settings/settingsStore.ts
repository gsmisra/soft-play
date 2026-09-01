import * as vscode from 'vscode';
import { LocatorType, BrowserChannel } from '../browser/browserManager';

export type Language = 'java' | 'python';

export interface ObjectSpySettings {
  locatorType: LocatorType;
  language: Language;
  languageVersion: string;
  /** Chrome or Edge only — this extension never downloads/bundles a browser
   * of its own (see chromeFinder.ts). Default Chrome. */
  browserChannel: BrowserChannel;
  /** "Link with GitHub Copilot LLM" toggle — see settingsPanel.ts and src/llm/copilotClient.ts. */
  copilotEnabled: boolean;
  /** LanguageModelChat.id of the selected Copilot model, or '' if none picked yet. */
  copilotModelId: string;
}

/**
 * Language/runtime versions offered per language. Purely a templating
 * concern for the Phase 4 code generator (idioms like Java's `var`, or
 * f-strings vs. older Python formatting) — it never affects how the
 * extension itself runs.
 */
export const LANGUAGE_VERSIONS: Record<Language, string[]> = {
  java: ['11', '17', '21'],
  python: ['3.9', '3.10', '3.11', '3.12']
};

const DEFAULTS: ObjectSpySettings = {
  // XPath by default: its axis-based fallbacks (following-sibling/preceding-
  // sibling, positional predicates) reach useful, unique locators in more
  // real-world markup shapes than CSS can on its own — see the locator
  // engine's tiering in agent/pageAgent.js.
  locatorType: 'xpath',
  language: 'java',
  languageVersion: '17',
  browserChannel: 'chrome',
  copilotEnabled: false,
  copilotModelId: ''
};

const STORAGE_KEY = 'objectSpy.settings';

/**
 * Owns Object Spy's persistent settings (locator type, language, language
 * version) — per the Master Build Prompt (§3.5), these live in
 * `context.globalState` rather than VS Code workspace settings, so the
 * Settings panel is the single source of truth (no separate settings.json
 * copy to drift out of sync with).
 */
export class SettingsStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ObjectSpySettings>();
  readonly onChange = this.changeEmitter.event;

  private current: ObjectSpySettings;

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.globalState.get<Partial<ObjectSpySettings>>(STORAGE_KEY);
    this.current = sanitize({ ...DEFAULTS, ...stored });
  }

  get(): ObjectSpySettings {
    return this.current;
  }

  async update(partial: Partial<ObjectSpySettings>): Promise<ObjectSpySettings> {
    this.current = sanitize({ ...this.current, ...partial });
    await this.context.globalState.update(STORAGE_KEY, this.current);
    this.changeEmitter.fire(this.current);
    return this.current;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** Guards against a language/version combination that doesn't actually exist
 * (e.g. settings persisted by a future version of the extension with a
 * language version this build doesn't know about). */
function sanitize(settings: ObjectSpySettings): ObjectSpySettings {
  const versions = LANGUAGE_VERSIONS[settings.language] ?? LANGUAGE_VERSIONS[DEFAULTS.language];
  if (!versions.includes(settings.languageVersion)) {
    return { ...settings, languageVersion: versions[0] };
  }
  return settings;
}
