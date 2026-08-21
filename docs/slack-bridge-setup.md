# Slack bridge setup

Step-by-step guide to get your own Slack bot answering questions about your
repositories from your machine. One app per person: your mentions reach your
machine only, and every answer is billed to your own Claude (or Codex) plan.
Nothing is hosted anywhere.

Time: ~15 minutes. You do steps 1–4 once; after that it is just `slack run`.

## Prerequisites

- Node 22 or newer (`node -v`).
- The `claude` CLI installed and signed in: run `claude auth status`. If it is
  not logged in — or the bridge later fails with a 401 "OAuth token expired" —
  run:

  ```bash
  claude auth login
  ```

- A checkout of this repository (or the plugin installed from the marketplace).
  The commands below use the checkout form; from an installed plugin, replace
  `node plugins/nemeda-agent-kit/scripts/cli.mjs` with `nemeda-agent`.

## 1. Create your Slack app

1. Print the app manifest and copy it:

   ```bash
   node plugins/nemeda-agent-kit/scripts/cli.mjs slack manifest
   ```

2. Go to <https://api.slack.com/apps> → **Create New App** → **From a
   manifest** → pick the Nemeda workspace → paste the manifest (JSON tab).
3. Before creating, replace every `NAME` with your own name (for example
   `Nemeda (Marc)`), so everyone can see whose bot answered.
4. After creating, check **App Home**: *Messages Tab* must be on, and the
   checkbox *"Allow users to send Slash commands and messages from the messages
   tab"* must be ticked. The manifest sets this, but verify — without it, DMs
   show "Sending messages to this app has been turned off".

## 2. Get the two tokens

Ignore Client ID, Client Secret, and Signing Secret — Socket Mode does not use
them. You need exactly two tokens:

- **App-level token** (`xapp-…`): **Basic Information** → *App-Level Tokens* →
  *Generate Token and Scopes* → add the scope `connections:write` → generate.
  Copy it now; it is shown only once.
- **Bot token** (`xoxb-…`): **OAuth & Permissions** → **Install to Workspace**
  → accept. The token then appears at the top of that page under *OAuth Tokens
  for Your Workspace*.

Notes:

- If your workspace requires admin approval, the install stays pending until an
  admin approves it.
- If you ever add or remove scopes, Slack forces a reinstall and the `xoxb-`
  token **changes** — update it in the env file below.

## 3. Configure the machine

```bash
node plugins/nemeda-agent-kit/scripts/cli.mjs slack init
```

This creates two files (never committed anywhere):

- `~/.nemeda/.env.local` — put both tokens in it, no quotes, no spaces:

  ```text
  SLACK_APP_TOKEN=xapp-...
  SLACK_BOT_TOKEN=xoxb-...
  ```

  The folder is hidden; open the file with `open -e ~/.nemeda/.env.local`.

- `~/.nemeda/runner.json` — who you are and which repositories your bot serves:

  ```json
  {
    "owner": "U0XXXXXXXXX",
    "repos": ["~/work/my-project", "~/work/other-project"],
    "channels": { "C0XXXXXXXXX": "my-project-id" }
  }
  ```

  - `owner`: your Slack member ID. In Slack: your avatar → **Profile** → `⋮` →
    **Copy member ID**. Starts with `U`. Only you (and guests you declare) get
    answers; anyone else is told to use their own bot.
  - `repos`: paths to repositories that have a `.nemeda/agent-kit.json`. Listing
    a repository here is all a DM needs.
  - `channels`: optional map of channel ID → project ID, only for answering
    mentions in channels. Channel ID: channel name → *About* tab → bottom.
    Project ID: the `project.id` in that repository's `.nemeda/agent-kit.json`.

  A repository can also declare its own `slack` section (see
  [configuration.md](configuration.md)); that overrides the registry and is the
  right place for `guests` — teammates without their own bot whom your bot
  should also answer. Treat adding a guest as granting read access to that
  codebase.

## 4. Verify and run

If you mapped a channel, invite the bot there first: `/invite @your-bot-name`.

```bash
node plugins/nemeda-agent-kit/scripts/cli.mjs slack doctor   # everything checked end to end
node plugins/nemeda-agent-kit/scripts/cli.mjs slack run      # start it (foreground)
```

`doctor` tells you exactly what is missing: tokens, Socket Mode, routing, the
backend CLI. Fix whatever it flags and re-run it.

To start automatically at login (macOS):

```bash
node plugins/nemeda-agent-kit/scripts/cli.mjs slack install
```

then run the `launchctl bootstrap` command it prints. Logs land in
`~/.nemeda/state/slack-runner.log`. The bot is online while your laptop is —
that is the trade for having no server.

## Using it

- **DM the bot** — the everyday surface. No mention needed; just ask. The DM is
  one continuous conversation per project, kept across restarts.
  - One repository configured: nothing to pick.
  - Several: `usa <project-id>` switches (sticky until changed), or prefix a
    single question with `<project-id>: your question`. If the bot cannot tell
    which project you mean, it lists what it serves.
- **In a mapped channel**, mention the bot: `@your-bot-name question`. It
  reacts with 👀, answers in a thread, and follow-ups **inside that thread**
  need no new mention.
- **Cleanup**: tell the bot `borra tus mensajes` (or `limpia el chat`) in a DM
  or a thread, and it deletes its own messages there — slowly, about one per
  second, confirming with a ✅ reaction when done. Owner only. Your messages
  stay: Slack only lets authors delete their own.
- Answers are read-only by construction: the agent can read the repository and
  its context, and nothing else — no shell, no writes, no network.

## Testing without Slack

```bash
node plugins/nemeda-agent-kit/scripts/cli.mjs slack ask "your question"
```

runs the exact same path and prints what Slack would show. Useful to check the
repository context and tune the tone (`plugins/nemeda-agent-kit/slack/voice.md`)
without spending a real conversation.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Sending messages to this app has been turned off" in the DM | App Home → enable *Messages Tab* + tick the "Allow users to send…" checkbox, then reload Slack (`Cmd+R`) |
| Answers fail with `401 OAuth access token has expired` | `claude auth login` on the machine running the bot |
| Bot mentioned but nothing happens | Is `slack run` running? Is the channel in `channels` (or the repo's `slack.channels`)? Are you `owner` or a guest? `slack doctor` covers all three |
| `invalid_auth` / `apps.connections.open failed` in doctor | Wrong or expired token in `~/.nemeda/.env.local`; regenerate in the app settings |
| Bot answers in channel but not a thread follow-up | Follow-ups only work in threads the bot already answered in; mention it again otherwise |
| Rate limit message | Per-user, per-project cap (default 20/hour); tune `maxQuestionsPerHour` in the repo's `slack` section |
| `nemeda-agent` not found | Use the checkout form: `node plugins/nemeda-agent-kit/scripts/cli.mjs …` |

---

# Team mode: one app, one relay

Everything above describes **solo mode**: your own Slack app, no server. Team
mode replaces it with a single Slack app for the whole workspace, hosted on a
small relay that does no AI work — it just forwards each question to the
laptop of whoever asked. Answers still run on that person's machine, with that
person's own plan. Both modes share the same runner.

Joining, per person, is one command and one DM. No Slack app, no tokens, no
scopes.

## For the person joining

```bash
nemeda-agent slack join https://relay.example.com
```

It prints a code such as `LILA-2538`. Send the bot a DM:

```text
vincular LILA-2538
```

Because the code arrives through Slack, Slack itself proves who sent it — that
is the whole identity mechanism, and it is why nobody can pair as someone else
without access to their account. The runner token is stored in
`~/.nemeda/.env.local` automatically. Then:

```bash
nemeda-agent slack run       # or slack install, to start at login
nemeda-agent slack doctor    # relay reachable, token valid, projects answerable
```

List your repositories in `~/.nemeda/runner.json` as in solo mode. `owner` is
optional here: the relay already knows who you are.

To unpair, send `desvincular` by DM (revokes the token on the relay) or run
`nemeda-agent slack leave` (forgets it locally).

## For whoever runs the relay

The relay needs the Slack app's two tokens in
`$NEMEDA_RELAY_HOME/.env.local` (default `~/.nemeda/relay/`), created from the
same manifest as solo mode:

```bash
NEMEDA_RELAY_HOME=/srv/nemeda-relay RELAY_PORT=8787 nemeda-agent slack relay
```

Put TLS in front of it — any tunnel or reverse proxy works, since the relay is
plain HTTP on one port. For a local trial:

```bash
cloudflared tunnel --url http://localhost:8787
```

`trycloudflare.com` URLs are ephemeral: they change on every start, and each
change means everyone re-runs `slack join`. Use a named tunnel or a real host
for anything beyond a demo.

State lives in `$NEMEDA_RELAY_HOME/pairings.json`: Slack user ids and token
**hashes** only, never a usable credential and never message content. Questions
and answers are held in memory just long enough to forward them.

### What the relay can and cannot do

It holds the only Slack tokens and can read what passes through it, so treat it
as sensitive. It cannot touch a repository, run anything on a laptop, or manage
the workspace: runners stay read-only, and the relay refuses any Slack method
outside an eight-entry whitelist.

### Hosting it for real

A laptop is fine for trying this out, but the relay is shared infrastructure:
while it is down, the bot is down for everyone. See
[deploy/relay/README.md](../deploy/relay/README.md) for an Azure App Service
recipe. Two constraints matter wherever it runs: it must be a **single
instance** (two would split the Slack connection and the in-memory queues), and
`NEMEDA_RELAY_HOME` must be persistent (losing `pairings.json` means everyone
re-runs `slack join`).

### Transport

Runners reach the relay over plain HTTPS — `GET /runner/poll` long polls for up
to 25 s, `POST /runner/slack` proxies whitelisted Slack calls. Nothing connects
*into* a laptop, so no ports are opened and office networks need no changes.
Long polling rather than SSE is deliberate: a held-open stream gets buffered by
CDNs and proxies (19 s to first message through a Cloudflare tunnel), while a
completed HTTP response does not (171 ms through the same tunnel).
