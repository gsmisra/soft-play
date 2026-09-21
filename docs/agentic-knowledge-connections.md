# Total Agentic Mode — conversational workspace and Jira / Confluence connections

Reference for administrators (who configure and package the extension) and for reviewers. The user-facing
summary is in the README's "Total Agentic Mode" section; the diagrams are in `media/architecture.html`
(section "Total Agentic Mode").

Contents: [Workflow](#workflow) · [Per-turn context](#per-turn-context) · [Configuration](#configuration) ·
[Supported deployments and authentication](#supported-deployments-and-authentication) ·
[Security model](#security-model) · [The four knowledge tools](#the-four-knowledge-tools) ·
[Stop, Clear Data and memory](#stop-clear-data-and-memory) · [Failure handling](#failure-handling) ·
[Official API references](#official-api-references) · [Pre-packaging checklist](#pre-packaging-checklist) ·
[What has and has not been verified](#what-has-and-has-not-been-verified) · [Known limitations](#known-limitations)

## Workflow

The sidebar is chat-first. There is no Generate section: the panel titled **Instant instructions to LLM** is a
standalone conversation that takes the remaining vertical space (collapse the Input Files, Custom
Instructions & RAG Data and Token Monitoring sections to give it more). A feature file, automation code or a
test-case CSV is requested in the conversation; the agent's `generate_*` tools run the same generation
pipelines the old buttons ran, and each finished artifact appears as a card in the chat that reopens it.

Reading a Jira issue or Confluence page:

1. The user pastes a link in the chat. The agent calls `open_knowledge_link` with exactly that link.
2. If the link matches a configured, enabled connection but nothing is authenticated yet, **nothing is
   contacted**. The chat shows a **Connect securely** card. The user clicks it; VS Code shows a **masked**
   input box. That click is the only thing that opens the prompt — the model cannot.
3. The resource is retrieved with the credential (read-only `GET`). The chat shows a card: title, key, source
   URL, retrieval time, summary fields, and the attachment **metadata** (name, size, readable or not and why).
   No attachment is downloaded at this point.
4. The card asks whether any attachments should be read and what to do next. The suggestion chips are
   shortcuts for typing that sentence: clicking one submits an ordinary chat message and never invokes a tool,
   a connection or an import by itself.
5. **Read attachments…** (or the agent's `request_attachment_import`) opens a VS Code multi-select with only the
   importable files. Only the files the user ticks are downloaded, parsed with the same ingestion as a dropped
   file, and added to Input Files with their provenance (service, connection, key, attachment id, time).

## Per-turn context

Every chat message works from **one snapshot taken when it is sent**, before anything is awaited:

| Input | What the turn uses |
| --- | --- |
| Settings (language, version, mode, model) | The values at send time. A change made while the model is working applies to the next message. |
| Input Files | The segments the user selected in Ingestion Configuration (row/column/sheet/heading/page/line ranges). If a segment was cut by a size cap, the prompt and the UI say so. Tools (`search_ingested_files`, `read_ingested_file`) read the same segments, never the raw upload. |
| Retrieved Jira/Confluence text | Included as reference data, headed with source, key and retrieval time; the model is told it may be stale and can offer a refresh. Never treated as instructions. |
| Custom Instructions | Only the checked `.github/*.md` files. **In Total Agentic Mode an empty selection means none are sent** (the UI says so). Checked files outrank everything else, including the chat text. An unreadable checked file stops the turn before any model call. |
| RAG Data | Only the checked recipes (search box included; a selection hidden by the filter is kept). Checked recipes are sent **in full**, as peers of the checked instruction files (a genuine conflict is resolved by the more specific rule and the choice is named). An unusable, wrong-language or too-large selection stops the turn; there is no silent retry without it. |

The contents of the checked instruction and recipe files are read **once** per turn and reused for the token
budget, the chat prompt and any generation tool that turn calls, so an edit made mid-turn cannot make an
artifact differ from the chat turn that requested it. Removing a file, clearing selections or Clear Data
never leaves the old content reachable through the conversation memory (see below).

## Configuration

`config/agentic-connections.json` (schema: `config/agentic-connections.schema.json`) ships with **three
disabled placeholders** — two Jira, one Confluence — and no hostnames. The file is read from the extension's
install directory, never from the workspace. An administrator populates it before packaging.

```json
{
  "schemaVersion": 1,
  "connections": [
    {
      "id": "td-jira-1",
      "label": "TD Jira 1",
      "product": "jira",
      "enabled": true,
      "baseUrl": "https://<host>[/<context-path>]",
      "deployment": "datacenter",
      "authMode": "pat",
      "acceptanceCriteriaFieldIds": ["customfield_12345"]
    }
  ],
  "limits": { "requestTimeoutMs": 30000, "maxResponseBytes": 5242880, "maxAttachmentBytes": 10485760,
              "maxAttachmentBatchBytes": 31457280, "maxAttachmentCount": 20, "maxListingPages": 10 }
}
```

| Field | Rule |
| --- | --- |
| `id` | Lowercase letters, digits, dashes. Credentials are scoped to this id. |
| `product` | `jira` or `confluence`. |
| `enabled` | `false` = configured but unused; a link to it gets a "configured but disabled" message. |
| `baseUrl` | `https` only; scheme, host, optional port and context path. No credentials, query string or fragment. |
| `deployment` | `datacenter` (Jira / Confluence Data Center or Server REST). Anything else is rejected. |
| `authMode` | `pat` (Bearer personal access token) or `basic` (username + password, where the deployment allows it). |
| `acceptanceCriteriaFieldIds` | Optional, Jira only: `customfield_NNNNN` ids whose text is added to the issue read. |
| `limits` | Optional; each value has a hard ceiling so a typo cannot make a bounded read unbounded. |

Validation is strict: unknown keys, credential-shaped keys (`password`, `token`, `secret`, `username`, …),
duplicate ids, an `enabled` entry with an invalid `baseUrl`/`deployment`/`authMode` are all reported with the
exact reason — never guessed around. A link is matched on the **parsed** origin and a path-segment boundary
(`https://jira.example.com.evil.test/` and `https://jira.example.com/jira-evil` do not match
`https://jira.example.com/jira`); a link that matches two connections is refused as ambiguous.

## Supported deployments and authentication

| Product | Deployment | Authentication | Status |
| --- | --- | --- | --- |
| Jira | Data Center / Server (REST `/rest/api/2`) | Personal access token (`Authorization: Bearer`) — Jira 8.14+ | Implemented; **not yet run against a TD host** |
| Jira | Data Center / Server | Username + password (`Authorization: Basic`) | Implemented; only where the deployment permits it; not run against a TD host |
| Confluence | Data Center / Server (REST `/rest/api/content`) | Personal access token — Confluence 7.9+ | Implemented; not run against a TD host |
| Confluence | Data Center / Server | Username + password | Implemented; where permitted; not run against a TD host |
| Jira / Confluence **Cloud** (`*.atlassian.net`, Atlassian API tokens) | — | — | **Not supported.** No Cloud assumptions are made anywhere. |
| SSO (SAML / OIDC browser sign-in), OAuth, MFA prompts | — | — | **Not supported.** If a link only works after a browser sign-in, the request ends in a "login required" message; nothing tries to bypass it. |

No TD hostnames appear anywhere in the repository. They are supplied by the administrator.

## Security model

- **Credentials.** Collected only by a masked VS Code input box opened by the user's click. Held in memory for the
  session, scoped to the connection id, cleared by **Clear Data** and on any 401/403. They never enter the model
  prompt, the conversation memory, the transcript, tool arguments or results, posted webview messages, Output
  channel logs, files or error text. After a failed sign-in the user gets a **Reconnect** button — there is no
  automatic re-prompt loop. Nothing in this feature stores a credential in `globalState`, `SecretStorage` or on disk.
- **The model never supplies a URL.** `open_knowledge_link` accepts only a link the *user* typed in this
  conversation (compared after normalization); a link the model invents, or copies out of a fetched page, is refused.
  Attachment download addresses come from the provider's own listing and are kept only if they lie inside the
  connection's origin and path.
- **Transport.** One module (`knowledgeTransport.ts`): HTTPS only, certificate validation always on, `GET` only,
  streaming response cap (the connection is abandoned when the cap is exceeded, whatever `Content-Length` says),
  finite timeouts, bounded retries with backoff and `Retry-After`, at most three redirects, each validated — the
  `Authorization` header is never sent to a different origin. Errors carry no headers, query strings or bodies.
  It uses Node's `https` inside the VS Code extension host, so it follows VS Code's proxy and certificate settings
  — that is documented VS Code behaviour, not something tested here.
- **No unrestricted tools.** The agent has no HTTP, shell, SQL or filesystem tool. Its knowledge tools are the
  four below; the other tools read only the current, trimmed Input Files segments or start the existing generation pipelines.
- **Untrusted content.** Jira/Confluence text is passed through the same credential-protection pass as chat text
  before it is stored (a failure there registers nothing), is labelled reference data in the prompt, and is only
  ever rendered in the webview with `textContent` — never as markup.
- **Attachments need consent** specific to the resource, the attachment ids and this session: a host-owned picker
  is *always* shown (a model can pre-select ids but never bypass it), ids the host did not issue are rejected
  before any download, and limits are enforced twice — on the listed sizes before any byte is fetched, and on the
  bytes actually received (a cumulative batch budget; each download may use only what is left of it), because
  provider-reported sizes can be missing or wrong.
- **Read-only.** There is no code path that sends anything other than `GET`. Nothing is written to Jira or Confluence.
- **No credentials are bundled**: the shipped configuration contains none, and the loader rejects a file that does.

## The four knowledge tools

| Tool | What it does | What it cannot do |
| --- | --- | --- |
| `open_knowledge_link` | Opens a link the user pasted; may return "needs authentication", an error, or the resource (also from the session cache, labelled with its retrieval time; `refresh` re-fetches). | Cannot take a URL the user did not type; cannot prompt for credentials. |
| `read_knowledge_resource` | Pages through the stored text of a retrieved resource by host-issued id (`src-N`). | No network access. |
| `list_resource_attachments` | Lists attachment metadata (host-issued ids `att-N`). | Downloads nothing. |
| `request_attachment_import` | Asks the host to run the consent flow, optionally pre-selecting ids. | Cannot skip the picker or import unlisted / unsupported / off-connection files. |

## Stop, Clear Data and memory

- **Stop** cancels the running turn — including a generation it started — or a Connect / Read-attachments
  operation. Before *every* state change (credential stored, resource registered, file ingested) the operation
  checks both the session generation and its abort signal, so a Stop pressed while the masked prompt is open, while
  a ticket is being redacted, while a file downloads or while it is being parsed leaves nothing behind. The chat
  says the operation was stopped; attachments already imported stay.
- **Clear Data** wipes the transcript, the model's memory, retrieved resources, credentials, pending actions and
  approvals, loaded files, selections and generated output, and cancels everything in flight. Late answers
  (a model reply, a masked-prompt answer, a download, a parsed file) are discarded and can never repopulate the
  fresh session. This includes a chat message that was still being credential-checked when Clear Data was clicked. A request that was cleared or stopped while its model was being resolved (or between any two preparation stages) starts **no** further read of the checked instruction files, RAG recipes or the recipe index — request ownership (session epoch, chat generation, not cancelled) is re-checked before every read of user context, so a dead request cannot refill the file cache that Clear Data just emptied. A read already underway is still stopped from populating the cache by the cache epoch guard.
- **Removing a file** cannot un-say what an earlier answer already quoted from it, so the model's memory of the
  conversation is cleared (the visible transcript stays, with a note) and the attachment can be imported again.
- Cached remote data is labelled with when it was retrieved; refreshing is an explicit request.
- The transcript and memory live in memory only; they end when VS Code closes.

## Failure handling

| Situation | Behaviour |
| --- | --- |
| Link matches no connection / connection disabled / config invalid | Specific message naming what to fix in `config/agentic-connections.json`; nothing contacted; local chat is unaffected. |
| 401 / 403 | Credentials dropped; **Reconnect** offered; no automatic retry. |
| 404 | "Not found (HTTP 404). The item may not exist, or this account may not be allowed to see it." |
| A login page instead of JSON | "Login required" — no SSO handling is attempted. |
| 429 / 5xx / timeout | Bounded retries with backoff (`Retry-After` honoured up to a ceiling), then a clear error. |
| Oversized response or attachment | Read is abandoned at the cap; text is truncated with disclosure, attachments are skipped with a reason. |
| Attachment fails to download or parse | Reported per file; the others in the batch still import. |
| Cross-origin redirect | Blocked; no `Authorization` forwarded. |

## Official API references

- Jira Data Center REST API — issues: https://developer.atlassian.com/server/jira/platform/rest/v10002/api-group-issue/
- Confluence Data Center REST API — attachments: https://developer.atlassian.com/server/confluence/rest/v900/api-group-attachments/
- Confluence REST API examples: https://developer.atlassian.com/server/confluence/confluence-rest-api-examples/
- Personal access tokens (Data Center): https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html

## Pre-packaging checklist

Fill in, then verify live, before packaging. (This work did not package or deploy anything.)

**Populate in `config/agentic-connections.json`** (for each of the two Jira entries and the Confluence entry):
- [ ] `enabled: true`
- [ ] `baseUrl` — the real `https://host[/context]` of the Data Center / Server deployment
- [ ] `deployment: "datacenter"`
- [ ] `authMode` — `"pat"` (preferred) or `"basic"`, matching what that deployment allows
- [ ] (Jira) `acceptanceCriteriaFieldIds` — the `customfield_NNNNN` ids the team uses, if any
- [ ] `limits` — only if the defaults do not suit the network or attachment sizes
- [ ] Confirm the file still parses (open the extension; a bad entry is reported with its reason on first use)
- [ ] Confirm **no credential** was added to the file (the loader rejects credential-shaped keys)

**Live checks that automated tests cannot make** (none were possible in this environment):
- [ ] Each configured host is reachable from a machine on the bank network; the corporate proxy and CA are honoured by VS Code's `https`
- [ ] Personal access tokens (or Basic) are actually enabled for each deployment; if the deployment is SSO-only, this feature cannot authenticate to it
- [ ] Read a real issue and a real page: summary, description (wiki markup or ADF), the configured acceptance-criteria fields, and Confluence lists/tables convert sensibly (field shapes were parsed defensively but never checked against a TD instance)
- [ ] List and import a real attachment of each supported type (csv, xlsx, docx, pdf) and confirm the download link resolves inside the connection (context path handling)
- [ ] A 401 with a wrong token shows Reconnect; a page that needs SSO shows "login required"
- [ ] Clear Data and Stop behave as described with the real masked prompt, real latency and the real Copilot model
- [ ] Standard mode and **Verify & Fix Code** still behave as before in a real Extension Development Host
- [ ] `git`/`vsce package` output contains `config/agentic-connections.json` with the intended contents and no credentials

## What has and has not been verified

Automated (offline, `npm test`): configuration parsing and matching; the HTTPS transport (streaming caps,
retries, redirects, header scoping) against a scripted server; Jira/Confluence adapters against fixed JSON;
the knowledge session (authorization gating, consent, batch limits on received bytes, Stop/Clear Data at every
await); the real controller with a scripted LangChain model (walkthroughs for a Jira ticket, a Confluence page,
wrong credentials, attachment import with real CSV/XLSX parsing, Stop/Clear Data during the masked prompt,
download and parsing, per-turn snapshot behaviour); and the shipped `media/agenticMode.js` executed against the
shipped HTML in a stub DOM. Layout was checked in a browser harness at a sidebar width. Several of the tests
were also checked by temporarily breaking the guarded behaviour and confirming a test failed.

**Not verified:** any live TD Jira / Confluence host; VS Code proxy/CA behaviour; the real masked `showInputBox`,
attachment picker, Copilot model and webview inside an Extension Development Host; keyboard/IME behaviour in a
real webview; the integration test suite (`test-integration`, compiled but not run).

## Known limitations

- Data Center / Server only; no Cloud, SSO, OAuth or MFA flows.
- Jira and Confluence content is converted to text (ADF / storage format); complex macros, images and some
  tables are simplified, and the card lists conversion notes when that happens.
- What is read from a Jira issue: summary, type, status, priority, labels, description, attachments and any
  configured acceptance-criteria fields. Comments, sub-tasks, linked issues and history are **not** read.
- Attachments: csv, json, xml, yml/yaml, txt, md, log, xlsx, docx, pdf. Legacy `.xls`/`.doc` are refused with guidance.
- Attachment listings are capped (`maxListingPages`); an incomplete list is labelled as such.
- Only the current Total Agentic conversation is remembered, and only in memory.
- Read-only by design: the feature cannot comment on, transition or edit anything.
