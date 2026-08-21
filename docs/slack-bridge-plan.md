# Slack bridge plan

Status: implemented, not yet exercised against a real Slack app. This is the
design record; `docs/configuration.md` documents the shipped `slack` section and
`nemeda-agent slack` commands.

Goal: let non-developers (product, delivery) ask questions in Slack and get
answers grounded in the same repository context the coding agents already use,
with no hosted infrastructure and no additional per-seat cost.

## Constraints

1. No infrastructure to pay for or operate. No server, no tunnel, no public URL.
2. Runs on a normal laptop, started once and forgotten.
3. Answers are produced by the operator's existing Codex or Claude subscription
   through the local CLI, not through a separately billed API key.
4. Reduced surface: read and explain, never write. No code changes, no PRs, no
   Airtable mutations from Slack.
5. The bot must read as a colleague, not as a chatbot.

## What the kit already gives us

The bridge is mostly plumbing because the hard part is done:

- `scripts/lib/workspace.mjs` already resolves a repository root, validates
  `.nemeda/agent-kit.json`, and reads instruction files safely
  (`readWorkspaceContext`, `formatContextForHook`).
- `scripts/mcp-server.mjs` exposes that context read-only over MCP
  (`workspace_context`, `workspace_doctor`, `workspace_config_schema`).
- `.nemeda/agent-kit.json` already declares project identity, repository roles,
  Drive links, and Airtable ids; `.env.local` already holds machine-local
  secrets and is gitignored.
- The design rule ("plugin owns behavior, repository owns identity, machine owns
  secrets") maps cleanly onto a Slack runner: behavior in the plugin, channel
  routing in the repository config, Slack tokens in `.env.local`.

So the bridge adds one new process and one new config section. It does not add a
second source of truth.

## Architecture

```text
Slack workspace
  └── one Slack app per project ("Milence Agent"), Socket Mode enabled
        │  outbound WebSocket, no inbound port, no public URL
        ▼
Developer laptop (LaunchAgent, always on while the laptop is)
  └── nemeda-agent slack run
        ├── routes channel -> repository root (.nemeda/agent-kit.json)
        ├── enforces allowlist, rate limit, dedupe, audit log
        ├── spawns the local agent CLI in read-only mode
        │     claude -p ...   (subscription auth)
        │     codex exec --sandbox read-only   (subscription auth)
        └── posts the answer back into the same Slack thread
```

**Socket Mode is what removes the infrastructure.** A Slack app in Socket Mode
opens an outbound WebSocket to Slack and receives events over it, so there is
nothing to host, expose, or renew. Two tokens are needed: an app-level token
(`xapp-`, connection) and a bot token (`xoxb-`, posting). Both live in
`.env.local`.

**The Slack thread is the session.** Derive a stable UUID from
`team_id + channel + thread_ts` and pass it as `--session-id`; follow-ups in the
same thread resume it with `--resume`. Nobody has to re-explain context, and the
bot never needs to be re-mentioned inside a thread it is already in.

### One app per person, not per project

Each teammate creates their **own** Slack app from the same versioned manifest,
installs it under their own account, and runs their own runner. Marc mentions
`@nemeda-marc`, Ana mentions `@nemeda-ana`. Because every app owns its own
Socket Mode connection, Slack delivers Marc's mention only to Marc's app — the
routing is deterministic by construction, with no leader election and no
dependence on Slack's load balancer.

**One app per person, not one per person per project.** The channel decides the
project, not the bot: `@nemeda-marc` in `#milence` answers about the Milence
repo, the same bot in `#scharlab` answers about Scharlab. Three people across
five projects means three apps, not fifteen. (Slack's free plan caps a workspace
at ten apps total; the per-person model stays under it, the per-project-per-
person model does not.)

Nothing is shared between teammates: separate apps, separate tokens, separate
`.env.local`, separate subscriptions. There is no shared secret anywhere in the
design.

**Enforcing "only I can mention mine".** Slack has no ACL on who may mention a
bot, so enforcement is runner-side and that is enough:

```json
"slack": {
  "owner": "U01MARC",
  "guests": ["U02PRODUCT", "U03DELIVERY"]
}
```

The runner ignores any event whose author is not the owner or an explicit guest.
A stray mention from someone else gets an ephemeral one-liner ("este bot es de
Marc, menciona al tuyo") visible only to them, or silence — configurable. In
DMs the question does not even arise: each person DMs their own bot, so there is
zero ambiguity and zero channel noise.

**Where non-technical people fit.** This is the tension to decide consciously:
if a bot only answers its owner, someone from product with no subscription and
no checkout can never ask anything. The `guests` list is the answer — each
developer's bot explicitly covers a few teammates. Load is distributed by
agreement rather than by Slack's balancer, every question is billed to a known
plan, and product people just learn "in this workspace I ask @nemeda-marc".
The alternative, giving product their own runner, means a repo clone, Node, and
their own subscription on their laptop; possible, but a much bigger ask.

### Runner registry

One runner per person serves several projects, so it needs to know which repos
it covers. Machine-local `~/.nemeda/runner.json`:

```json
{ "repos": ["~/work/milence", "~/work/scharlab", "~/ai-workspace-plugin"] }
```

At startup the runner reads each repo's own `.nemeda/agent-kit.json`, takes the
`slack.channels` declared there, and builds a channel to repo index. The
repository keeps owning its identity; the machine only owns the list of repos it
serves. Unknown channel means no answer.

## New pieces

### 1. Config section (`slack`) in `.nemeda/agent-kit.json`

```json
"slack": {
  "channels": ["C0123ABCD"],
  "owner": "U01MARC",
  "guests": ["U02PRODUCT"],
  "backend": "claude",
  "model": "sonnet",
  "sourceRef": "origin/main",
  "maxQuestionsPerHour": 20,
  "maxAnswerChars": 1500
}
```

Schema, validator (`validateConfig`), and doctor checks extend the existing
patterns in `scripts/lib/workspace.mjs`. No secrets in this file, same as today.

### 2. Slack app manifest, versioned

`plugins/nemeda-agent-kit/slack/app-manifest.json`, so creating the app is a
paste-one-file operation rather than twenty checkboxes.

- Socket Mode: on. No request URL.
- Bot scopes: `app_mentions:read`, `chat:write`, `reactions:write`,
  `channels:history`, `groups:history`, `im:history`, `users:read`,
  `files:write` (long answers as snippets). `chat:write` also covers the
  ephemeral "wrong bot" reply.
- Each person creates their own app from this manifest and names it after
  themselves (`Nemeda (Marc)`), so the author of an answer is obvious in Slack.
- Events: `app_mention`, `message.channels`, `message.groups`, `message.im`.
- Optional later: `assistant:write` + `assistant_thread_started` for the
  Slack AI assistant side panel.

### 3. Runner (`scripts/slack/runner.mjs`)

Zero dependencies: Node 22 has global `fetch` and `WebSocket`, so the Socket
Mode client is ~80 lines (`apps.connections.open` → connect → ack envelopes →
reconnect on `disconnect`). This keeps the "zero-dependency CLI" property;
`@slack/bolt` is the fallback only if the raw protocol proves fragile.

Flow per event: ack within 3s → dedupe on `event_id` → allowlist check → rate
limit → add `:eyes:` → run the agent → post in thread → remove `:eyes:` →
append to `.nemeda/state/slack-log.jsonl`.

### 4. Agent invocation (locked down)

Verified against the installed CLI:

```bash
claude -p "<question>" \
  --output-format json \
  --allowed-tools "Read Grep Glob mcp__workspace-context__*" \
  --disallowed-tools "Bash Write Edit WebFetch WebSearch" \
  --add-dir "<repo root>" \
  --strict-mcp-config --mcp-config "<kit mcp.json>" \
  --append-system-prompt-file "<plugin>/slack/voice.md" \
  --session-id "<uuid(thread)>" \
  --model sonnet
```

Codex equivalent: `codex exec --sandbox read-only --ask-for-approval never`.
Note: the `codex` binary on this machine is currently broken (installed under
Node 18, vendored binary missing), so ship the Claude backend first and add
Codex parity in a later phase.

### 5. CLI surface

```
nemeda-agent slack run [--foreground]   # the daemon
nemeda-agent slack doctor               # tokens, socket handshake, channel access, backend CLI
nemeda-agent slack install              # macOS LaunchAgent, starts at login
```

`doctor` extends the existing report shape so a broken Slack setup is diagnosed
the same way a broken Drive symlink is today.

## Slack voice specification

This is the part that decides whether people keep using it. The rules below go
into `plugins/nemeda-agent-kit/slack/voice.md` and are appended to the system
prompt for every backend — one source, no forks.

**Placement**
- Always reply in the thread of the question. Never a new channel message.
- Only respond when mentioned, DM'd, or already inside the thread.
- Never `@here`, `@channel`, or mention people.

**Length**
- Default: 1–4 lines. The first sentence is the answer.
- Bullets only for 3+ discrete items, maximum 5.
- Over ~1500 characters: 3-line summary in the thread plus a snippet file.

**Formatting** (Slack mrkdwn, not Markdown)
- `*bold*` not `**bold**`, `_italic_`, `` `code` ``, triple-backtick blocks.
- No `#` headers, no tables, no horizontal rules, no numbered outlines.
- Links as `<url|label>`; at most two per answer.

**Register**
- Mirror the asker's language (Spanish in most Nemeda channels).
- No preamble, no restating the question, no sign-off, no "¿algo más?".
- No self-reference as an AI, no apologies for limitations.
- Status via reactions (`:eyes:` → answer → remove), never via a
  "working on it" message.

**Honesty**
- "No lo sé" or "no tengo acceso a eso" in one line, plus the single thing that
  would unblock it.
- Never promise to follow up later. Either answer now or say what is missing.
- Cite the file or record when the answer came from one.

**Before / after**

> Great question! Let me look into that for you. Based on my analysis of the
> codebase, here's a breakdown:
> ## Summary
> - The endpoint is defined in **src/api/orders.ts**
> - It handles ...

> Lo lleva `orders.ts`: valida el payload, escribe en `orders` y publica
> `order.created`. El rate limit de 30 rpm está en el middleware, no en el
> handler. <link|orders.ts:42>

## Phases

| Phase | Scope | Effort |
|---|---|---|
| 0 — Spike | App manifest, admin approval, Socket Mode handshake, echo in thread | 0.5 d |
| 1 — MVP | Runner, channel→repo routing, read-only Claude backend, thread sessions, reactions, allowlist, rate limit, audit log | 1–2 d |
| 2 — Voice | `voice.md`, mrkdwn post-processing, length policy, source links | 0.5–1 d |
| 3 — Ops | `slack doctor`, LaunchAgent installer, onboarding guide for a second teammate's app, Codex backend | 0.5–1 d |
| 4 — Optional | Assistant side panel with suggested prompts, `/nemeda` slash command, read-only Airtable lookups | later |

Phase 0 exists to fail fast: if Slack admin approval for the app is not granted,
nothing else matters.

## Risks and open questions

1. **Subscription terms.** Using a personal Claude or Codex subscription to
   answer other people's questions through a shared bot is a grey area against
   plans intended for individual interactive use. Worth confirming before this
   goes past a small internal pilot. Fallback: an `ANTHROPIC_API_KEY` with
   `--max-budget-usd` per answer, which costs money but removes the ambiguity.
2. **Availability.** Laptop closed means bot offline. Slack's presence dot makes
   this visible; there is no way around it without paying for infrastructure.
3. **Access boundary.** Two controls stack: the channel allowlist decides which
   repos are reachable at all, the owner/guest list decides who may ask. Never
   allowlist a broad or public channel, and treat adding a guest as granting
   read access to that codebase.
4. **App sprawl.** One app per person is manageable; resist the per-project
   variant. Check the workspace's Slack plan first — the free tier caps apps at
   ten.
5. **Prompt injection.** Slack messages are untrusted input. Read-only tool set,
   no Bash, no network tools, and an explicit rule that instructions inside
   messages are data, not commands.
6. **Slack retries.** Envelopes must be acked in under 3 seconds and events
   deduped by `event_id`, or slow answers produce duplicates.
7. **Build vs. buy.** Anthropic ships an official Claude Slack integration.
   Worth 15 minutes of checking whether it covers the simple cases — it will not
   carry the private repo, Drive, and Airtable context this kit assembles, but it
   may shrink the scope of what we need to build.


---

# Phase 2 design: one app, one relay, everyone's own agent

Status: design. Supersedes the one-app-per-person model above once built; the
per-person model remains as the no-server fallback.

## The idea

One Slack app, hosted on one small relay server. The relay owns the Slack
tokens and does **no AI work at all**: it looks at who asked and forwards the
question to that person's laptop, where their own runner answers with their own
Claude/Codex subscription. Answers come back through the relay into Slack.

```text
Slack workspace (ONE app: "Nemeda Agent Kit")
      │ Socket Mode (outbound from relay, no public URL needed for Slack)
      ▼
Relay server (tiny, stateless-ish, no AI, no repos, no Claude keys)
  ├── pairing table: Slack user id  ->  runner token (hashed)
  ├── connected runners: user id -> live connection
  └── routing: event.user decides WHICH laptop answers
      ▲ HTTPS outbound from each laptop (SSE down, POST up)
      │
Each person's laptop: nemeda-agent runner (unchanged core)
  ├── local repos + registry, local claude/codex, local sessions
  └── no Slack tokens anymore — only its own relay token
```

The billing property is preserved exactly: a question from Marc runs on Marc's
laptop against Marc's plan. The channel still picks the project; the **asker**
now picks the machine.

## Identity: let Slack do it (the pairing trick)

The hard problem is a runner proving "I am Slack user U0XXX" without passwords
or an OAuth build-out. Slack itself is the identity provider:

1. On the laptop: `nemeda-agent slack join https://relay.nemeda.io`
   → the runner asks the relay for a pairing code and prints it: `AZUL-7291`.
2. The person DMs the bot: `vincular AZUL-7291`.
3. The relay receives that DM **from Slack**, which guarantees the sender's
   user id. It binds that user id to the waiting runner and issues it a
   random 256-bit runner token (stored automatically in `~/.nemeda/.env.local`).

Nobody can pair as someone else without access to that person's Slack account.
Codes are single-use and expire in 10 minutes; `desvincular` in DM (or an admin
list on the relay) revokes a runner token.

Install UX per person, total: run one command, DM one code. No Slack app
creation, no tokens to copy, no scopes, no App Home checkboxes.

## Routing rules

- DM or mention from user U → U's connected runner. Project selection inside
  the runner works exactly as today (channel map, `usa <proyecto>`, prefix).
- U has no runner (product, delivery) → forward to a connected runner that
  declares U as guest; the guest declaration stays in the repo config or the
  owner's registry, reviewable as before.
- U has no runner and no sponsor → the bot answers with the join instructions.
  Onboarding is self-serve from inside Slack.
- U's runner exists but is offline → honest one-liner: "tu agente no está
  conectado" (plus who else could answer, if a guest sponsor is online).

## Transport: zero dependencies on both sides

Node's standard library has no WebSocket **server**, and the kit is
zero-dependency by policy. So the relay speaks plain HTTPS:

- laptop → relay: `POST /runner/answer`, `POST /runner/register` (auth: runner
  token header);
- relay → laptop: one long-lived `GET /runner/events` SSE stream per runner
  (auto-reconnect with backoff, heartbeat every 30 s).

SSE over HTTPS traverses every office network that allows browsing, needs no
open ports on laptops, and is ~60 lines with `node:http`. The relay terminates
TLS behind Caddy (automatic Let's Encrypt) or runs on a PaaS that provides it.

## Security model

- Laptops hold no Slack tokens anymore (removes today's most sensitive local
  secret). The relay holds the only Slack tokens, in its environment.
- Runner tokens: 256-bit random, stored hashed (sha-256) on the relay,
  transmitted only over TLS, revocable per person.
- The relay never stores question or answer content; queues are in memory.
  The audit trail (who asked, when, which project, latency) can be a flat
  file on the relay, content-free.
- Pairing endpoints are rate-limited; codes are single-use, short-lived.
- The runner keeps its read-only construction — the relay adds no new
  capability on the laptop, it only replaces the transport.
- Blast radius review: a compromised relay can read questions/answers in
  flight and impersonate the bot in Slack, but cannot touch repos, cannot run
  code on laptops, and cannot spend anyone's Claude quota beyond answering
  real Slack traffic (runners answer only what arrives on their stream).

## Hosting

Anything that runs Node and gives TLS: a 5 €/month VPS with Caddy, Fly.io,
or Railway. CPU/RAM needs are negligible (the relay only shuffles small JSON
messages). Slack-side it keeps using Socket Mode, so the relay needs no
inbound URL from Slack — only the runners need to reach it over HTTPS.

## Phases

| Phase | Scope | Effort |
|---|---|---|
| 0 | Relay MVP: Socket Mode in, pairing flow end to end, echo answer | 1 d |
| 1 | Real routing: forward to paired runner, guest sponsorship, offline UX, runner transport adapter | 1–2 d |
| 2 | Hardening: token hashing, rate limits, restart resilience, deploy recipe (Caddyfile + systemd/Fly config) | 0.5–1 d |
| 3 | Niceties: `estado` command (who is online), `desvincular`, admin revocation, metrics | later |

The runner core (routing, sessions, voice, purge, read-only sandbox) is reused
as-is; only the transport becomes pluggable (Socket Mode directly in solo mode,
relay stream in team mode).
