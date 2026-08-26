# Hooks

Claude Code fires hooks on lifecycle events. This slice forwards a subset of them
into the running dashboard so the UI can show live session activity.

Two files:

| File | Role |
|---|---|
| `hooks/dispatch.js` | Runs on every hook event. Reads the event JSON on stdin, POSTs it to the dashboard, exits 0. |
| `hooks/install.js` | One-shot installer. Merges hook entries into `~/.claude/settings.json`. |

---

## Events forwarded

Five events, registered by `install.js`:

| Event | Fires when |
|---|---|
| `SessionStart` | a Claude Code session begins |
| `UserPromptSubmit` | the user submits a prompt |
| `PreToolUse` | before a tool call runs |
| `PostToolUse` | after a tool call returns |
| `Stop` | the assistant finishes a turn |

Claude Code may support additional lifecycle events. These five give the
dashboard session boundaries and per-tool-call granularity without adding a
subprocess to events the UI does not render.

`PreToolUse` and `PostToolUse` fire on *every* tool call, so `dispatch.js` is
written to be cheap and to fail silently. See [Cost](#cost) and
[Failure mode](#failure-mode).

---

## Payload

### What dispatch.js sends

The raw hook JSON from stdin, forwarded byte-for-byte. `dispatch.js` parses it
only to confirm it is valid JSON, then sends the original text — it never
rewrites, enriches, or trims the body.

```
POST http://127.0.0.1:4317/api/hooks
Authorization: Bearer <token>
Content-Type: application/json

{
  "session_id": "abc123",
  "cwd": "/current/directory",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" }
}
```

The server replies `202` and the body is discarded by the hook. Field names above
are the ones Claude Code documents; the exact key set varies per event (for
example `PostToolUse` adds a tool response, `UserPromptSubmit` carries no
`tool_name`). Treat any field as possibly absent.

### What the browser receives

The server derives the SSE event from that body — the raw payload never reaches
the browser. Per `CONTRACT.md` §2:

```json
{ "type": "hook.event", "ts": 1755792000000,
  "payload": { "event": "PreToolUse", "sessionId": "abc123",
               "cwd": "/current/directory", "toolName": "Bash", "at": 1755792000000 } }
```

---

## Install

```sh
npm run install-hooks              # dry run — prints the diff, writes nothing
npm run install-hooks -- --yes     # apply
```

**Dry run is the default.** Without `--yes` nothing is written; the command
prints the per-event hook counts before and after, the changes it would make,
and a unified diff. Read it before applying. `--yes` is required for
`--uninstall` too.

Restart your Claude Code sessions afterwards — settings are read at session
start.

What the installer does:

- **Merges.** Your existing hooks are never replaced. Our entry is added as its
  own matcher group appended to each event's array, so it runs after whatever
  you already have and can be removed without touching the rest.
- **Backs up.** `~/.claude/settings.json` is copied to
  `settings.json.claudeos-backup-<timestamp>` (mode 0600) before any write.
- **Writes atomically.** Temp file in the same directory, then `rename`. A crash
  mid-write cannot leave a truncated settings file.
- **Is idempotent.** Running twice adds nothing. Existing entries of ours are
  replaced in place, never duplicated. Entries left behind by an install from a
  different repo location are recognised and updated rather than duplicated.
- **Refuses to write** if `settings.json` is not valid JSON, if `dispatch.js` is
  missing, or if any non-`hooks` key would change.

The entry added to each event matches the schema already in the file:

```jsonc
{
  "matcher": "",                    // omitted for UserPromptSubmit, which is not tool-scoped
  "hooks": [
    { "type": "command",
      "command": "node \"/abs/path/to/hooks/dispatch.js\"",
      "timeout": 5 }
  ]
}
```

### Uninstall

```sh
npm run install-hooks -- --uninstall            # dry run
npm run install-hooks -- --uninstall --yes      # apply
```

Removes only entries whose command points at our `dispatch.js`, across every
event — including events we no longer register. Groups and event keys that we
emptied are pruned; anything that was already empty is left alone. Verified to
restore the file byte-for-byte.

---

## Verify end to end

1. Start the server: `npm start`. Confirm it is up:

   ```sh
   curl -s http://127.0.0.1:4317/api/health
   ```

2. Watch the stream in one terminal:

   ```sh
   curl -N -s http://127.0.0.1:4317/api/events | grep --line-buffered hook.event
   ```

   `--line-buffered` is required — without it `grep` block-buffers and you see
   nothing until the buffer fills.

   To watch the server log instead, start it as
   `npm start 2>&1 | tee /tmp/claudeos.log` and `tail -f /tmp/claudeos.log` in
   another terminal. The SSE stream is the better test: it proves the event
   reached the bus, not just the process.

3. In another terminal, run any Claude Code session and trigger a tool call. A
   `hook.event` line should appear per `PreToolUse` / `PostToolUse` pair.

To test the transport without a Claude Code session, pipe a payload straight
into the dispatcher:

```sh
echo '{"hook_event_name":"PreToolUse","session_id":"t","cwd":"/tmp","tool_name":"Bash"}' \
  | CLAUDEOS_HOOK_DEBUG=1 node hooks/dispatch.js
```

With `CLAUDEOS_HOOK_DEBUG=1` the dispatcher writes one diagnostic line to
**stderr** — `posted, status 202` on success, `dashboard unreachable — no-op`
when the server is down. Without that variable it is completely silent.

If nothing arrives, check in order: server running on 4317; hook entries present
in `settings.json`; sessions restarted since install; token file readable.

---

## Security model

- **Loopback only.** The server binds `127.0.0.1`. Nothing on the network can
  reach `/api/hooks`.
- **Bearer token.** `POST /api/hooks` requires
  `Authorization: Bearer <token>`. The token lives at
  `~/.boombignose_claudeos/hook-token`, mode `0600`, generated once by
  `server/lib/config.js`.
- **The token is never written into `settings.json`.** That file is `0644` and
  readable by any process running as you. `dispatch.js` reads the token from the
  `0600` file at runtime instead, so the command string in your config contains
  no secret. `CLAUDEOS_HOOK_TOKEN` overrides the file if you prefer to pin one.
- **No hook payload is persisted by the dispatcher.** It reads stdin, POSTs, and
  exits. What the server does with the body is the server's concern; per
  `CONTRACT.md` §6 only redacted metadata reaches the browser.
- **Missing token is not an error.** If the token file is absent or unreadable,
  `dispatch.js` exits 0 without sending anything.

---

## Failure mode

`dispatch.js` exits `0` unconditionally. Never `1`, never `2`.

This is deliberate and it is the single most important property of this slice. A
hook that exits non-zero blocks the tool call (exit `2` is Claude Code's "deny"
signal); a hook that hangs stalls the session. A missing dashboard event costs
nothing; a broken Claude Code session costs the user their work.

So every one of these is a silent no-op that lets the tool call proceed:

| Condition | Behaviour |
|---|---|
| Dashboard not running (connection refused) | no-op, exit 0 |
| Dashboard hung (no response) | aborted at 400 ms, no-op, exit 0 |
| Token file missing or unreadable | no-op, exit 0 |
| stdin empty, or not valid JSON | no-op, exit 0 |
| stdin payload larger than 4 MB | dropped entirely, no-op, exit 0 |
| stdin never reaches EOF | watchdog fires at 430 ms, exit 0 |
| Any unexpected throw or rejection | caught, exit 0 |

**`dispatch.js` never writes to stdout.** Claude Code interprets hook stdout —
for `UserPromptSubmit` it is injected into the model's context, and structured
JSON on stdout can change permission decisions. All diagnostics go to stderr,
and only under `CLAUDEOS_HOOK_DEBUG=1`.

The practical consequence: you can stop the dashboard, delete the token, or
break the server at any time, and Claude Code sessions are unaffected. Events
resume the next time the server is reachable. There is no queue and no retry —
events dropped while the dashboard is down are gone.

### Cost

Measured on this machine (Node 22, macOS), wall time of the `dispatch.js`
process itself:

| Scenario | Wall time |
|---|---|
| Server down (connection refused) | 59–81 ms |
| Server up, 202 returned | ~70 ms |
| Empty stdin | ~20 ms |
| Worst case (stdin never closes, server hung) | 454–466 ms, capped by the watchdog |

Roughly 20 ms of that is Node's own startup. The `timeout: 5` in the settings
entry is Claude Code's own ceiling, in seconds — an order of magnitude above
anything observed, and only reachable if the watchdog itself failed.

---

## Environment variables

| Variable | Effect |
|---|---|
| `CLAUDEOS_HOOK_TOKEN` | Bearer token; overrides the token file. |
| `CLAUDEOS_PORT` | Dashboard port. Defaults to `4317`. |
| `CLAUDEOS_HOOK_DEBUG` | `1` enables one diagnostic line per invocation, on stderr. |

## Implementation note

`dispatch.js` does **not** import `server/lib/config.js`, even though that module
exports `CONFIG.HOOK_TOKEN`. Importing it would create the state directory, read
`package.json`, pull in `node:crypto`, and generate the token as a side effect —
acceptable once in a long-lived server, not on every tool call. The dispatcher
inlines the two values it needs (token path, port) and imports only `node:fs`,
`node:os`, `node:path`, and `node:url`. If `config.js` ever changes `TOKEN_PATH`
or the default port, `dispatch.js` must be updated to match.

`install.js` is a one-shot admin script and does import `CONFIG`, which has the
useful side effect of ensuring the token file exists before any hook fires.
