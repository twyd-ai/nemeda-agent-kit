---
name: memory-log
description: Log this session's work to the project's memory — decisions made, findings, and a summary segmented by AI model — after explicit user confirmation. Use when the user asks to log the session, record what was done, or write a knowledge-log/memory entry, and the repository has a `memory` section configured.
---

# Log this session to project memory

Portable replacement for the per-project Drive `klog.md` commands: same
five-step flow, but the write goes through `nemeda-agent memory add`, not a
hardcoded Airtable base/table/person id. Never create an entry the user has
not seen and confirmed.

If the repository has no `memory` section in `.nemeda/agent-kit.json`, say so
and stop — point at docs/memory-plan.md rather than writing anywhere else.

## 1. Segment the session by model

Review the whole conversation:

1. Identify the model answering right now.
2. Look for earlier model switches (`/model` commands, system messages,
   noticeable shifts in style or capability).
3. Split the session into **segments per model**: what happened while each
   model was in use.
4. One model used throughout means one segment.

## 2. Analyze each segment

For each segment, extract:

- What was done.
- Which files were created or changed.
- What decisions were made, and why.
- What was produced (docs, code, analysis, findings).

## 3. Propose one entry per segment

Show the user a preview block per segment (one block if there is only one
segment):

```
━━━ ENTRY 1 ━━━
TYPE:      [ai-interaction | decision | finding | meeting — pick the one
            that best describes what this segment produced; most session
            logs are ai-interaction]
TITLE:     [one line — tool + model + date, e.g. "Claude Code (Opus) — 2026-09-10"]
DATE:      [today, or when the work happened if different]
TAGS:      [from memory.project.tags in .nemeda/agent-kit.json if present,
            otherwise suggest 3-5 free-text tags]

SUMMARY (internal):
[3-6 lines: what happened in this segment, including context a teammate
would need — tensions, open questions, why a choice was made]

CLIENT SUMMARY (sanitised, optional):
[shorter, no internal references, costs, AI tool/model names, or informal
back-and-forth — or "N/A" if this segment is purely internal/technical]

━━━ ENTRY 2 ━━━
[same structure, if there is a second segment]

ANYTHING TO LEAVE OUT? [note what the user wants excluded from any entry]
```

## 4. Wait for confirmation

Ask explicitly:

> "¿Confirmas estas entradas, o quieres modificar algo antes de guardarlas?"

Do not create anything until the user confirms, with or without changes.

## 5. Write the entries

For each confirmed entry, in chronological order (earliest segment first),
pipe the entry as JSON to `nemeda-agent memory add --json`:

```bash
echo '{"type":"ai-interaction","title":"Claude Code (Opus) — 2026-09-10","tags":["architecture"],"summary":"...","clientSummary":"..."}' \
  | nemeda-agent memory add --json --cwd <repository root>
```

The author and project come from the workspace automatically (`git config
user.email`, `.nemeda/agent-kit.json`); never pass an id or a person lookup
table. Each entry lands as `pending` in the confirming person's own journal —
this skill's confirmation step is the review, so there is nothing left in the
inbox for `nemeda-agent memory review` to do with it.

Report the created entry ids (or the printed one-line summary) back to the
user; do not silently succeed.

## Notes

- Meeting entries are filed by the meeting pipeline itself
  (`meeting-capture-plan.md`, through `recordEntry`), not through this skill.
- If `nemeda-agent memory add` fails (e.g. no `git config user.email`), show
  the exact error and stop — never fall back to writing the journal file
  directly.
- `airtable.knowledgeLog` and the old Drive `klog.md` commands still work
  during the migration window, but new entries should go through this skill.
