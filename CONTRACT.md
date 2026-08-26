# BIGNOSE OS — Frozen Contract

**Every agent codes to this file. Do not change it. Do not invent endpoints or event types.**

Port: **4317**. Bind: **127.0.0.1 only**.

---

## 1. File ownership map

Each agent owns *only* its listed files. Never create or edit a file owned by another agent.
If you need something from another slice, code against the contract below and assume it exists.

| Slice | Owns |
|---|---|
| A · server core | `server/index.js`, `server/lib/bus.js`, `server/lib/registry.js`, `server/lib/config.js` |
| B · scanner | `server/lib/scanner.js`, `server/lib/redact.js`, `server/routes/graph.js` |
| C · jobs watcher | `server/lib/jobs.js`, `server/routes/jobs.js` |
| D · catalog | `server/lib/frontmatter.js`, `server/lib/catalog.js`, `server/lib/sidecar.js`, `server/routes/catalog.js` |
| E · run manager | `server/lib/runner.js`, `server/routes/run.js` |
| F · shell UI | `public/index.html`, `public/js/app.js`, `public/js/sse.js`, `public/js/views/dashboard.js`, `public/css/shell.css` |
| G · brain UI | `public/js/views/brain.js`, `public/js/graph-layout.js`, `public/js/graph-render.js`, `public/css/brain.css` |
| H · hooks | `hooks/dispatch.js`, `hooks/install.js`, `docs/HOOKS.md` |
| I · local knowledge | `server/lib/brain-index.js`, `server/routes/brain.js`, `test/brain-index.test.mjs` |

**Shared, already written — read-only for all agents:** `public/css/tokens.css`, `DESIGN.md`, `CONTRACT.md`, `package.json`.

---

## 2. SSE event envelope

Endpoint: `GET /api/events` → `text/event-stream`.

Every message is a single JSON object on the `data:` line:

```json
{ "type": "job.state", "ts": 1755792000000, "payload": { } }
```

**Frozen `type` values — no others:**

| type | payload |
|---|---|
| `hello` | `{ serverStartedAt, version }` — sent once on connect |
| `job.state` | a full job object (see §4) |
| `job.removed` | `{ id }` |
| `hook.event` | `{ event, sessionId, cwd, toolName, at }` |
| `run.started` | `{ runId, sessionId, prompt, model, effort }` |
| `run.delta` | `{ runId, text }` |
| `run.tool` | `{ runId, toolName, input }` |
| `run.done` | `{ runId, ok, result, usage, costUsd }` |
| `graph.invalidated` | `{ reason }` |
| `catalog.invalidated` | `{ reason }` |

Server-side, all emission goes through `bus.emit(type, payload)` from `server/lib/bus.js`.
Client-side, all consumption goes through `subscribe(type, fn)` from `public/js/sse.js`.

---

## 3. HTTP endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ ok, version, startedAt, port }` |
| GET | `/api/events` | SSE stream (§2) |
| POST | `/api/hooks` | `202`. Body = raw Claude Code hook JSON. Requires `Authorization: Bearer <token>`. Emits `hook.event`. |
| GET | `/api/jobs` | `{ jobs: Job[] }` (§4) |
| GET | `/api/catalog` | `{ skills: Skill[], agents: Agent[], routines: Routine[], mcpServers: string[] }` (§5) |
| PATCH | `/api/catalog/skill/:name` | body `{ model?, effort? }` → persists sidecar, returns updated `Skill` |
| GET | `/api/graph` | `{ nodes: Node[], edges: Edge[], stats }` (§6) |
| GET | `/api/brain` | Bounded local knowledge payload (§6.1). Query: `q?`, `type?`, `limit?`, `offset?`, `focus?`, `depth=1|2`, `view=map`. Always JSON/200. |
| GET | `/api/brain/resume` | Bounded source-cited resume projection (§6.1). Query: `id?`. Always JSON/200. |
| GET | `/api/brain/inbox` | Bounded local freshness and candidate projection (§6.1). Query: `since?`. Always JSON/200. |
| GET | `/api/brain/ask` | Deterministic local cited retrieval projection (§6.1). Query: `q?`, `provider?`, `project?`. Always JSON/200. |
| GET | `/api/brain/gaps` | Bounded conservative Claude/Codex comparison projection (§6.1). Always JSON/200. |
| POST | `/api/brain/refresh` | Invalidates and rebuilds only the in-memory Brain index, returning the normal list projection plus `refreshed: true` (§6.1). Accepts no path or body configuration. Always JSON/200. |
| POST | `/api/graph/rescan` | `202`, triggers rescan, emits `graph.invalidated` |
| POST | `/api/run` | body `{ prompt, model?, effort?, cwd? }` → `{ runId, sessionId }`. Streams via SSE. |
| GET | `/api/run/:runId` | `{ runId, state, transcript }` |

Static files are served from `public/` at `/`.

---

## 4. Job shape

Derived from `~/.claude/jobs/<id>/state.json`. Missing fields → `null`, never `undefined`.

```ts
type Job = {
  id: string;             // directory name
  name: string | null;
  state: string | null;   // "working" | "blocked" | …
  tempo: string | null;
  detail: string | null;
  cwd: string | null;
  sessionId: string | null;
  createdAt: number | null;   // epoch ms
  updatedAt: number | null;
  tokens: number | null;
  inFlight: { tasks: number; queued: number; kinds: string[] };
  fan: Array<{ id: string; kind: string; label: string; startedAt: number; doneAt: number; ageDays: number }>;
  needs: string | null;
  suggestedReply: string | null;
  timeline: Array<{ at: string; state: string; detail: string; text: string }>; // last 50
};
```

`ageDays` is computed server-side: `startedAt ? floor((now - startedAt)/86400000) : 0`.

---

## 5. Catalog shapes

```ts
type Skill = {
  name: string;
  description: string;
  scope: "user" | "project" | "plugin";
  path: string;
  argumentHint: string | null;
  allowedTools: string[] | null;
  userInvokable: boolean;      // accepts BOTH `user-invokable` and `user-invocable`
  disableModelInvocation: boolean;
  model: string | null;        // SIDECAR ONLY — never from SKILL.md frontmatter
  effort: string | null;       // SIDECAR ONLY
};

type Agent = {
  name: string; description: string; model: string | null;
  tools: string[] | null; memory: string | null; path: string;
};

type Routine = {
  id: string; name: string; schedule: string | null;
  runner: "hermes" | "desktop" | "local";
  lastRunAt: number | null; nextRunAt: number | null;
  status: "fired" | "next" | "queued" | "idle";
};
```

Sidecar store lives at `~/.boombignose_claudeos/sidecar.json`, shape `{ "<skill-name>": { model, effort } }`.

---

## 6. Graph shapes

```ts
type Node = {
  id: string;            // stable: relative path
  label: string;
  path: string;
  kind: "dir" | "file";
  ring: "core" | "skills" | "memory" | "routines" | "applications";
  department: string | null;   // BUSINESS | CONTENT | COMMUNITY | PRODUCT | PERSONAL | null
  ext: string | null;
  size: number;
  mtime: number;
  claudeOnly: boolean;   // path contains "/.claude/"
  files: number;         // rollup, dirs only
  mdFiles: number;       // rollup, dirs only
  bytes: number;         // rollup, dirs only
  depth: number;
};
type Edge = { source: string; target: string };
```

Scan roots default to `~/.claude` only. Ignore: `node_modules`, `.git`, `backups`, `security`, `session-env`, `shell-snapshots`, `paste-cache`, `cache`, `.DS_Store`. Depth cap 8. Cache to `~/.boombignose_claudeos/graph-cache.json`.

**Redaction is mandatory.** No file *content* is ever sent to the browser by the scanner — only metadata. Any string that does reach the client (labels, descriptions, `detail`, timeline text) passes through `redact()` from `server/lib/redact.js` first.

### 6.1 Local Second Brain derived-content boundary

`GET /api/brain` may read Markdown only from the configured local `.claude` and `.codex` roots. The indexer is read-only, makes no network calls, rejects an approved root when `lstat` identifies the root itself as a symlink, ignores nested symlinks and canonical paths outside each approved root, skips files above 256 KiB, and degrades unreadable or malformed sources to an empty or partial result.

The browser receives schema version 1 with summary counts, a `page` object (`total`, `offset`, `limit`, `hasMore`), a global `today` object (`continueWorking`, `recentDecisions`, `needsAttention`), bounded item fields, source provenance, and labeled deterministic relations. Raw Markdown bodies are never serialized. Summaries are capped at 240 characters, tags are capped at 12 entries and 40 characters each, and every returned string is passed through `redact()` before it crosses the HTTP boundary.

List/search requests support case-insensitive `q` across title, summary, project, and tags (first 120 characters), one valid item `type`, a nonnegative `offset`, and `limit` defaulting to 100 and capped at 200. Relations are included only when both endpoints occur in the returned page. `view=map` returns the normal bounded payload fields plus `providers` (the selected item count for `claude` and `codex`), up to six newest items for each of seven item types for each provider (at most 84 base items total), and only relations whose two endpoints are among those selected items. This semantic fallback-map cap is separate from the 40-node filesystem structure projection cap. `focus=<item-id>` ignores list projection. Its default `depth=1` returns the selected item first, at most six incoming plus six outgoing relations, and every required endpoint item, for at most 13 items total. Only literal `depth=2` enables the stable two-hop breadth-first expansion: it retains the depth-1 first hop, expands those stable first-hop items in order, and caps the complete returned neighborhood at 25 items and 32 relations. Any other depth value behaves as depth 1. Each direction is sorted before its first-hop cap by evidence priority (`explicit-link`, `declared`, `shared-project`), confidence descending, then stable relation ID; added relations are also deterministic and never expose an endpoint outside the returned items.

`today` is always derived from the complete cached index before list filtering or pagination. `continueWorking` is the newest active project or task; `recentDecisions` is the newest three decisions; `needsAttention` is up to three items with blocked items first and next items second, newest first inside each status. Equal timestamps use stable item ID order.

The route retains one full local index in process for 30 seconds and coalesces concurrent rebuilds; query, focus, and all workflow projections use that same full cache and never create a second cache or leave the Mac. `POST /api/brain/refresh` clears only the in-memory cache flags, starts or joins the current refresh rebuild, and uses a cache generation so a rebuild that began before the refresh cannot be returned as that refresh or overwrite its result. It never mutates source files or accepts caller-selected paths.

The workflow routes project only the complete cached index:

- `GET /api/brain/resume?id=<item-id>` returns `{ schema, builtAt, selected, projectItems, decisions, attention, citations, nextAction }`. Related project items and citations cap at 8; decisions and attention cap at 3. Unknown IDs return the same empty projection.
- `GET /api/brain/inbox?since=<epoch-ms>` returns `{ schema, builtAt, since, newItems, unclassified, changedInstructions, total }`. `since` is a nonnegative safe integer clamped to `builtAt`; each list caps at 12. `unclassified` is the separate bounded candidate collection from approved Markdown traversal, never semantic item counts or relations. Instruction candidates are limited to conservative approved filenames and rules/memory roots.
- `GET /api/brain/ask?q=<query>&provider=<all|claude|codex>&project=<name>` returns `{ schema, builtAt, query, scope, answer, results, citations }`. The 160-character query is token-scored case-insensitively across bounded indexed metadata, with results capped at 8 and ordered by score, recency, then stable ID. The Thai `answer` is a deterministic summary of those local results, not an LLM or network call; every result carries exact local provider/path provenance.
- `GET /api/brain/gaps` returns `{ schema, builtAt, gaps }`, at most 12 evidence-led `missing-counterpart` or `possible-divergence` suggestions. These are review candidates only, never confirmed conflicts or an automatic sync/cleanup action.

All Brain route failures return HTTP 200 with the matching fixed empty projection plus `unavailable: true`; no exception text, raw Markdown, or absolute home path is serialized. Refresh failure likewise returns the fixed empty list projection with `refreshed: true` and `unavailable: true`. These read-only, loopback-only routes make no network calls; the existing server Host/Origin middleware remains the caller boundary.

The browser's workflow UI may persist only one value: numeric `lastSeenBuiltAt` in localStorage,
written after the explicit Inbox `ตรวจแล้ว` action. Gap dismissals are session-only. No Brain content,
candidate, citation, query, provider comparison, or source path is persisted by these UI states. Copy
actions write plain text to the Clipboard API only when it is available; they do not invoke a provider,
write a source file, or change the in-memory cache.

---

## 7. Conventions

- ES modules (`import`/`export`) throughout, Node 20+. No TypeScript, no bundler, no framework.
- Frontend is vanilla ES modules loaded with `<script type="module">`. No React, no CDN (offline-safe).
- The graph renders to **canvas**, not SVG.
- Never call `process.exit` outside `server/index.js`.
- Every module exports named functions; no default exports.
- If a source file is missing or malformed, degrade to empty/`null` — never throw out of a route.
