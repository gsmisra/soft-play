# Total Agentic Mode: conversational workspace and TD knowledge connections

## Assignment

Implement the requirement below in the existing SoftPlay VS Code extension. This document is an implementation brief for the coding agent, not a claim that the feature already exists.

**Repository:** `C:\Users\User\OneDrive\Documents\projects\softplay\soft-play`

The user wants Total Agentic Mode to operate through a large, bidirectional LangChain chat panel. Users drop multiple Input Files, optionally select Custom Instructions and RAG recipes, and converse with the agent about that context. They can also paste a TD Jira ticket or Confluence page URL. The extension securely authenticates, retrieves that resource, lists its attachments, asks before reading attachments, and asks what the user wants to do next.

TD has two Jira variants and a Confluence deployment. Their actual URLs and deployment/authentication details will be populated in configuration before packaging. Do not invent TD hosts, assume Atlassian Cloud, or hardcode credentials.

**Implement the feature, test it, and document it. Do not commit, push, package for distribution, or deploy unless separately requested.** Preserve uncommitted work already in the repository. Read applicable repository instructions first.

## 1. Scope and product behavior

Changes apply to **Total Agentic Mode**. Preserve Standard Mode's UI, generation behavior, selected-context rules and Verify & Fix workflow.

The new primary flow is:

1. Drop multiple files into Input Files.
2. Optionally configure which portions of those files are available to the agent.
3. Optionally select Custom Instructions and RAG recipes.
4. Ask a question, paste a supported URL, or request an artifact in chat.
5. The agent retrieves relevant context, responds in the same conversation, and suggests useful next actions.
6. Continue with follow-up questions or choose a suggested action. Nothing executes merely because the agent suggested it.

Keep feature-file, automation-code and CSV generation capabilities, but invoke them through chat tools. Reuse their existing implementations and dedicated output panels/editors. Do not delete generation backends merely because their sidebar buttons disappear.

Do not build another Verify & Fix agent. That capability already uses LangChain. Preserve its existing execution approval boundary.

## 2. Inspect and reuse the current implementation

The current code already has a LangChain conversation foundation. Verify current contents rather than relying on these filenames as a complete architectural description:

- `src/panel/agenticModeSidebarView.ts`: Total Agentic sidebar HTML.
- `media/agenticMode.js` and `media/agenticMode.css`: dedicated frontend behavior and theme.
- `src/agentic/agenticChatSession.ts`: conversation history, transcript and bounded tool-calling loop.
- `src/agentic/agenticChatTools.ts`: ingested-file read/search/list tools and generation tools.
- `src/agentic/agenticModeController.ts`: session ownership, ingestion, context, generation and chat orchestration.
- `src/panel/objectSpyPanel.ts`: webview message dispatch and Standard/Agentic mode integration.
- `src/agent/vscodeCopilotToolCallingModel.ts`: existing LangChain adapter for VS Code Copilot models.
- `src/rag/ragPackingPipeline.ts`: shared automatic/manual RAG handling.
- `src/llm/customInstructionsSection.ts`: shared selected-context precedence and errors.
- Existing ingestion, file caching, redaction, token-budget and reset modules.

Reuse these modules. Avoid another conversational engine, another model provider, or copies of the selected-context pipeline. Keep typed integration boundaries so fake services can exercise real orchestration in tests.

Inspect existing test harnesses before adding imports: several selectively mock dependencies. Update those harnesses deliberately, and ensure tests do not silently replace essential production behavior with no-op stubs.

## 3. Chat-first UI

### Layout

- Retain Input Files, its multi-file drop/picker, ingestion configuration and Clear Data.
- Retain Custom Instructions & RAG Data as a separate, collapsible context section.
- Put **Instant instructions to LLM** outside that context section as the heading of a large standalone conversation panel.
- Remove the **Generate** sidebar section and all three generation buttons inside it.
- Retain necessary controls: Settings, Clear Data, file management, context refresh, Send, Stop and existing chat response actions. The request to remove buttons refers to the Generate section, not every functional control in the extension.
- Make the conversation occupy the remaining available vertical space, with a scrollable transcript and an accessible multiline composer near its bottom.
- Allow context sections to collapse to make more room for chat. Avoid fixed heights that fail in a narrow/short VS Code sidebar.
- Preserve the existing Total Agentic visual theme; keep Standard Mode styles untouched.

### Interaction

- Show user and assistant messages, tool progress, recoverable errors and pending authentication/attachment actions distinctly.
- Enter sends; Shift+Enter inserts a newline; respect IME composition.
- Stop cancels the active turn and work started by that turn.
- Retain useful existing regenerate/copy behavior where compatible.
- After reading a resource, offer a few relevant next actions in plain language, while allowing any free-text follow-up.
- Optional suggestion chips submit a normal user action. Rendering suggestions must never invoke tools.
- Reflect generated artifacts in chat and provide a way to reopen them after the sidebar buttons are removed. Use safe host messages/artifact IDs, not arbitrary commands supplied by the model.
- Keep CSV success/error feedback visible in chat or another retained status location.
- Update/remove all JavaScript references to deleted DOM elements, including message handlers that arrive after a webview reload.
- Render external and model content safely. Do not inject raw HTML from Jira, Confluence, tool results or model replies into the webview.

## 4. Context selection on every turn

### Input Files

Each new turn must use the current loaded files and the exact ingestion segments selected by the user. Preserve existing size caps and visibly disclose truncation. The agent must not claim to have read content outside those segments.

File-reading tools must use the same allowed segments as the prompt. A tool must not recover excluded spreadsheet columns, document pages or lines from the raw upload.

### Custom Instructions

Preserve explicit one-file/multiple-file selection and the existing selected-file priority rules. Unreadable explicitly selected files must stop the dependent request with actionable guidance.

Preserve Total Agentic Mode's current empty-selection behavior unless the user requests a change. Do not accidentally import Standard Mode's different default. State the behavior in the UI/help.

### RAG Data

The existing Total Agentic list is read-only; add checkboxes so one or multiple recipes can be selected. Include a compact search filter using the established filename/path/title/tags/body search behavior where practical. Search must not change which hidden items are selected.

- Nonempty selection: reuse the shared manual-selection pipeline; send only selected recipes, in full, with the established priority wording.
- Empty selection: preserve automatic retrieval and its existing enable/disable setting.
- Invalid, unreadable or incompatible selected recipes must stop the request, not silently disappear.
- Selected RAG and selected Custom Instructions are peers under the existing shared conflict rule. They outrank generic guidance and conflicting chat instructions, subject to documented security/runtime requirements.
- Do not silently trim selected recipes or retry without them when the prompt is too large.
- Preserve selections on list refresh when files survive; explicitly report removed selections rather than silently widening scope.
- Do not use scraped page contents to change selection or grant access to more files.

### Snapshots and conversation history

Capture a typed context snapshot per turn: session epoch, selected model/settings, instruction/RAG selections, file segments and available remote resource identities. Use one consistent prepared version for budgeting and sending.

Changes during a running turn must either invalidate that turn or take effect only on the next turn. Never mix two snapshots silently. For removals/reset, stale content must not be reintroduced through the old conversation history. Clear or invalidate affected history and tell the user when necessary; deleting a file from the current context alone does not erase earlier quoted content from model memory.

Rebuild retrieval context for follow-ups. Reuse validated session caches rather than downloading every remote resource on every message. Provide an explicit refresh route and source timestamps; do not label cached remote data as freshly fetched.

## 5. Configuration for TD Jira and Confluence

Create a documented JSON configuration file and schema, for example `config/agentic-connections.json` and `config/agentic-connections.schema.json`. Resolve packaged defaults from the extension installation path, not the current working directory. Ensure packaging includes them.

Ship **disabled placeholders** for two Jira entries and one Confluence entry. The user will populate them before packaging. Labels below are placeholders, not assertions about TD's actual deployments:

```json
{
  "schemaVersion": 1,
  "connections": [
    {
      "id": "td-jira-1",
      "label": "TD Jira 1",
      "product": "jira",
      "enabled": false,
      "baseUrl": "",
      "deployment": "unconfigured",
      "authMode": "unconfigured"
    },
    {
      "id": "td-jira-2",
      "label": "TD Jira 2",
      "product": "jira",
      "enabled": false,
      "baseUrl": "",
      "deployment": "unconfigured",
      "authMode": "unconfigured"
    },
    {
      "id": "td-confluence",
      "label": "TD Confluence",
      "product": "confluence",
      "enabled": false,
      "baseUrl": "",
      "deployment": "unconfigured",
      "authMode": "unconfigured"
    }
  ],
  "limits": {
    "requestTimeoutMs": 30000,
    "maxResponseBytes": 5242880,
    "maxAttachmentBytes": 10485760,
    "maxAttachmentBatchBytes": 31457280,
    "maxAttachmentCount": 20,
    "maxListingPages": 10
  }
}
```

Validate enabled entries strictly. Disabled placeholders must not break local-file chat. Invalid enabled entries must report a useful configuration error without silently contacting another connection.

Implement only deployment/auth combinations that can be verified against official APIs; document the supported matrix. At minimum provide an appropriate TD Data Center/Server REST route and PAT authentication where supported. Support username/password Basic authentication only as an explicitly configured option when the deployment permits it. If Cloud support is included, document email/API-token authentication separately: do not assume an account password works.

Allow HTTPS base URLs with deployment context paths such as `/jira` or `/confluence`. Derive endpoints from the configured deployment adapter. If configurable API roots are needed, restrict them to validated paths under the same approved origin.

Match URLs against configured origins and context paths using parsed URLs and path boundaries, never substring hostname matching. Handle overlapping context paths deterministically, preferring the most specific valid connection. Credentials are scoped to connection identity, not merely hostname.

Reject unsupported/missing configuration with setup guidance. Do not guess the host, silently substitute another Jira instance, or let the LLM invent a REST endpoint.

Keep credentials, arbitrary executable scripts and disabling of TLS verification out of this file. Prefer installation-controlled defaults; any workspace override must be explicitly trusted and must not silently redirect credential-bearing requests.

## 6. Secure conversational authentication

The user requested that the agent ask for username/password in the conversation. Implement the conversational request, but collect secrets through **masked VS Code input**, not ordinary chat text.

Example:

> “This ticket needs access to TD Jira 1. Connect securely to continue. Your password or token will not be sent to the LLM.”

Use an actionable chat control or a host-mediated action to open secure input. Make the configured service and destination visible before credential entry.

- Username/email, if needed, can use normal VS Code input; password/token must use masked input.
- PAT mode requests a token rather than a password. Do not ask for unnecessary fields.
- Credentials never enter prompts, LangChain history, tool arguments/results, transcript, diagnostics, telemetry, files or error strings.
- Tool schemas must not contain username/password/token parameters. Tools reference configured connection IDs and host-owned authorization state.
- Default credential lifetime is memory-only for the current session. Clear Data/disposal drops credential references. Do not claim physical RAM zeroization.
- If persistent storage is added, it must be an explicit opt-in using VS Code SecretStorage with documented deletion behavior; it is not required for this scope.
- Cancellation during a secure prompt must not subsequently establish a connection for a reset/stale session.
- Failed authentication must not loop through password prompts. Explain 401/403 errors and offer deliberate reconnect.
- Never attempt to bypass SSO/MFA, scrape browser cookies, or disable certificate checks. If the configured service requires an unsupported SSO/OAuth flow, report the limitation and required administrator setup honestly.

Keep authentication and consent enforcement outside the LLM. A model statement saying “the user approved” is not authorization.

## 7. Jira conversation flow

1. User pastes a ticket URL.
2. Resolve it against the configured Jira connections and extract a supported issue identity. Preserve required deployment context paths.
3. If authentication is needed, ask to connect securely.
4. Retrieve the issue through a read-only REST call.
5. Present a concise summary with the source URL and relevant available fields: issue key, summary, description, status and acceptance criteria when available.
6. List attachments with stable identifiers, filename, type and size. Listing metadata must not download file bodies.
7. Ask: “Do you want me to read any of these attachments?”
8. Ask what the user wants to do with the ticket. Offer relevant suggestions such as summarizing requirements, finding gaps, writing scenarios or generating test cases.

Do not assume acceptance criteria use a fixed custom-field ID. If needed, make relevant Jira custom-field identifiers configurable. Render structured descriptions, such as Atlassian document content, deliberately rather than exposing meaningless object strings.

Do not automatically fetch linked issues, comments, other projects or linked web pages. Add those only as separately requested, explicitly scoped capabilities. Do not create, edit, transition, comment on or upload to Jira in this feature.

## 8. Confluence conversation flow

1. Resolve a supported page URL against the configured Confluence connection.
2. Authenticate securely as required.
3. Retrieve the page title and readable body through the appropriate REST adapter.
4. Safely convert supported HTML/storage/document formats into usable text while preserving headings, lists and tables where practical. Do not execute scripts, macros or embedded content.
5. Show a summary and source URL.
6. List attachment metadata and ask which, if any, to read.
7. Ask what the user wants to do next.

Support the actual URL shapes chosen for the deployment, including page-ID query URLs or page-ID paths where applicable. For unsupported URLs, ask for the canonical page link; never claim content was fetched when it was not.

Do not crawl child pages, spaces, embedded resources or links automatically. Report unsupported macros/content and incomplete conversion rather than inventing their output. Do not edit Confluence.

## 9. Attachments: explicit consent and bounded ingestion

Use attachment metadata returned by the trusted provider. Never accept an arbitrary download URL supplied by the model.

Consent must be specific to the resource, listed attachment IDs and session. A conversational “yes” can lead to a host confirmation/selection UI, but must not grant blanket permission for future attachments. Ambiguous consent requires clarification. Listing attachments does not imply consent to read them.

Before download:

- Validate the selected attachment belongs to the listed resource.
- Enforce size/count/batch limits and supported types.
- Check URL destination and redirects before sending credentials.
- Show unsupported or oversized files with the reason; never silently omit them.

After approval:

- Download only the chosen files.
- Reuse existing CSV/JSON/XML/YAML/text/Markdown/XLSX/DOCX/PDF ingestion as appropriate.
- Retain provenance: service, issue/page, attachment ID, filename and retrieval time.
- Handle identical filenames from different resources without accidental replacement.
- Make imported attachments visible in Input Files and available to ingestion configuration/removal.
- Report parsing failures per file and successful imports accurately.
- Do not auto-execute code, macros, scripts or embedded links. Do not automatically unpack arbitrary archives.

Reset or Stop during download/parsing must prevent stale content, messages or credentials from reappearing.

## 10. LangChain tools and ownership

Extend the existing tool set with narrow read-only capabilities. Suggested names are illustrative:

- `open_knowledge_link`: resolves a user-provided, configured Jira/Confluence URL and initiates the secure connection flow when necessary.
- `read_knowledge_resource`: reads an authorized issue/page by host-owned resource ID.
- `list_resource_attachments`: lists metadata only.
- `request_attachment_import`: requests user selection/approval and imports only approved attachment IDs.
- Existing ingested-file search/read/list and generation tools.

Never expose an unrestricted HTTP, shell, SQL or filesystem tool for this feature. Network destinations must remain deterministic and configuration-controlled.

Use one source registry/context service so fetched resources, imported attachments and locally dropped files can be cited and used on later turns and by generation tools. Avoid placing fetched data only in a transient tool result: the current chat history may omit intermediate tool outputs.

Tool results should contain structured success/error information, source IDs, provenance, truncation flags and bounded readable content. Keep tool errors safe to show directly in chat.

Every async operation carries the originating session/turn identity. Check it after dialogs, credential input, network requests, attachment selection, parsing and model calls, and before committing anything. Abort network work when possible; also reject late completions even when a provider ignores cancellation.

## 11. Transport and enterprise boundaries

- Read-only HTTP methods for this scope.
- HTTPS with certificate validation enabled.
- Support/document the corporate proxy and CA behavior of the chosen transport. Do not assume a successful home-network test proves TD compatibility.
- Bound response sizes while streaming, not just after allocating the entire response. Treat Content-Length as advisory.
- Use finite timeouts and bounded retry/backoff for transient failures. Honor cancellation and rate-limit guidance without indefinite retries.
- Do not automatically forward Authorization on redirects. Validate every redirect destination and path; prohibit cross-origin credential forwarding. If an attachment requires an unconfigured CDN, stop with guidance rather than weakening the policy.
- Reject credential-bearing URLs, unsupported schemes and configuration/URL mismatches.
- Paginate metadata within configured limits and clearly indicate incomplete listings. Do not silently label a partial attachment page as “all attachments.”
- Handle HTML login pages returned with HTTP 200, invalid JSON, 401, 403, 404, 429, timeouts and server errors with sanitized messages.
- Treat remote bodies and attachments as untrusted reference data, not instructions granting permissions or overriding selected context and security rules.
- Apply existing supported credential protection to model-bound content; propagate unsupported-redaction failures. Never fix known redaction limitations by silently sending raw credentials.

## 12. Reset, Stop and recovery

Clear Data must cancel work and clear:

- Conversation transcript and LangChain history.
- Input files and parsed attachment content.
- Selected Custom Instructions and RAG state, including frontend checkboxes/searches.
- Remote resource registry, attachment metadata, approvals and session credentials.
- Relevant caches and pending source/credential callbacks.
- Generated outputs according to the existing reset contract.

Configuration remains intact. Do not delete source files or remote data.

Stop cancels the current operation without unnecessarily discarding prior completed conversation. A cancelled authentication prompt/download/tool call must not restart itself. Connection or parsing failures should leave the user able to retry, change selection or continue discussing already loaded files.

## 13. Required tests

Use real production orchestration with injected model, transport, authentication and consent boundaries. No live bank credentials are needed for automated tests.

### UI and message contracts

- Generate section/buttons absent; chat is outside Custom Instructions & RAG Data.
- Actual shipped JavaScript initializes without null-element failures.
- Send/Stop, IME input, multiline input, Clear Data and transcript rendering work.
- RAG checkboxes preserve hidden selections during filtering and surviving selections on refresh.
- Malicious HTML/tool text is displayed safely.
- Artifact reopening remains possible without the old generation buttons.

### Context and chat

- Multiple dropped files and selected segments reach the next turn.
- One/multiple Custom Instructions and RAG selections work across UI/API and Java/Python.
- Unselected files are absent; full selected recipes are not silently capped or dropped.
- Unreadable selected context blocks model invocation.
- Follow-ups use refreshed selections and available remote sources; reset/removal cannot leak old context back through history.
- Selected-context overflow produces actionable failure, not a retry omitting required context.
- Scripted LangChain model proves read/search tools and generation tools are actually invoked correctly.
- Artifact tools reuse existing generation pipelines and do not execute generated code automatically.

### Configuration and transport

- Disabled placeholders allow local chat and reject remote access with setup guidance.
- Two Jira variants route to the correct configured adapters and credentials.
- HTTPS origin/context-path matching, lookalike hosts, alternate ports, credential-bearing URLs, redirects and login-page responses.
- Proxy/CA integration is documented and tested where the environment permits.
- Response, attachment and pagination limits; timeout/rate-limit/cancellation behavior.
- No network request occurs before required authorization.

### Authentication and attachments

- Credentials appear in neither model calls, tool results, transcript nor logs, including errors.
- Prompt cancellation and reset during credential entry cannot restore old auth state.
- Attachment listing performs zero body downloads.
- Declined, cancelled or ambiguous consent downloads nothing.
- Approved selection downloads only the selected IDs; cross-resource IDs and model-invented URLs are rejected.
- Attachment parsing uses the real ingestion paths and preserves provenance.
- Duplicate filenames, unsupported types, oversized files and partial failures behave predictably.
- Reset during download/parsing causes zero stale commits and zero follow-up model calls.

### Verification commands

Run the repository's full unit suite, all three TypeScript configurations, and syntax checks for changed webview scripts. Add meaningful negative tests; do not merely assert that a tool name or prompt phrase exists.

When possible, use the VS Code Extension Development Host to verify layout, secure prompts, continuation after authentication, attachment consent and artifact reopening. If real TD hosts are not configured, report that live service authentication/SSO/proxy compatibility is unverified. Do not claim universal Jira/Confluence support from mocked tests.

## 14. Acceptance walkthroughs

### A. Local files

Drop a spreadsheet and two requirement documents; select two instruction files and a RAG recipe; ask for a gap analysis. The agent uses those sources, cites them, answers in chat and suggests next steps. “Create test cases for the missing coverage” invokes the existing CSV flow and links the resulting artifact from the conversation. No Generate section is required.

### B. Jira

Paste a configured TD ticket URL. The conversation offers secure connection. Enter configured credentials through masked input. The agent reads the ticket, summarizes it, lists attachments and asks what to do next and whether to read attachments. Choosing one attachment imports only that file. A follow-up can compare it with the originally dropped requirements.

### C. Confluence

Paste a configured page URL. The agent retrieves the page with citations, lists attachments without downloading them, and waits for approval. Declining attachments still allows discussion of the page.

### D. Reset and errors

Clear Data while waiting for credentials or downloading an attachment. Nothing from the old session reappears. A new conversation starts clean. Wrong credentials, missing configuration and unreadable selected context produce useful errors, not fabricated successful results.

## 15. Documentation and delivery

Update README and Architecture & Technical Information with the chat-first flow, available tools, context precedence, secure authentication, attachment consent, memory lifecycle and configuration steps for the two TD Jira variants and Confluence.

Provide a short pre-packaging checklist identifying exactly which configuration fields the user must populate and what live checks remain. Include official API references for the implemented deployment adapters, not guessed endpoints.

Final report must state:

1. Files changed and why.
2. Supported deployment/authentication combinations and unsupported SSO cases.
3. Automated test results and UI/live-service verification actually performed.
4. Remaining limitations and configuration still required.
5. Confirmation that Standard Mode and existing Verify & Fix behavior were preserved.
6. Confirmation that no credentials were bundled and no remote writes were added.

Do not describe the result as “error-free” or claim that prompt instructions guarantee model compliance. Report evidence and remaining limits precisely.
