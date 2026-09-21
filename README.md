# SoftPlay

A VS Code extension that puts Playwright's own real `codegen` tool one click
away in the Activity Bar, links what it records to a Cucumber Gherkin
scenario, and hands the result to GitHub Copilot for an enterprise-grade,
AI-refined Java or Python test — proper waits, real logging, zero hardcoded
values, and (when a scenario is linked) correctly wired BDD step
definitions.

## Developers

- WenYi Tan
- Alicia Loh
- Roshan Ranasinghe
- Gaurav Misra

## How it works

1. **Start** (Control Panel) launches Playwright's own `codegen` tool in its
   own browser window, using the language, browser (Chrome/Edge), and URL
   you've set. Interact with that window normally — clicks, typing,
   navigation — and codegen writes real Playwright code as you go.
2. **Generated Code** shows exactly what codegen wrote, streamed live and
   verbatim — no reformatting, no substituted locators. It's still editable
   and has its own **Save Code**/**Copy Code**.
3. Optionally, **Link Feature File** ties a Cucumber `.feature` file's
   Scenario/Scenario Outline to the session (see below).
4. With GitHub Copilot linked (Settings), **AI Generated Code** fills in
   automatically as codegen's output updates — the raw code, the linked
   Gherkin scenario (if any), and a comprehensive built-in instruction set
   are sent to your chosen Copilot model, which returns a production-ready
   rewrite: explicit visible/enabled waits before every action, try/catch
   with real logging, every value hoisted to a named constant, and (with a
   linked scenario) proper `Given`/`When`/`Then` step definitions.
5. **Stop**/**Kill All Browsers** tears down the codegen browser; **Link
   Feature File**'s badge and the AI Copilot link both persist across
   sessions so you can regenerate with the same scenario as many times as
   you like.

## Start/Stop — Playwright's own `codegen`, not a reimplementation

Click **Start** to launch `playwright codegen` for real, as a child process
this extension spawns and owns:

- The URL typed into the box (optional) is passed as codegen's positional
  argument. Leave it blank to have codegen open on a blank page and type
  your own starting URL into its own address bar instead — exactly like
  running `playwright codegen` by hand with no URL.
- **Language** and **language / runtime version** (Settings) drive codegen's
  own `--target` flag (`java-junit` for Java, `python-pytest` for Python).
- **Browser** (Settings, Chrome or Edge) drives codegen's own `--channel`
  flag, so it drives your real, already-installed system browser — never
  one of Playwright's own bundled binaries.
- **Stop** (or **Kill All Browsers**) terminates that process; its browser
  goes down with it via the OS's own process-tree cleanup — no separate
  step needed to close the browser window yourself.

**No browser is ever downloaded**, even though the full `playwright` package
(not just `playwright-core`) is a real dependency of this extension — it's
needed only for the `codegen` CLI file itself. Its own bundled-browser
download step is disabled at install time for this whole project (see
`.npmrc`'s `playwright_skip_browser_download=1`, plus a redundant
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in `build-extension.bat`), so nothing
is ever fetched at build time or runtime — verified end-to-end: launching,
letting it record, reading its live output file, and terminating it all
confirmed to work with zero downloads and zero leftover processes.

## Generated Code

Streams `codegen`'s output file's content verbatim as it updates — this is
deliberately raw, unmodified `codegen` output, not a custom template. It's a
real, editable code editor: syntax-highlighted, with line numbers down its
left margin, Tab/Shift+Tab indenting the current line or selection, and all
the native text-editing behavior a `<textarea>` already gives for free
(cut/copy/paste, undo/redo, find-in-page via the browser). A manual edit is
never silently overwritten by the next update — a small banner offers
**Refresh** instead. **Save Code** writes the current editor contents to a
file; **Copy Code** copies it to the clipboard (falling back to a
hidden-textarea copy if the browser Clipboard API is unavailable in the
webview). A **▾/▸** button in its header collapses the panel down to just
its header.

## Link Feature File (BDD)

Ties a Cucumber Gherkin `.feature` file's Scenario/Scenario Outline to
whatever gets generated next, so the AI refinement pipeline produces
proper, linked BDD step definitions instead of a plain page object/test.

1. Click **Link Feature File**, pick a `.feature` file. It opens in a
   separate view: Feature title/description, an optional **Background**
   block, then every **Scenario**/**Scenario Outline** as its own
   syntax-highlighted, individually selectable segment (radio button) —
   Gherkin keywords (`Feature`/`Background`/`Scenario`/`Scenario Outline`/
   `Given`/`When`/`Then`/`And`/`But`/`Examples`) bold+italic in their own
   color, `"quoted"`/`<placeholder>` parameter values highlighted distinctly,
   plain step text in light gray on black, and every data table/Examples
   cell in bright yellow.
2. Pick a Scenario/Scenario Outline, click **Use Selected Scenario**. A
   badge appears in the Control Panel (`Feature › Scenario: name`) — the
   feature-file view can now be closed or switched away from freely; the
   selection lives in the extension, not in that view.
3. **Start**, interact with the codegen window as usual. Whenever code is
   refined by AI — automatically, or via the chat composer — the linked
   scenario's exact Gherkin text (Background included) is sent alongside
   the generated code and the built-in senior-QE instructions, which cover
   producing real BDD step definitions: **Cucumber-JVM** for Java,
   **pytest-bdd** for Python (there's no single BDD tool that works in both
   languages, so each gets its real, idiomatic one) — every
   `Given`/`When`/`Then`/`And`/`But` line gets its own step definition,
   correctly resolving `And`/`But` to the nearest preceding primary
   keyword, with a traceability comment quoting the exact Gherkin line
   above each one, parameterized steps/data tables/doc strings handled per
   that framework's real API, and zero hardcoded values.
4. **The linked file stays available for the rest of the session — closing
   the view never requires re-linking.** Once opened, a file is cached in
   memory: clicking the badge text, or clicking the Control Panel's button
   again (now relabeled **View Feature File**), reopens it instantly with
   no OS file-browse dialog, so you can pick a **different** scenario from
   it as many times as you like. The button only goes back to browsing
   (**Link Feature File**) if nothing has been linked yet. The only ways
   the linked file itself actually changes are: clicking **Browse Different
   File…** inside that view (an explicit, deliberate switch to a different
   `.feature` file), or closing VS Code — never just closing the view.
   Regenerating with the **same** scenario needs nothing further: the link
   persists across Start/Stop and Kill All Browsers on its own, and is
   cleared only by linking a different file/scenario or the badge's **✕**.

## AI-refined code, automatically

Whenever **Link with GitHub Copilot LLM** is on and a model is picked in
Settings, the **AI Generated Code** panel is kept current on its own — no
send button to click at all. A short debounce (1.5s of no update) after
codegen's output file changes triggers a refinement request automatically;
checking a `.github/*.md` file's checkbox (see "Custom md files" below)
also triggers one immediately, so the effect of a selection is visible
right away instead of waiting for the next codegen update.

Every refinement request always includes a bundled, built-in instruction
set (`prompts/senior-qe-instructions.md`, shipped with the extension) asking
the model to make only light, minimal changes to the recording (UI Automation,
Java and Python):

- **Stay close to the recording** — the same steps, order, and flow Playwright
  codegen recorded; no Page Object Model, no wrapper/nested/child classes, no
  inheritance. Only the necessary JUnit annotations (`@Test`, plus
  `@BeforeAll`/`@AfterAll`/`@BeforeEach`/`@AfterEach` only where browser
  init/clean-up needs them).
- **Zero hardcoded values anywhere** — every locator's selector text, URL,
  entered value, timeout, and expected value as a named constant in one block
  at the top of the class (Java `static final` fields / Python module-level
  constants), reused by reference, never re-embedded as a literal.
- **Minimal synchronization** — Playwright's own auto-wait by default,
  explicit waits only where a recorded step clearly needs one, never a fixed
  sleep.
- **Basic error handling and logging** — a lightweight try/catch (Java) or
  try/except (Python) around each test body / major section, never silently
  swallowed, always re-raised after logging; SLF4J in Java, the standard
  `logging` module in Python (`INFO`/`WARN`/`ERROR` as fits), short and
  practical.
- **Reusable screenshot step** — one small helper called at the end of every
  test and before a form submit / navigation away, saving a full-page,
  date-and-time-stamped PNG to your `Documents` folder (a screenshot failure
  only logs a warning, it never fails the test).
- **BDD step definitions** (only when a Gherkin scenario is linked — see
  above) — Cucumber-JVM for Java, pytest-bdd for Python.

Automatic requests reuse this extension's own Copilot session and consent
(the same "Link with GitHub Copilot LLM" opt-in and VS Code's own one-time
Language Model API consent dialog both still apply) — nothing is sent
anywhere without that already being turned on.

## Custom md files (GitHub Copilot AI Assist)

Requires the **GitHub Copilot Chat** extension installed and signed in.
SoftPlay never bundles or hardcodes a model list — it asks VS Code's
Language Model API (`vscode.lm.selectChatModels`) what's actually available
at the moment you enable this, so whatever models your Copilot
subscription/extension version exposes are what show up.

1. Open **Settings**, turn on **Link with GitHub Copilot LLM**, and pick a
   model from the dropdown (populated live from Copilot — "No Copilot chat
   models found" means Copilot Chat isn't installed or you're not signed
   in). This reveals a collapsible **Custom md files** section and an **Open
   AI Generated Code** button in the main panel.
2. Expand **Custom md files**. It auto-detects every `.github/**/*.md` file
   in your workspace (instructions, skills, custom prompts). **There is no
   separate send button** — checking a file's checkbox is itself the
   action: the extension tracks the current selection and folds whichever
   files are checked into every refinement automatically, both the
   automatic post-recording pipeline and the chat composer's manual send
   below. **Files you check take the highest priority:** only the checked
   files are sent, and the prompt tells the model that, wherever they
   conflict with SoftPlay's built-in refinement standard, reusable
   components (RAG), example code **or your own chat instructions**, your
   checked files win (in UI and API Automation, Java and Python, for both
   generation and **Regenerate AI Code** — the selection is re-read every
   time). A few things the environment depends on are never overridden: the
   target language/version, the Chrome/Edge launch requirement, Auto
   Password Encryption, and the output format. An instruction the model has
   to set aside (a chat instruction a checked file overrules, or a file rule
   that would break one of those four) is named in a short comment near the
   top of the generated code rather than dropped silently. **If a checked
   file can't be read** (deleted, renamed, no access, no workspace open),
   generation stops before anything is sent, names the file, and asks you to
   restore it or uncheck it. If nothing is checked, every `.github/*.md`
   file (except `.github/rag/`) is sent as ordinary project guidance,
   without that priority. Click **Refresh file list** if you add files after
   opening the panel.

   **RAG Data** works the same way for reusable-component recipes in
   `.github/rag/`. With nothing checked, matching stays automatic and
   optional ("reuse the ones that genuinely fit"). **Recipes you check hold
   the same top priority as checked Custom md files:** each one is sent **in
   full** (no size cap or trimming, even when "Use reusable components" is
   off) and the prompt tells the model to use every one, called exactly as
   shown with its imports copied verbatim, and to outrank the built-in
   standard, example code and your chat instructions (UI and API, Java and
   Python, **Regenerate AI Code**, and feature-file generation, where a
   recipe is used as scenario context and no code or imports are added). If
   a checked recipe and a checked Custom md file genuinely conflict, neither
   simply wins: the model follows the more specific rule and names both in a
   comment at the top of the code. Anything it sets aside is named there too,
   never dropped silently. **If a checked recipe can't be used** (missing,
   unreadable, not a valid recipe, not tagged for the selected language, or
   no workspace open), or the selection alone is too large for the model's
   context window, generation stops before anything is sent (or, if the model
   itself refuses, is never silently retried without your recipes) and tells
   you which file to fix or uncheck — a checked recipe is never trimmed or
   dropped to make a request fit.
3. The chat composer underneath is for **free-text instructions** — type
   something and press Enter (or click ➤) to trigger an immediate
   refinement request combining that text, whatever `.md` files are
   currently checked, the linked Gherkin scenario (if any), and the current
   **Generated Code** view's content as a style reference. Sending a message
   this way also opens the AI panel automatically, since asking is a
   deliberate "show me the result" action.
4. **AI Generated Code opens as its own full-size panel** — click **Open AI
   Generated Code** (or send a chat message) to open it beside the sidebar,
   the same way **Settings** does, rather than sharing cramped sidebar space
   with the Playwright Code view. It's a real editor with the same
   line-numbered gutter, syntax highlighting, and Tab-indenting as the
   Playwright Code view, plus its own **Copy Code**/**Save Code**. The
   response streams into it live as it arrives. A small status next to
   **Open AI Generated Code** ("(generating…)"/"Error") keeps you informed
   even while that panel is closed; opening it (or just leaving it open
   across requests) always shows the current/latest state. While a request
   is in flight, the **Generated Code** section also shows a bright-green
   "Generating AI code…" label with a sliding progress bar, visible even if
   the AI panel itself is closed.
5. **Regenerate AI Code** — the AI Generated Code panel has its own
   **Regenerate AI Code** button that re-runs the same refinement without
   needing to re-record anything. It re-fetches the Playwright Code editor's
   *current* content (including any manual edits you've made since the last
   generation), plus the current Settings (language, language/runtime
   version, browser), the linked Gherkin scenario, and whichever Custom
   `.md` files are checked — then sends that fresh combination to the LLM.
   Use it after switching, say, Python to Java, bumping a language version,
   editing the Playwright Code by hand, re-recording, or (un)checking
   instruction files, to get an updated AI Generated Code without leaving
   the panel.

**Consent:** the first time any extension calls the Language Model API in a
session, VS Code shows a one-time permission dialog — that's Copilot's own
gate, not something SoftPlay controls. This can be triggered either by the
chat composer's manual send or by the automatic post-recording refinement —
either way, it only ever runs at all while you've explicitly turned on
**Link with GitHub Copilot LLM** and picked a model in Settings, which is
itself the real, one-time opt-in.

## Total Agentic Mode — a conversational workspace

With **Total Agentic Mode** on (Settings), the sidebar is chat-first. The
**Input Files**, **Custom Instructions & RAG Data** and **Token Monitoring**
sections live together in one master section, **Control Panel**, which starts
collapsed. Below it sits **Instant instructions to LLM**: a standalone
conversation with a LangChain tool-calling agent that takes the remaining
height, with a compact chat-style input box. Open the Control Panel when you
need to drop files, tick instructions or recipes, read the token bar or click
**Clear Data**. There is no Generate
section — you ask for what you want, and reopen results from links the chat
shows.

- **Ask, then ask again.** The conversation is remembered, so follow-ups,
  corrections and "same thing but…" requests refer to earlier answers. When
  the history would not fit the model's context window, the oldest whole
  exchanges are left out of what is sent (and you are told) — never a half
  exchange.
- **Every message works from one snapshot.** When you press Send, SoftPlay
  captures the current settings, the Input Files segments you selected in
  Ingestion Configuration (a segment cut by a size cap is labelled as such),
  the checked Custom Instructions and the checked RAG recipes, and reads the
  checked files **once**. The prompt, the token budget and any tool that turn
  calls all use that snapshot; a change made while the model is working applies
  to your next message.
- **Custom Instructions and RAG Data.** Only the files you check are sent.
  **In Total Agentic Mode, nothing checked = no instruction files** (unlike
  Standard mode, where nothing checked means all). Checked instructions and
  checked RAG recipes are peers: recipes are sent in full, and a real conflict
  is resolved by the more specific rule, with both named. An unreadable
  instruction file, or an unusable or too-large recipe selection, stops the turn
  before the model is called — it is never silently dropped or retried without.
  The search boxes only filter what you see; a checked file that is hidden by
  the filter stays checked.
- **Generate on request.** Ask for a **feature file**, **automation code** or a
  **manual test-case CSV** and the agent runs the same pipelines the old
  buttons ran; each result appears as a card in the chat that reopens it (the
  CSV is saved into the workspace; nothing is executed without Verify & Fix's
  usual approval). Tool calls show as collapsible steps.
- **Regenerate / Copy / Stop.** **↻ Regenerate** asks for the newest answer
  again (type a preference first, e.g. "shorter, as a table"); **■ Stop**
  cancels a running turn.
- **Enter** sends, **Shift+Enter** is a new line. The box's bottom-right corner
  is a drag handle.
- **Where it lives.** The transcript and the LLM's memory are kept in memory
  only and end when VS Code closes or you click **Clear Data**, which wipes the
  chat, the memory, every loaded file, retrieved pages, connection credentials,
  selections and generated output — a reply, prompt answer or download still in
  flight is discarded, never shown afterwards. Removing a loaded file also
  clears the model's memory of the conversation (the transcript stays, with a
  note), because earlier answers may have quoted it. Credentials typed into the
  chat are encrypted (`ENC[...]`) before they reach the model, the transcript or
  the memory.

### Jira and Confluence (read-only)

Paste a Jira issue or Confluence page link in the chat. If it matches a
connection configured in `config/agentic-connections.json`, SoftPlay shows a
**Connect securely** card — **nothing is contacted until you click it**. The
click opens a masked VS Code input for your personal access token (or
username/password where the deployment allows it); the credential is held in
memory for the session, scoped to that one connection, and never reaches the
model, the transcript, logs or files. The page then appears as a card: title,
source, retrieval time, summary fields and an attachment **list** — no
attachment is downloaded. You are asked whether to read any attachments and what
to do next. **Read attachments…** opens a picker; only the files you tick are
downloaded, parsed like a dropped file, and added to Input Files with their
provenance. Everything is read-only (`GET` only) over HTTPS.

**Supported:** Jira and Confluence **Data Center / Server** with a personal
access token (Bearer) or, where enabled, Basic authentication. **Not supported:**
Atlassian Cloud, SSO/SAML/OIDC browser sign-in, OAuth and MFA prompts — a link
that only works after a browser sign-in ends in a "login required" message.

The shipped configuration contains three **disabled placeholders** (two Jira,
one Confluence) with no hostnames and no credentials: local chat works
unchanged, and a Jira/Confluence link is answered with setup guidance. An
administrator fills in `enabled`, `baseUrl`, `deployment` (`"datacenter"`) and
`authMode` (`"pat"` or `"basic"`) before packaging.
**See `docs/agentic-knowledge-connections.md`** (inside the extension folder) for the
configuration reference, security model, failure handling, official API
references, the **pre-packaging checklist**, and exactly what has and has not
been verified (no live TD host, proxy/CA or Extension Development Host run yet).

**Look.** Agentic Mode's sidebar has its own clean white, claymorphic,
futuristic theme (`media/agenticMode.css`), fixed regardless of your VS Code
colour theme. Standard mode and the other panels are unchanged.

## Kill All Browsers

Closes the `codegen` browser process this extension launched and clears the
generated code (click twice to confirm — VS Code webviews don't reliably
support native `confirm()` dialogs, so it arms on the first click and
confirms on the second, within 3 seconds).

## Settings

Click the ⚙ button at the top of the panel (enabled any time) to open the
**SoftPlay: Settings** panel:

| Setting | Options | Default |
| --- | --- | --- |
| Browser | Chrome / Edge | **Chrome** |
| Language | Java / Python | Java |
| Language / runtime version | Java: 11, 17, 21 · Python: 3.9–3.12 | Java 17 |
| Link with GitHub Copilot LLM | On / Off | Off |
| Copilot model | Populated live from `vscode.lm.selectChatModels` | *(first available)* |

All settings persist via `context.globalState` (not a VS Code workspace
setting) and apply immediately, including to a codegen session already
running. Language and version drive codegen's own `--target` flag and the
AI refinement prompt's language/runtime idioms — they never affect how the
extension itself runs.

## Browser choice — Chrome or Edge only, nothing ever downloaded

This extension depends on `playwright` (for the `codegen` CLI) but never on
its bundled Chromium/Firefox/WebKit — `--channel chrome`/`--channel msedge`
always drives your real, already-installed system browser, and the
bundled-browser download step is disabled at install time (see `.npmrc`).
Chrome is picked over Edge by default; switch it in Settings.

## Setup

```bash
npm install
npm run compile      # or: npm run watch
```

Then press **F5** in VS Code (or run the "Run Object Spy Extension" launch
config) to open a new Extension Development Host window with the extension
loaded.

## Building a .vsix

```bash
build-extension.bat
```

Installs dependencies, bumps the patch/build number in `package.json`
(`scripts/bump-version.js`), compiles, and packages a single `.vsix` —
deleting any previous one first, so exactly one is left in the folder
afterward. That same version number is what shows as the **v0.1.x** badge
on the main panel. Install the result via VS Code's **Extensions: Install
from VSIX...** command.

## Using it

SoftPlay's main UI lives in the **Activity Bar** — the vertical icon rail on
the far left/right edge of the VS Code window (same place as Explorer,
Search, Extensions) — not a floating editor tab, so it's always one click
away. Look for the SoftPlay icon and click it to open the sidebar panel.

> **Just installed and don't see the icon?** Reload the window
> (**Developer: Reload Window** in the Command Palette, or just close and
> reopen VS Code). You can also always reach it via the Command Palette:
> run **"SoftPlay: Open Panel"**.

## Layout

The panel is organized into two independently expandable/collapsible
sections (native `<details>`, click the header to toggle):

- **Control Panel**, top to bottom: **Link Feature File**, the URL field,
  then **Start**/**Stop**/**Kill All Browsers** together with the status
  pill.
- **Generated Code** — Custom md files (when Copilot is linked, with **Open
  AI Generated Code** underneath it) and the Playwright Code editor.

The Settings gear lives at the very top of the panel, outside both
sections, always reachable. **AI Generated Code** itself opens as its own
full-size panel beside the sidebar (like **Settings**) rather than sharing
sidebar space — see "Custom md files" above.

Diagnostic/informational messages (codegen launch progress, feature-file
linking) go to a dedicated **SoftPlay** Output channel — **View → Output**,
then pick "SoftPlay" from the dropdown — rather than a panel inside the
sidebar. Actual errors still show as VS Code notifications.

## Project layout

```
src/
  extension.ts            Activation, command registration
  browser/
    codegenManager.ts      Spawns/kills the real `playwright codegen` CLI, watches its output file
  panel/
    objectSpyPanel.ts      Main UI: Activity Bar sidebar view (WebviewViewProvider) + message bridge
    settingsPanel.ts       Settings webview panel (browser, language, version, Copilot)
    featureFilePanel.ts    "Link Feature file": browse/parse/select a Gherkin Scenario
  bdd/
    gherkinParser.ts       Dependency-free .feature file parser (Scenarios, Outlines, Examples, tables)
    gherkinHighlight.ts    Renders parsed Gherkin as syntax-highlighted HTML for featureFilePanel.ts
  settings/
    settingsStore.ts       Persists settings via context.globalState, notifies listeners
  llm/
    copilotClient.ts       vscode.lm wrapper: live model discovery, streaming sendPrompt(), code-block extraction
media/
  main.js / main.css       Webview-side UI logic and styling
  highlight.js             Dependency-free regex tokenizer for the code editor's syntax highlighting
  icon.png                 Marketplace/Extensions-view icon (256x256)
  activitybar-icon.svg     Activity Bar icon (monochrome, VS Code recolors it per theme)
prompts/
  senior-qe-instructions.md  Bundled LLM instruction set for UI Automation (stay close to the
                             recording, try/catch, logger.info/warn/error, zero hardcoded
                             values, screenshot step, BDD step definitions) — always
                             included in every UI AI refinement request
scripts/
  bump-version.js          Auto-increments package.json's build number (build-extension.bat)
  generate-icon.js         Regenerates media/icon.png from scratch (no image-library dependency)
build-extension.bat        npm install -> compile -> bump version -> package a single .vsix
.npmrc                     playwright_skip_browser_download=1 — see "Browser choice"
```
