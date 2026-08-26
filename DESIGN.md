# BIGNOSE OS — Design Contract

**The design is the number-one requirement.** Every color, size and spacing value comes from
`public/css/tokens.css`. Never hardcode a hex value. Orange remains the sole generic action accent.
Teal is reserved for Codex provider identity. Provider and status colors retain their documented
semantic roles. `tokens.css` may receive named semantic aliases, but existing base values remain
stable unless a reviewed design specification explicitly replaces them.

> Visual language follows the reference agent-OS dashboard shown to the user (RUBRIC Agentic OS,
> by Jay E / RoboNuggets). We build the same *language* — dark instrument panel, single orange
> accent, hex tiling, and hairline instrumentation — under our own name. Do not reproduce their wordmark,
> logo, or product name anywhere in the UI.

Product name in the UI: **BIGNOSE** (white) + **OS** (orange), with local-only and
provider-structure trust lines beneath it. Second Brain view header: **BIGNOSE** `SECOND BRAIN`.

---

## The look, in one paragraph

A dark instrument panel, not a web page. Near-black ground with a faint hexagon tiling.
Everything is hairline-ruled rather than boxed-and-shadowed. Labels are small, uppercase and
widely letter-spaced; data is large and orange. Icons are thin monoline strokes, never filled,
never emoji. Nothing is rounded more than 4px except node circles and pills. The single orange
accent marks *the live thing* — the current time, the unread count, the next routine, the run
button — and nothing else. Restraint with the accent is what makes it read as an instrument.

---

## Layout — OS shell (`/`)

Three columns, full-bleed, no page scroll. The center column is the stage.

```
┌────────────────┬──────────────────────────────┬──────────────────┐
│ MICRO APPS     │             BIGNOSE OS        │ EMAIL            │
│  · icon + name │        LOCAL · READ ONLY      │  47  PAST 24H    │
│  · one-liner → │        ✎  ⌕  ⊞  ⓘ            │  flagged rows    │
├────────────────┤                              │  TODAY'S MIX ▤▤▤ │
│ CALENDAR       │      ◜ ring of task nodes ◝  ├──────────────────┤
│  analog clock  │     each: circle + icon      │ SKILLS DECK      │
│  02:36:07 pm   │     + age badge (9D)         │  2×2 cards       │
│  timezone rows │                              ├──────────────────┤
│  quarter grid  │   faint geodesic wireframe   │ ROUTINES         │
│                │   CLICK TO OPEN SECOND BRAIN │  time·name·status│
└────────────────┴──────────────────────────────┴──────────────────┘
```

- Side columns ~300px, fixed; center flexes. Below 1100px the side columns stack under the stage.
- Panels are separated by `--hair` rules, not gaps and shadows.
- Every panel header: monoline icon + `.label` uppercase text, optional right-aligned meta in `--ink-3`.

### Center stage
- A **ring of circular nodes** arcing across the upper half. Each node: 1px `--ink` stroke circle
  (~52px), thin monoline glyph centred, small `--hair`-bordered badge beneath showing age (`9D`).
- Active/attention nodes get a `--accent` stroke and a soft `--accent-glow` drop shadow.
- Behind it, a faint geodesic wireframe sphere in `--hair` at low opacity, plus scattered 1px dots.
- Footer caption, centred, `.label` in `--accent`: `CLICK TO OPEN SECOND BRAIN`.
- Nodes come from `job.fan[]` (see CONTRACT §4). Empty state: the ring renders dim placeholders.

### Skills Deck cards
Dark `--panel-2` card, 1px `--hair` border, ~2×2 grid:
```
 ⌨ icon
 /newsletter                 ← --ink, 13px, mono
 OPUS · XHIGH                ← model in --m-opus, effort in --ink-3, 10.5px uppercase
 [▶] [⚙]                     ← .btn-run (accent) and .btn-icon
```
Model word takes its own hue: `--m-opus`, `--m-sonnet`, `--m-fable`, `--m-haiku`.

### Routines table
Columns `TIME · ROUTINE · STATUS`, uppercase micro header in `--ink-3`. Rows are dim (`--ink-3`).
The **next** routine is the only lit row: its time cell has an `--accent` filled background with
dark text, its name goes `--ink`, its status reads `NEXT` in `--accent`. `FIRED` is `--ink-4`,
`QUEUED` is `--ink-3`. Runner shown as a small monoline glyph + name.

### Email panel
`47` at `--t-clock` in `--accent`, `EMAILS / PAST 24H` stacked beside it in `.label`.
`FLAGGED · NEEDS JAY` section label, then rows: envelope glyph + subject + right-aligned age.
`TODAY'S MIX` is a segmented bar — thin blocks, `--accent` for the first segment, greys after,
with tiny uppercase counts underneath.

### Calendar panel
Analog clock (circle + two hands, 1px `--ink-2` strokes), `Wk34 | Aug 20 2026 (Thu)` in `--ink-3`,
the live time at `--t-clock` in `--accent`, timezone rows in a 3-up grid, then a Q1–Q4 grid of
small squares: past = `--ink-4` filled, today = `--accent`, future = 1px `--hair` outline.

---

## Layout — Second Brain (`/#brain`)

The Second Brain is a full-bleed, scrollable, local read-only knowledge workspace on `--brain-bg`.
Its default map is a progressive graph of the real `.claude` and `.codex` filesystem topology from
the existing safe local graph data—not a fabricated semantic orbit and never an all-files-at-once
DOM. Thai is the default interface language. Real filenames, folder names, `.claude`, `.codex`,
source paths, and source-authored titles/summaries remain literal; only interface copy, states,
instructions, and relationship labels are translated.

### Information order

```
┌─────────────────────────────────────────────────────────────────────┐
│ BIGNOSE  สมองที่สอง                        กลับหน้า BIGNOSE OS       │
│ ค้นหาสิ่งที่เคยรู้ แล้วทำสิ่งสำคัญต่อ                                │
├─────────────────────────────────────────────────────────────────────┤
│ วันนี้                                                              │
│ ทำงานต่อ             การตัดสินใจล่าสุด       ต้องตรวจสอบ             │
├─────────────────────────────────────────────────────────────────────┤
│ ACTION DECK // LOCAL ONLY                                            │
│ [ทำงานต่อ] [กล่องเข้า] [ถาม Brain] [Claude ↔ Codex]                 │
│ หนึ่งแท็บที่กำลังใช้งาน: หลักฐานและการกระทำที่เกี่ยวข้องเท่านั้น       │
├─────────────────────────────────────────────────────────────────────┤
│ ค้นหาโปรเจกต์ การตัดสินใจ งาน บุคคล และโน้ต…                         │
│ โปรเจกต์ · บุคคล · ไอเดีย · การตัดสินใจ · งาน · โน้ต · แหล่งข้อมูล   │
│                                             รายการ  /  แผนที่         │
├──────────────────────────┬──────────────────────────────────────────┤
│ Readable result list     │ Details + source                         │
│                          │ Leads here ─ SELECTED ─ Leads next       │
└──────────────────────────┴──────────────────────────────────────────┘
```

- **Today** contains one `Continue working` item (the newest active project/task), recent
  decisions, and blocked or next work under `Needs attention`.
- Immediately after Today, one compact **Action Deck** exposes four outcome tabs: `ทำงานต่อ`,
  `กล่องเข้า`, `ถาม Brain`, and `Claude ↔ Codex`. There is one deck node and one active panel;
  inactive panels are hidden and removed from the tab order. Left/right arrow keys move the active
  tab. In map mode that same node moves into the knowledge drawer, so its state is not duplicated.
- `ทำงานต่อ` begins only after the user selects a semantic item. Its Resume Pack is a source-cited
  handoff beam: selected state, up to three decisions, up to three attention items, a deterministic
  next action, and copy buttons for the authentic Claude/Codex destinations. Copying puts plain text
  on the clipboard when available; it never launches an agent or executes the proposed work.
- `กล่องเข้า` is lazy-loaded and deliberately cautious: it shows the index time plus bounded new,
  unclassified, and changed-instruction groups. Refresh keeps the prior view visible and rebuilds
  only the local in-memory index. `ตรวจแล้ว` records only the current index timestamp; copying a
  path or a classification template does not write a source file or classify it automatically.
- `ถาม Brain` is a labeled local retrieval form with a provider selector. Its answer is a
  deterministic summary of the bounded local index, with an exact provider/path citation for every
  result; it is not a remote AI answer. `Claude ↔ Codex` is also lazy-loaded and presents only
  evidence-led review suggestions. Inspect, copy evidence, and session-only dismiss are available;
  there is no confirmed-conflict claim, provider synchronization, cleanup, or publication action.
- Search covers title, summary, project, and tags. Seven native category buttons expose selected
  state through `aria-pressed`; result buttons use the same native pressed-state pattern rather
  than overriding their semantics with an incomplete listbox/option pattern.
- Search and category changes request a bounded server page. At most 100 results render at once;
  `Show more` replaces the current page with the next bounded page instead of growing the DOM.
- `แผนที่` is the default. A prominent two-state `รายการ` / `แผนที่` switch changes only the
  presentation, retaining the current search, category, page, and selected-memory state. The map
  uses the progressive filesystem projection as soon as the local graph is available; the existing
  bounded semantic map is a graceful fallback when filesystem structure is unavailable.
- Results use plain titles, summaries, type, status, and date. The details panel shows the bounded
  summary, project, tags, source provider, and source display path. Teal appears only for Codex
  provider identity; generic selection and actions remain orange.
- Loading says the safe local index is being read. Unavailable state gives a `ลองอีกครั้ง` action
  without exposing technical paths. Empty and no-match states tell the user what to do next.

### Signatures — progressive filesystem map and memory trail

The Map is the square, circular BIGNOSE OS knowledge world: a neutral `ศูนย์กลางความรู้` remains between separate,
authentic local Claude and Codex SVG provider roots, with Claude on the left and Codex on the right.
Their provider colours and logos remain distinct. Both roots expose their first real level at open.
Each provider initially shows no more than ten real children, sorted directories first, then
descendant file count, then label. Each provider root toggles its own first-level projection. A
synthetic `+N เพิ่มเติม` node carries the exact next-child offset, so changing from the ten-item
overview to the fourteen-item focused view never skips a sibling; it never impersonates a real
directory. Initial context stays at most 25 visible nodes; every map state is capped at 40 visible
nodes. The complete filesystem may remain in local data, but it must never be rendered as the
complete graph.

Folders and files are native HTML buttons over the route layer, not canvas-only hit regions. Provider
overview context remains retained and protected. A folder click focuses it and exposes no more than
14 direct children while retaining its real ancestor spine and the two provider roots. Opening another
folder replaces the active deep path only within that provider; the other provider's deep path may
remain visible subject to the shared 40-node budget. Clicking the focused folder collapses one level;
`Escape` also collapses one level.
Breadcrumb segments jump directly to real ancestors, and the neutral center resets the initial
projection. Every accessible name conveys its kind, provider, expanded state where applicable, and
full literal path. Folder labels remain visible; long file labels may visually truncate but retain
their complete `title` and accessible name.

Selecting a file opens a relationship rail with its literal provider path, type, modification date,
and size. The map toolbar provides only numeric `1 ชั้น` and `2 ชั้น` controls. Depth 1 keeps the
direct focused neighborhood; depth 2 may add the bounded next hop, routed through its visible
first-hop parent. Core, Claude, Codex, and first-hop anchors retain their positions when depth
changes. Second-hop nodes, routes, and junctions have quieter emphasis but keep their provider
colour and readable label. The complete rendered structural/semantic projection remains capped at
40 nodes. A separate Thai zoom group provides `− ย่อ`, a percentage/reset control, and `+ ขยาย`;
it scales one shared graph world from 70% to 140% in 10% steps, remains in memory while switching
depth or presentation during the mounted view, and never changes the underlying projection. No
semantic result invents a folder or filesystem path. In List, the selected item remains
visibly anchored between `Leads here` and `Leads next`; each side has at most six explicitly labelled,
directed relations, while unlabeled relations are omitted.

Provider ownership and knowledge role are independent signals. Claude ancestry/trunks use
`--provider-claude`; Codex ancestry/trunks use `--provider-codex`; every structural node carries its
literal `.claude` or `.codex` badge. The six role colours are: core/configuration orange;
skills/agents/commands violet; memory/projects/plans magenta; routines/hooks/automations gold;
applications/plugins/MCP cyan-green; and unknown/unclassified material muted blue. Folder nodes are
hexagons, file nodes diamonds, paging nodes segmented rings, and semantic relations compact
satellites. Ownership controls the outer stroke and badge; role controls the inner mark/fill, so
neither fact relies on colour alone.

Routes are deterministic, collision-safe branch lanes—not concentric semantic rings or force
layout. Node centers keep at least the sum of their radii plus 18px; label rectangles keep at least
8px, advancing to the next stable lane slot when necessary. Three ordered polyline layers make
ancestry and meaning legible: bright provider trunks from center to roots; medium-opacity,
provider-coloured hierarchy routes that follow real parent-child lanes, share segments, and split at
diamond junctions; then brighter semantic routes above them. Incoming semantic routes use
cyan-violet and a distinct dash/junction treatment; outgoing routes use orange-gold and another
treatment, with Thai direction labels as a second cue. Never draw direct center-to-descendant
shortcuts or a global edge field.

The relationship rail and breadcrumb remain visible map instruments. `เปิดคลังความรู้` opens the
existing search/category/current-results drawer; when closed, that drawer is inert and removed from
keyboard navigation. The map has a visible `กลับหน้ารายการ` action. It exposes no filesystem open,
edit, delete, rescan, write, or execution action. Loading continues to say the safe local index is
being read; if filesystem structure is unavailable, retain the bounded knowledge-map fallback and
explain the limitation in Thai rather than showing a blank screen. If a file has no indexed semantic
projection, preserve its filesystem details and state that no indexed relationships are available.

### Responsive and accessible behavior

- Above 900px, results and details form two columns. At 900px and below, details move below the
  result list and the three-part memory trail becomes a vertical sequence with the selected item
  first. The list/details layout and page do not gain horizontal overflow; the structure map may
  scroll only inside its own stage.
- Search is a labeled native input; categories, results, retry, and related-item actions are native
  controls. Keyboard focus remains visible and color is never the only indication of type, status,
  selection, provider, or relation direction.
- Search keeps its input node and focus while debounced results load. Category and paging controls
  regain focus after their response. Item selection keeps the result list intact and moves focus
  to the updated details heading after its separate focused response arrives.
- At phone width, Today becomes one column and primary touch targets are at least 40px high.
- The Action Deck becomes one column on a phone. Its tabs may scroll only inside their own tab strip;
  the page does not gain horizontal overflow.
- The structure map preserves one square circular world. In wide space, its inspector rail can sit
  beside the world; otherwise the rail follows below. At narrow widths, the approximately 980px world
  (before user zoom) remains inside the map stage's own horizontal scroll container. Header,
  breadcrumb, zoom controls, and inspector rail do not move with that internal scroll, and the page
  itself stays clipped to its viewport. The scaled world reserves matching scroll space while SVG
  routes, native-button overlays, rings, and the core share one transform and coordinate plane rather
  than drifting apart or changing into a vertical filesystem lane.
- Map nodes and breadcrumb controls retain at least 40px targets. Labels use progressive disclosure:
  they become fully visible on hover, keyboard focus, or selection, while complete filenames remain
  available to assistive technology.
- The Map uses restrained ambient instrumentation—scanner, sparse particle drift, crosshair, and
  a quiet core pulse—behind the stable hierarchy. It does not restore semantic rings or decorative
  branch growth. `prefers-reduced-motion: reduce` removes branch/route drawing, ambient animation,
  and non-essential transitions without removing the structure or controls.
- Repeated Second Brain geometry uses named `--brain-*` aliases in `tokens.css`. Media-query breakpoints
  are explicitly exempt because CSS custom properties cannot be used in media-query conditions.

---

## Icons

Inline `<svg>`, `stroke="currentColor"`, `stroke-width="1.25"`, `fill="none"`,
`stroke-linecap="round"`, 20×20 viewBox. **No emoji anywhere in the UI.**
Needed set: mail, calendar, bolt, check-square, terminal, play, gear, search, pencil, grid, info,
image, monitor, brain, pen-tool, clock, hexagon, star-4, chevron, menu, diamond.
Keep them in one exported map in `public/js/app.js` (slice F) so slice G can import it.

---

## Motion

Sparing and functional. The OS center-stage nodes may fade and scale in on load. The accent "next
routine" row breathes at 3s. In normal motion, the Second Brain uses short keyed 140–300ms
transitions for graph geometry, node reveal/exit, and route entry/exit; hover transitions are 150ms.
Its low-intensity scanner, sparse particles, and quiet core signal may run behind stable filesystem
structure, never as a substitute for hierarchy or interaction. Honour `prefers-reduced-motion` by
removing all ambient, branch/route, and non-essential transition motion.

---

## Anti-goals

No emoji. No semantic-ring disc, direct center-to-every-node wiring, force-layout cloud, global
all-files graph, or decorative gradient. No drop shadows on panels. No border-radius above 4px on
rectangles. No competing generic action accent. No filled UI icons (structural node inner marks are
the documented exception). No centered body text. No purple-blue hero gradient. No CDN fonts or
scripts — the app must run offline, local-only, and read-only.
