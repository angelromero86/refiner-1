---
name: refine-resolve
description: Read open review threads from .refiner/comments.json, apply the requested changes, and reply in-thread (never resolves or deletes)
user-invocable: true
---

# refine-resolve skill

You are reading open review threads from `.refiner/comments.json` and acting on each
one — making the code change the human requested, then **replying** in the thread
with what you did.

The human wrote those threads in one of the two clients that share this file: the
**refiner** TUI or the **Refiner** VSCode extension. Your replies show up in both.

## Arguments

- `thread-id` (optional): process a single thread by id (full id or unique suffix,
  e.g. `/refine-resolve a3f9c1b8`). If omitted, process every actionable open thread.

## Critical rule — read this twice

**You NEVER set `status` to `"resolved"` and you NEVER delete a thread or comment.**

Closing a thread is the human's job, once they've verified your change: `D` on the
thread in the refiner TUI, or the ✓ (Resolve) button in the VSCode extension. Your
job ends at: code change applied + reply comment appended. If you set `status` to
`"resolved"` or remove any thread or comment, you've broken the workflow. Don't.

## Storage format

The file is one JSON object: `{ "version": 1, "threads": [ ... ] }`. Each thread:

```json
{
  "id": "t-a3f9c1b8",
  "file": "src/foo.ts",
  "range": { "start": 42, "end": 45 },
  "status": "open",
  "comments": [
    {
      "id": "c-1",
      "author": "angel",
      "role": "user",
      "body": "this loop is O(n²)",
      "createdAt": "2026-07-17T10:30:00.000Z"
    }
  ]
}
```

You add a reply by **appending** a comment to that thread's `comments` array:

```json
{
  "id": "c-91b2e4d0",
  "author": "Claude Code",
  "role": "assistant",
  "body": "Replaced the scan with a lookup against `byFile`.",
  "createdAt": "2026-07-18T15:10:00.000Z"
}
```

- `role` — always `"assistant"` for your replies. This is how the extension and this
  skill tell your messages from the human's.
- `id` — unique. Use `c-` + 8 hex: `python3 -c "import secrets; print(secrets.token_hex(4))"`.
- `createdAt` — ISO-8601 UTC (current time).
- Leave `status`, `range`, `file`, the human's comments, and any `anchor` field
  untouched. Append only. (`anchor` is the content snapshot the VSCode extension uses
  to keep a thread attached as code moves; dropping it degrades that silently.)

## Formatting the `body`

VSCode renders `body` as **Markdown**. The TUI wraps it as **plain text** — it honors
your line breaks but shows the markup literally. Write prose that reads well either
way: real paragraphs, short lines, no heavy markup scaffolding.

**`body` is a JSON string, so line breaks are `\n`.** A blank line between paragraphs
is `\n\n`. Getting this wrong is the most common mistake: it collapses your whole
reply into one run-on paragraph in both clients.

Use, where they genuinely help:

- **Paragraph breaks** (`\n\n`) — separate what you changed from why, and from any
  caveat. One idea per paragraph.
- **`` `code` ``** — every identifier, file path, flag, type, and literal value.
  Write `` `byFile` `` and `` `null` ``, never bare byFile or null.
- **Fenced code blocks** — when the change is subtle enough that the shape matters
  (a tricky condition, a new signature). Tag the language: ` ```ts `. Keep them to a
  few lines — the human sees the full diff in their editor, so don't paste it back.
- **Bullet lists** — when you touched several files or made several distinct changes
  under one thread.
- **Blockquotes** (`> `) — when quoting the human's own words back to confirm which
  part you're answering, or citing a rule you followed.
- **Bold** — sparingly, for the one phrase that matters most.

A well-formatted reply:

```json
{
  "body": "Replaced the linear scan in `resolveThread` with a lookup against the `byFile` index.\n\nThe old loop walked every thread on each keystroke; the index is built once in `load()`, so this is O(1) per lookup and the O(n²) you flagged is gone.\n\n[suggestion] `findComment` just below has the same pattern, but it's off the hot path — left it alone. Say the word and I'll do it too."
}
```

Don't over-format: a one-line reply to a `[nit]` needs no bullets and no code block.
Match the structure to the size of what you did.

## Prerequisites

1. Confirm you're inside a git repo: `git rev-parse --show-toplevel`.
2. Read `.refiner/comments.json` from the repo root. If it's missing or has zero
   threads, tell the user there's nothing to do and stop.

## Instructions

### Step 1 — Collect actionable threads

Parse the JSON. For each thread, decide whether to act:

| Condition | Action |
|---|---|
| `status` ≠ `"open"` | **Skip** (already resolved) |
| Last comment has `role: "assistant"` | **Skip** — you already replied; awaiting the human. |
| Last comment is a `[question]` you'd need the human to answer | **Skip and note** in the final summary. |
| Last comment has `role: "user"` with an actionable request | **Process** |
| Body starts with `[nit]` | **Process** — minor but actionable |

A `thread-id` argument overrides the loop — process only that thread (after the check).

### Step 2 — For each actionable thread, plan and apply the change

1. **Read the thread's full conversation**, not just the latest comment — earlier
   messages may carry context.
2. **Open the file at the thread's anchor** (`file`, `range.start`, `range.end`; the
   lines are 1-based and inclusive). Read enough surrounding code — often the whole
   file. Note that a thread may sit on a file with no changes at all: the TUI can
   anchor threads anywhere in the repo, not just inside the diff.
3. **Interpret the request**:
   - Direct suggestion ("use a map instead of a slice") → make the change.
   - Question phrased as a suggestion ("should we add X?", "can we rename this?") →
     treat as a request, make the change.
   - Explicit `[question]` from the human → answer in your reply, no code change.
   - Truly unclear → reply asking for clarification (Step 4). Don't silently skip.
4. **Apply the change** with Edit. Stay scoped to the thread's intent — don't
   refactor neighbors or fix unrelated issues. If you spot something else, mention it
   in the reply but don't touch it.
5. **Verify**: run whatever fits (build, type check, tests). If your change breaks
   something, fix it. If it fails for a pre-existing reason, note it and move on.

### Step 3 — Append a reply comment to the thread

Edit `.refiner/comments.json` to append an `{ "role": "assistant", ... }` comment to
the thread you acted on. Do it in place — preserve every other thread and every
existing comment. The reply `body` should:
- State **what changed** (file + the gist).
- State **why it addresses the thread** (one sentence).
- Mention any related-but-out-of-scope thing as a `[suggestion]` for the human.

Format it per **Formatting the `body`** above — real paragraph breaks (`\n\n`),
identifiers in backticks, code blocks only where the shape matters.

Keep the file at 2-space indent with a trailing newline; that is what both clients
write, so matching it avoids whitespace churn in git. After writing, re-read the file
and confirm it's still valid JSON (no trailing commas, balanced quotes). Invalid JSON
makes the extension stop loading and puts the TUI into an error banner with an empty
store.

If the human has the TUI open while you work, they pick your replies up by pressing
`r` (refresh) — it re-reads git and `.refiner/comments.json`.

### Step 4 — When you can't proceed

If a thread is genuinely unclear, append a reply asking for what you need — a
specific question ("did you mean X or Y?"), not a guess. Then move to the next
thread. Do not invent intent.

### Step 5 — Hand off

Summarize for the user:

> Processed N threads:
> - Applied changes: A
> - Asked for clarification: B
> - Skipped (already replied / awaiting you): C
>
> Nothing was resolved or deleted — that's your call. Press `r` in refiner to pick up
> the replies, verify each change, and close the threads you're happy with (`D` in the
> TUI, ✓ in VSCode).

## Do NOT

- Do **not** change `status` on any thread. Leave it `"open"`.
- Do **not** delete any thread or comment — yours or the human's.
- Do **not** edit the human's comments, the `range`, `file`, or `anchor` fields.
- Do **not** batch unrelated changes under one thread's reply.
- Do **not** skip verification. If your change doesn't build/pass, fix it first.
- Do **not** leave the JSON invalid. Re-read your write and confirm it parses.
