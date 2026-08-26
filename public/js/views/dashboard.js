// public/js/views/dashboard.js — Slice F · the OS shell view.
//
// Three columns per DESIGN.md: APPLICATIONS + CALENDAR | stage | EMAIL + SKILLS
// DECK + ROUTINES. Every panel degrades to an honest empty state; nothing here
// invents a number it cannot source.

import { icon } from '../icons.js';
import { getJSON, sendJSON } from '../app.js';
import { fetchLocalApi } from '../local-api.js';
import { subscribe, connectionState } from '../sse.js';
import {
  buildRunRequest,
  buildSkillRunRequest,
  createRunUiState,
  projectTrackedRuns,
  reconcileTrackedRunDone,
  reduceRunUiState,
  safeRunError,
  safeRunDoneAction,
  skillKey,
} from '../run-state.js';

// ---------------------------------------------------------------------------
// EMAIL PANEL — AWAITING A DATA SOURCE
//
// There is no email endpoint in CONTRACT.md §3 and no slice owns one. Rather
// than fabricate the reference mock's "47 / needs Jay" (presenting invented
// data as real is worse than an empty panel), the panel renders its full
// visual treatment from this inert constant: every value is null and renders
// as an em dash, the flagged rows are blank rules rather than fake subjects,
// and the section label reads NO SOURCE CONNECTED.
//
// When a real source lands, replace this constant with a fetch. Do NOT fill
// these nulls in by hand.
// ---------------------------------------------------------------------------
const EMAIL_PLACEHOLDER = Object.freeze({
  count: null,                                     // -> "—"
  window: 'PAST 24H',
  flagged: Object.freeze([null, null, null]),      // -> three inert skeleton rows
  mix: Object.freeze([                             // -> segmented bar, all counts null
    Object.freeze({ key: 'DIRECT', n: null }),
    Object.freeze({ key: 'THREAD', n: null }),
    Object.freeze({ key: 'AUTO', n: null }),
    Object.freeze({ key: 'OTHER', n: null }),
  ]),
});

const DASH = '—';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const clamp = (lo, v, hi) => Math.max(lo, Math.min(v, hi));

/** 1031102 -> "1.03M"; 4210 -> "4.2K"; 812 -> "812" */
function compactInt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DASH;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** Deterministic PRNG so the scattered dots never reshuffle between renders. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ISO-8601 week number (Monday-based, week containing the year's first Thursday). */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((t - yearStart) / 86400000 + 1) / 7), year: t.getUTCFullYear() };
}
/** Dec 28 always falls in the last ISO week of its ISO year. */
const isoWeeksInYear = (y) => isoWeek(new Date(y, 11, 28)).week;

const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

const KIND_GLYPH = { todo: 'check-square', task: 'bolt', tool: 'terminal', run: 'play', file: 'file' };
const RUNNER_GLYPH = { hermes: 'bolt', desktop: 'monitor', local: 'terminal' };

const CLAUDE_MODELS = ['opus', 'sonnet', 'fable', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const PROVIDER_STORAGE_KEY = 'boombignose.unified-agent-os.execution-provider';

function providerId(value) {
  return value === 'codex' ? 'codex' : 'claude';
}

function providerLabel(value) {
  return providerId(value) === 'codex' ? 'Codex' : 'Claude';
}

// Operator Brief view models are intentionally pure: they translate already
// normalized local data into a deterministic, read-only presentation.
export function literal(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function provenUpcomingRoutine(routines, now = Date.now()) {
  const rows = Array.isArray(routines) ? routines : [];
  const declared = rows.find((routine) => routine?.status === 'next');
  if (declared) return declared;
  return rows
    .filter((routine) => Number.isFinite(routine?.nextRunAt) && routine.nextRunAt > now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt || literal(a?.id).localeCompare(literal(b?.id)))[0] ?? null;
}

function jobSignal(job, mode) {
  const tasks = Array.isArray(job?.fan) ? job.fan : [];
  const open = tasks.filter((task) => !(Number.isFinite(task?.doneAt) && task.doneAt > 0));
  const firstOpen = open[0] ?? tasks[0] ?? null;
  const needs = literal(job?.needs);
  const reply = literal(job?.suggestedReply);
  const detail = literal(job?.detail);
  const fallback = mode === 'blocked' ? 'งานติดขัด'
    : mode === 'needs' ? 'งานที่ต้องการคุณ' : 'งานกำลังดำเนินอยู่';
  const state = mode === 'blocked' ? 'ต้องการคุณ'
    : mode === 'needs' ? 'รอการตัดสินใจ' : 'กำลังทำงาน';
  const progress = tasks.length ? `ยังเปิด ${open.length} จาก ${tasks.length} งานย่อย` : 'ยังไม่มีรายการงานย่อย';
  return {
    id: `job:${literal(job?.id)}:${mode}`, kind: 'job', state,
    title: literal(job?.name) || fallback,
    current: detail || (mode === 'active' ? progress : needs),
    why: needs || (firstOpen ? `งานย่อยถัดไปคือ ${literal(firstOpen.label) || literal(firstOpen.kind) || literal(firstOpen.id)}` : progress),
    next: reply ? 'เปิดรายละเอียด แล้วคัดลอกคำตอบที่แนะนำ'
      : needs ? 'เปิดรายละเอียดเพื่อตรวจสิ่งที่งานต้องการ' : 'เปิดรายละเอียดเพื่อติดตามหรือคัดลอกบริบทงาน',
    target: 'work', jobId: literal(job?.id) || null, taskId: literal(firstOpen?.id) || null,
    tone: mode === 'active' ? 'active' : 'attention',
  };
}

function routineSignal(routine) {
  const nextRunAt = Number.isFinite(routine?.nextRunAt) ? routine.nextRunAt : null;
  return {
    id: `routine:${literal(routine?.id)}`, kind: 'routine', state: 'คิวถัดไป',
    title: literal(routine?.name) || 'งานอัตโนมัติที่กำลังจะถึง',
    current: nextRunAt === null ? 'ระบบระบุว่านี่คือคิวถัดไป'
      : `กำหนดไว้ ${new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(nextRunAt))}`,
    why: 'เป็นเวลาทำงานที่ยืนยันได้จากข้อมูลในเครื่อง',
    next: 'เปิดดูหลักฐานในแผงงานอัตโนมัติ',
    target: 'routines', jobId: null, taskId: null, tone: 'scheduled',
  };
}

function capabilitySignal(skillCount, appCount) {
  const target = skillCount > 0 ? 'skills' : 'apps';
  return {
    id: `capability:${skillCount}:${appCount}`, kind: 'capability', state: 'พร้อมใช้', title: 'มีความสามารถในเครื่อง',
    current: `พบ ${skillCount} คู่มือ และ ${appCount} ความสามารถที่เชื่อมไว้`,
    why: 'ระบบมองเห็นทรัพยากรเหล่านี้ แต่ยังไม่ได้รันอะไร',
    next: target === 'skills' ? 'เปิดดูคู่มือที่ใช้ได้' : 'เปิดดูความสามารถที่ค้นพบ',
    target, jobId: null, taskId: null, tone: 'capability',
  };
}

function viewerReadySignal(connection) {
  return {
    id: `system:${connection}`, kind: 'system', state: 'พร้อมดูข้อมูล', title: 'ระบบในเครื่องพร้อม',
    current: connection === 'open' ? 'เชื่อมต่อข้อมูลสดแล้ว' : 'อ่านข้อมูลในเครื่องได้',
    why: 'ยังไม่มีงาน คิว หรือความสามารถที่ต้องแสดง', next: 'ตรวจสถานะระบบหรือเปิด Second Brain',
    target: 'system', jobId: null, taskId: null, tone: 'ready',
  };
}

function unavailableSignal() {
  return {
    id: 'system:unavailable', kind: 'unavailable', state: 'ไม่มีข้อมูล', title: 'ยังอ่านข้อมูลในเครื่องไม่ได้',
    current: 'งานและแค็ตตาล็อกยังไม่พร้อม', why: 'หน้านี้ไม่ควรเดาสถานะ',
    next: 'ตรวจว่าเซิร์ฟเวอร์ในเครื่องกำลังทำงาน',
    target: 'system', jobId: null, taskId: null, tone: 'stale',
  };
}

function loadingSignal(connection) {
  return {
    id: `system:loading:${connection}`, kind: 'loading', state: 'กำลังอ่านข้อมูล', title: 'กำลังเตรียมสรุปสถานการณ์',
    current: 'กำลังอ่านงานและความสามารถจากข้อมูลในเครื่อง',
    why: 'ข้อมูลยังมาไม่ครบ จึงยังไม่สรุปสถานะแทนคุณ',
    next: 'รอให้ข้อมูลในเครื่องพร้อม แล้วตรวจสัญญาณถัดไป',
    target: 'system', jobId: null, taskId: null, tone: 'loading',
  };
}

export function deriveOperatorSignal(model, connection = 'connecting', now = Date.now()) {
  const jobs = Array.isArray(model?.jobs) ? model.jobs : [];
  const routines = Array.isArray(model?.catalog?.routines) ? model.catalog.routines : [];
  const skillCount = Array.isArray(model?.catalog?.skills) ? model.catalog.skills.length : 0;
  const appCount = applicationViewModel(model?.catalog).length;
  const noUsableData = jobs.length === 0 && routines.length === 0 && skillCount + appCount === 0;
  if (noUsableData && (model?.loading?.jobs || model?.loading?.catalog)) return loadingSignal(connection);
  const blocked = jobs.find((job) => job?.state === 'blocked' && literal(job?.needs));
  if (blocked) return jobSignal(blocked, 'blocked');
  const needs = jobs.find((job) => literal(job?.needs));
  if (needs) return jobSignal(needs, 'needs');
  const active = jobs.find((job) => job?.state === 'working' || job?.state === 'running');
  if (active) return jobSignal(active, 'active');
  const routine = provenUpcomingRoutine(routines, now);
  if (routine) return routineSignal(routine);
  if (skillCount + appCount > 0) return capabilitySignal(skillCount, appCount);
  if (noUsableData && (model?.failed?.jobs || model?.failed?.catalog)) {
    return unavailableSignal();
  }
  return viewerReadySignal(connection);
}

export function deriveReactorState(model, connection = 'connecting') {
  const jobs = Array.isArray(model?.jobs) ? model.jobs : [];
  const routines = Array.isArray(model?.catalog?.routines) ? model.catalog.routines : [];
  const blocked = jobs.some((job) => job?.state === 'blocked');
  const queued = routines.some((routine) => routine?.status === 'next' || routine?.status === 'queued');
  return {
    system: { state: connection === 'open' ? 'ready' : connection === 'connecting' ? 'loading' : 'stale', label: connection === 'open' ? 'เชื่อมต่อสด' : connection === 'connecting' ? 'กำลังเชื่อมต่อ' : 'ขาดการเชื่อมต่อ' },
    work: { state: blocked ? 'attention' : jobs.length ? 'active' : 'idle', label: blocked ? 'ต้องการคุณ' : jobs.length ? 'มีงานอยู่' : 'ยังไม่มีงาน' },
    automation: { state: queued ? 'active' : 'unknown', label: queued ? 'มีคิวแล้ว' : 'ยังไม่ทราบเวลา' },
  };
}

export function deriveJobInspector(job, selectedTaskId = null) {
  if (!job || typeof job !== 'object') return null;
  const fan = Array.isArray(job.fan) ? job.fan : [];
  const task = fan.find((item) => literal(item?.id) === literal(selectedTaskId)) ?? null;
  const done = fan.filter((item) => Number.isFinite(item?.doneAt) && item.doneAt > 0).length;
  const timeline = (Array.isArray(job.timeline) ? job.timeline : []).map((entry, index) => ({
    at: literal(entry?.at), state: literal(entry?.state), detail: literal(entry?.detail), text: literal(entry?.text),
    index, time: Date.parse(entry?.at),
  })).filter((entry) => entry.at || entry.state || entry.detail || entry.text).sort((a, b) => {
    const at = Number.isFinite(a.time) ? a.time : -Infinity;
    const bt = Number.isFinite(b.time) ? b.time : -Infinity;
    return bt - at || b.index - a.index;
  }).slice(0, 5).map(({ at, state, detail, text }) => ({ at, state, detail, text }));
  const context = [
    literal(job.name) && `งาน: ${literal(job.name)}`,
    literal(job.state) && `สถานะ: ${literal(job.state)}`,
    literal(job.detail) && `ตอนนี้: ${literal(job.detail)}`,
    literal(job.needs) && `ต้องการจากคุณ: ${literal(job.needs)}`,
    task && `งานย่อย: ${literal(task.label) || literal(task.id)}`,
  ].filter(Boolean).join('\n');
  return {
    heading: task ? literal(task.label) || 'รายละเอียดงานย่อย' : literal(job.name) || 'รายละเอียดงาน',
    jobId: literal(job.id), taskId: task ? literal(task.id) : null,
    job: { name: literal(job.name), state: literal(job.state), detail: literal(job.detail), needs: literal(job.needs), suggestedReply: literal(job.suggestedReply), cwd: literal(job.cwd) },
    task: task ? { id: literal(task.id), label: literal(task.label), kind: literal(task.kind), ageDays: Number.isFinite(task.ageDays) ? Math.max(0, task.ageDays) : 0, state: Number.isFinite(task.doneAt) && task.doneAt > 0 ? 'เสร็จแล้ว' : 'ยังเปิดอยู่' } : null,
    counts: { total: fan.length, open: fan.length - done, done }, timeline,
    copy: { ...(literal(job.suggestedReply) ? { suggestedReply: literal(job.suggestedReply) } : {}), ...(context ? { context } : {}), ...(literal(job.cwd) ? { cwd: literal(job.cwd) } : {}) },
  };
}

export function deriveTraceTarget(signal) {
  if (signal?.kind === 'job') return 'work';
  if (signal?.kind === 'routine') return 'routines';
  if (signal?.kind === 'capability') return signal.target === 'apps' ? 'apps' : 'skills';
  return 'system';
}

export function applicationViewModel(catalog) {
  if (catalog && Object.hasOwn(catalog, 'applications')) {
    return Array.isArray(catalog.applications) ? catalog.applications : [];
  }
  const legacy = Array.isArray(catalog?.mcpServers) ? catalog.mcpServers : [];
  return legacy.map((name) => ({
    id: `claude:mcp:${String(name)}`,
    name: String(name),
    provider: 'claude',
    kind: 'mcp',
    version: null,
  }));
}

export function normalizeDashboardCatalog(data) {
  const catalog = {
    skills: Array.isArray(data?.skills) ? data.skills : [],
    agents: Array.isArray(data?.agents) ? data.agents : [],
    routines: Array.isArray(data?.routines) ? data.routines : [],
    mcpServers: Array.isArray(data?.mcpServers) ? data.mcpServers : [],
  };
  if (data && Object.hasOwn(data, 'applications')) {
    catalog.applications = Array.isArray(data.applications) ? data.applications : [];
  }
  return catalog;
}

export function skillCardSelector(provider, name, css = CSS) {
  return `.skill-card[data-provider="${css.escape(providerId(provider))}"]` +
    `[data-skill="${css.escape(String(name ?? ''))}"]`;
}

export function buildCatalogSkillRunRequest(catalog, {
  prompt,
  provider,
  name,
} = {}) {
  const selectedProvider = providerId(provider);
  const selectedName = String(name ?? '');
  const skills = Array.isArray(catalog?.skills) ? catalog.skills : [];
  const key = skillKey(selectedProvider, selectedName);
  const skill = skills.find((item) => skillKey(item?.provider, item?.name) === key) ?? null;
  return buildSkillRunRequest({
    prompt,
    provider: selectedProvider,
    model: skill?.model,
    effort: skill?.effort,
  });
}

export function presentRunLaunch(element, row, baseClass) {
  if (!element || !row) return null;
  let presentation;
  if (row.state === 'running') {
    presentation = { text: 'Running', className: 'is-live', running: true };
  } else if (row.ok === true) {
    presentation = { text: 'Done', className: '', running: false };
  } else {
    presentation = {
      text: safeRunError(row.provider, row.errorCode).errorMessage,
      className: 'is-bad',
      running: false,
    };
  }
  const rootClass = String(baseClass ?? '').trim();
  element.textContent = presentation.text;
  element.className = `${rootClass}${presentation.className ? ` ${presentation.className}` : ''}`;
  return presentation;
}

export function reduceRunRailAction(state, runId, action) {
  const row = state?.runs instanceof Map ? state.runs.get(runId) : null;
  if (!row) return state;
  if (action === 'dismiss') {
    return reduceRunUiState(state, { type: 'dismiss', runId });
  }
  if (action === 'continue' && row.provider === 'codex' && row.sessionId !== null) {
    return reduceRunUiState(state, {
      type: 'continue', provider: 'codex', sessionId: row.sessionId,
    });
  }
  return state;
}

export function mountDashboardControls({
  elements,
  initialState = createRunUiState(),
  persistProvider = () => {},
  onSkillAction = () => {},
} = {}) {
  const { providerSwitch, resume, resumeLabel, runrail, cmdbar, deck } = elements;
  let state = initialState;

  if (!providerSwitch || !resume || !resumeLabel || !runrail || !cmdbar || !deck) {
    return {
      getState: () => state,
      commit(next) { state = next; },
      render() {},
      destroy() {},
    };
  }

  function renderComposerState() {
    const resuming = state.resumeContext !== null;
    for (const button of providerSwitch.querySelectorAll('button[data-provider]')) {
      const selected = button.dataset.provider === state.selectedProvider;
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = resuming;
    }
    resume.hidden = !resuming;
    resumeLabel.textContent = resuming
      ? `Continuing Codex · ${state.resumeContext.sessionId.slice(0, 8)}`
      : '';
    const input = cmdbar.querySelector('.cmdbar-input');
    input.setAttribute('aria-label', resuming ? 'Prompt to continue Codex session' : 'Prompt for a new run');
    input.placeholder = resuming ? 'Continue this Codex session…' : 'Prompt for a new run…';
  }

  function renderRunRail() {
    const doc = runrail.ownerDocument || document;
    const fragment = doc.createDocumentFragment();
    for (const row of state.runs.values()) {
      const item = doc.createElement('article');
      item.className = `run-row is-${row.state}`;
      item.dataset.runId = row.runId;

      const provider = doc.createElement('span');
      provider.className = 'provider-pill run-provider';
      provider.textContent = providerLabel(row.provider);
      item.append(provider);

      const label = doc.createElement('span');
      label.className = 'run-label';
      label.textContent = row.label;
      item.append(label);

      const status = doc.createElement('span');
      status.className = 'run-status';
      status.textContent = row.state === 'running' ? 'Running' : row.ok ? 'Done' : 'Failed';
      item.append(status);

      if (row.errorMessage !== null) {
        const error = doc.createElement('span');
        error.className = 'run-error';
        error.textContent = row.errorMessage;
        item.append(error);
      }

      if (row.provider === 'codex' && row.ok === true && row.sessionId !== null) {
        const button = doc.createElement('button');
        button.className = 'run-action';
        button.type = 'button';
        button.dataset.runAction = 'continue';
        button.textContent = 'Continue';
        button.setAttribute('aria-label', `Continue ${row.label}`);
        item.append(button);
      }

      if (row.state !== 'running') {
        const dismiss = doc.createElement('button');
        dismiss.className = 'run-dismiss';
        dismiss.type = 'button';
        dismiss.dataset.runAction = 'dismiss';
        dismiss.textContent = 'Dismiss';
        dismiss.setAttribute('aria-label', `Dismiss ${row.label}`);
        item.append(dismiss);
      }

      fragment.append(item);
    }
    runrail.replaceChildren(fragment);
    runrail.hidden = state.runs.size === 0;
  }

  function render() {
    renderComposerState();
    renderRunRail();
  }

  function commit(next, { persist = false } = {}) {
    state = next;
    if (persist) persistProvider(state.selectedProvider);
    render();
  }

  function onProviderClick(ev) {
    const button = ev.target.closest('button[data-provider]');
    if (!button || button.disabled || state.resumeContext !== null) return;
    commit(reduceRunUiState(state, {
      type: 'select-provider', provider: providerId(button.dataset.provider),
    }), { persist: true });
  }

  function onResumeClick(ev) {
    const button = ev.target.closest('button[data-action="cancel-resume"]');
    if (!button) return;
    commit(reduceRunUiState(state, { type: 'cancel-resume' }));
    cmdbar.querySelector('.cmdbar-input')?.focus();
  }

  function onRunRailClick(ev) {
    const button = ev.target.closest('button[data-run-action]');
    if (!button) return;
    const item = button.closest('.run-row');
    const row = item ? state.runs.get(item.dataset.runId) : null;
    if (!row) return;
    if (button.dataset.runAction === 'dismiss') {
      commit(reduceRunRailAction(state, row.runId, 'dismiss'));
      return;
    }
    if (button.dataset.runAction === 'continue' && row.provider === 'codex' && row.sessionId) {
      commit(reduceRunRailAction(state, row.runId, 'continue'), { persist: true });
      cmdbar.hidden = false;
      cmdbar.querySelector('.cmdbar-input')?.focus();
    }
  }

  function onDeckClick(ev) {
    const button = ev.target.closest('button[data-act]');
    if (!button) return;
    const card = button.closest('.skill-card');
    if (!card) return;
    const editor = card.querySelector('.skill-edit');
    if (button.dataset.act === 'edit') {
      editor.hidden = !editor.hidden;
      return;
    }
    if (button.dataset.act === 'cancel') {
      editor.hidden = true;
      const note = card.querySelector('[data-slot="note"]');
      if (note) { note.textContent = ''; note.className = 'skill-note'; }
      return;
    }
    onSkillAction({
      button,
      card,
      editor,
      name: card.dataset.skill,
      provider: providerId(card.dataset.provider),
    });
  }

  providerSwitch.addEventListener('click', onProviderClick);
  resume.addEventListener('click', onResumeClick);
  runrail.addEventListener('click', onRunRailClick);
  deck.addEventListener('click', onDeckClick);
  render();

  return {
    getState: () => state,
    commit,
    render,
    destroy() {
      providerSwitch.removeEventListener('click', onProviderClick);
      resume.removeEventListener('click', onResumeClick);
      runrail.removeEventListener('click', onRunRailClick);
      deck.removeEventListener('click', onDeckClick);
    },
  };
}

export function createDashboardRunCoordinator({
  controls,
  now = Date.now,
  maxBuffered = 50,
  maxTracked = 50,
} = {}) {
  const buffered = new Map();
  const tracked = new Map();
  const pendingRequests = new Set();
  const bufferLimit = Math.max(1, Math.min(50, Number(maxBuffered) || 50));
  const trackedLimit = Math.max(1, Math.min(50, Number(maxTracked) || 50));
  let destroyed = false;

  function commitDone(action) {
    const current = controls.getState();
    const trackedRow = tracked.get(action.runId) ?? null;
    if (!current.runs.has(action.runId) && trackedRow === null) return null;
    const next = current.runs.has(action.runId)
      ? reduceRunUiState(current, action)
      : reconcileTrackedRunDone(current, trackedRow, action);
    tracked.delete(action.runId);
    buffered.delete(action.runId);
    controls.commit(projectTrackedRuns(next, tracked.values()));
    return controls.getState().runs.get(action.runId) ?? null;
  }

  function beginRequest() {
    if (destroyed) return null;
    const token = Symbol('dashboard-run-request');
    pendingRequests.add(token);
    return token;
  }

  function finishRequest(token) {
    if (token !== null && token !== undefined) pendingRequests.delete(token);
    if (pendingRequests.size === 0) buffered.clear();
  }

  function handleDone(payload) {
    if (destroyed) return null;
    const action = safeRunDoneAction(payload, now());
    if (action === null) return null;
    const row = commitDone(action);
    if (row !== null) return row;
    if (pendingRequests.size === 0) return null;
    buffered.delete(action.runId);
    buffered.set(action.runId, action);
    while (buffered.size > bufferLimit) buffered.delete(buffered.keys().next().value);
    return null;
  }

  function registerAcceptedRun(run, requestToken = null) {
    if (destroyed) {
      finishRequest(requestToken);
      return null;
    }
    const isolated = reduceRunUiState(createRunUiState(run?.provider), { type: 'started', run });
    const row = isolated.runs.get(run?.runId) ?? null;
    if (row === null) {
      finishRequest(requestToken);
      return null;
    }
    tracked.delete(row.runId);
    tracked.set(row.runId, row);
    while (tracked.size > trackedLimit) tracked.delete(tracked.keys().next().value);
    controls.commit(reduceRunUiState(controls.getState(), { type: 'started', run: row }));
    const early = buffered.get(row.runId);
    let result = controls.getState().runs.get(row.runId) ?? row;
    if (early) {
      buffered.delete(row.runId);
      result = commitDone(early);
    }
    finishRequest(requestToken);
    return result;
  }

  return {
    beginRequest,
    finishRequest,
    handleDone,
    registerAcceptedRun,
    getBufferedCount: () => buffered.size,
    getTrackedCount: () => tracked.size,
    destroy() {
      destroyed = true;
      buffered.clear();
      tracked.clear();
      pendingRequests.clear();
    },
  };
}

export async function sendRunRequest(request, fetchImpl = fetch) {
  try {
    const response = await fetchLocalApi('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
    }, fetchImpl);
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      return {
        ok: false,
        errorCode: safeRunError(request?.provider, body?.errorCode).errorCode,
      };
    }
    if (typeof body?.runId !== 'string' || body.runId.length === 0) {
      return { ok: false, errorCode: 'run-failed' };
    }
    return {
      ok: true,
      runId: body.runId,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    };
  } catch {
    return { ok: false, errorCode: 'run-failed' };
  }
}

export function skillCardMarkup(s) {
  const name = String(s?.name ?? '');
  const provider = providerId(s?.provider);
  const description = literal(s?.description);
  const hint = literal(s?.argumentHint ?? s?.argumentsHint ?? s?.argument_hint);

  return `
      <article class="skill-card" data-provider="${provider}" data-skill="${esc(name)}">
        <span class="provider-tick" aria-hidden="true"></span>
        <span class="skill-card-head">
          <span class="skill-glyph">${icon('terminal', { size: 16 })}</span>
          <span class="provider-label">${providerLabel(provider)}</span>
        </span>
        <span class="skill-name" title="${esc(s?.description || name)}">/${esc(name)}</span>
        ${description ? `<span class="skill-description">${esc(description)}</span>` : ''}
        ${hint ? `<span class="skill-hint">${esc(hint)}</span>` : ''}
      </article>`;
}

// ---------------------------------------------------------------------------
// geodesic wireframe — a real subdivided icosahedron, orthographically projected
// ---------------------------------------------------------------------------

function geodesicMarkup() {
  const t = (1 + Math.sqrt(5)) / 2;
  const norm = (v) => {
    const m = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / m, v[1] / m, v[2] / m];
  };
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(norm);
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  const cache = new Map();
  const mid = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (cache.has(key)) return cache.get(key);
    const v = norm([
      (verts[a][0] + verts[b][0]) / 2,
      (verts[a][1] + verts[b][1]) / 2,
      (verts[a][2] + verts[b][2]) / 2,
    ]);
    verts.push(v);
    cache.set(key, verts.length - 1);
    return verts.length - 1;
  };

  const sub = [];
  for (const [a, b, c] of faces) {
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    sub.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }

  const edges = new Set();
  for (const f of sub) {
    for (let i = 0; i < 3; i += 1) {
      const a = f[i], b = f[(i + 1) % 3];
      edges.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
  }

  // tilt so the pole is off-axis — a straight-on sphere reads as a flat target
  const rx = -0.42, ry = 0.55;
  const project = (v) => {
    const x1 = v[0] * Math.cos(ry) + v[2] * Math.sin(ry);
    const z1 = -v[0] * Math.sin(ry) + v[2] * Math.cos(ry);
    const y2 = v[1] * Math.cos(rx) - z1 * Math.sin(rx);
    const z2 = v[1] * Math.sin(rx) + z1 * Math.cos(rx);
    return [x1, -y2, z2];
  };
  const p = verts.map(project);

  let out = '<circle class="geo-edge" cx="0" cy="0" r="1" opacity=".5"' +
    ' vector-effect="non-scaling-stroke" stroke-width="1"/>';
  for (const key of edges) {
    const [a, b] = key.split('_').map(Number);
    const depth = (p[a][2] + p[b][2]) / 2;             // -1 back .. +1 front
    const op = (0.16 + 0.84 * ((depth + 1) / 2)).toFixed(2);
    out += `<line class="geo-edge" x1="${p[a][0].toFixed(4)}" y1="${p[a][1].toFixed(4)}"` +
      ` x2="${p[b][0].toFixed(4)}" y2="${p[b][1].toFixed(4)}" opacity="${op}"` +
      ' vector-effect="non-scaling-stroke" stroke-width="1"/>';
  }
  return `<svg class="geo" viewBox="-1.08 -1.08 2.16 2.16" aria-hidden="true">${out}</svg>`;
}

function dotsMarkup(count = 54) {
  const rnd = mulberry32(0x8f21);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const cx = (rnd() * 100).toFixed(2);
    const cy = (rnd() * 100).toFixed(2);
    const op = (0.25 + rnd() * 0.55).toFixed(2);
    out += `<circle class="dot" cx="${cx}%" cy="${cy}%" r="1" opacity="${op}"/>`;
  }
  return `<svg class="stage-dots" aria-hidden="true">${out}</svg>`;
}

// ---------------------------------------------------------------------------
// ring geometry — a measured, full-circle operational orbit.  The central
// reactor is reserved as an exclusion zone; nodes use the outer available
// radius, reducing their size only when the stage cannot fit their spacing.
// ---------------------------------------------------------------------------

export function planOrbit(n, width, height) {
  const shown = Math.min(Math.max(0, n), 28);
  const desiredSize = n <= 6 ? 58 : n <= 12 ? 50 : n <= 20 ? 44 : 38;
  const minSize = n > 20 ? 28 : n > 12 ? 32 : n > 6 ? 36 : 42;
  const shortSide = Math.max(0, Math.min(Number(width) || 0, Number(height) || 0));
  const edgePadding = 16;
  const reactorRadius = Number(width) <= 640 ? 54 : 66;
  const reactorGap = 10;
  const nodeGap = shown > 20 ? 5 : 8;
  let size = desiredSize;
  let radius = 0;

  for (let candidate = desiredSize; candidate >= minSize; candidate -= 1) {
    const available = Math.max(0, shortSide / 2 - edgePadding - candidate / 2);
    const reactorClearance = reactorRadius + reactorGap + candidate / 2;
    const circumferenceClearance = shown > 1 ? (shown * (candidate + nodeGap)) / (Math.PI * 2) : 0;
    if (available >= Math.max(reactorClearance, circumferenceClearance)) {
      size = candidate;
      radius = available;
      break;
    }
  }
  if (radius === 0) {
    size = minSize;
    radius = Math.max(0, shortSide / 2 - edgePadding - size / 2);
  }

  const slots = [];
  for (let position = 0; position < shown; position += 1) {
    slots.push({ r: radius, a: (position * Math.PI * 2) / shown });
  }
  const extent = radius + size / 2 + edgePadding;
  return {
    size, slots, overflow: Math.max(0, n - shown), reactorRadius, extent,
  };
}

export function stageRoutesMarkup(slots, nodeSize, extent = null, reactorRadius = 66) {
  const rows = Array.isArray(slots) ? slots : [];
  const outer = Number.isFinite(extent) ? extent : rows.reduce((max, slot) => (
    Math.max(max, Number(slot?.r) || 0)
  ), 0) + Number(nodeSize || 0) / 2 + 16;
  const portRadius = Math.max(Number(reactorRadius) || 0, Number(nodeSize) * 0.8) + 9;
  const routes = rows.map((slot, index) => {
    const x = Math.sin(slot.a) * slot.r;
    const y = -Math.cos(slot.a) * slot.r;
    const portAngle = slot.a + ((index % 3) - 1) * 0.07;
    const sx = Math.sin(portAngle) * portRadius;
    const sy = -Math.cos(portAngle) * portRadius;
    const elbowY = sy + (y - sy) * 0.42;
    const points = `${sx.toFixed(1)},${sy.toFixed(1)} ${sx.toFixed(1)},${elbowY.toFixed(1)} ${x.toFixed(1)},${elbowY.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
    return `<polyline class="stage-route" data-route-index="${index}" points="${points}"/>`;
  }).join('');
  return `<svg class="stage-routes" viewBox="-${outer.toFixed(1)} -${outer.toFixed(1)} ${(outer * 2).toFixed(1)} ${(outer * 2).toFixed(1)}" aria-hidden="true">${routes}</svg>`;
}

function panelHeadMarkup({ glyph, title, meta = '', metaSlot = null }) {
  const slot = metaSlot ? ` data-slot="${esc(metaSlot)}"` : '';
  return `<header class="panel-head instrument-head">
    <span class="panel-glyph">${icon(glyph, { size: 15 })}</span>
    <span class="panel-title label">${esc(title)}</span>
    <span class="signal-rail" aria-hidden="true"></span>
    <span class="panel-meta"${slot}>${meta}</span>
  </header>`;
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

export function dashboardShellMarkup() {
  const appsHead = panelHeadMarkup({ glyph: 'grid', title: 'ความสามารถที่เชื่อมต่อ', metaSlot: 'apps-meta' });
  const calendarHead = panelHeadMarkup({ glyph: 'calendar', title: 'เวลาในเครื่อง', metaSlot: 'cal-meta' });
  const emailHead = panelHeadMarkup({ glyph: 'mail', title: 'อีเมล', meta: DASH });
  const deckHead = panelHeadMarkup({ glyph: 'star-4', title: 'คู่มือที่ใช้ได้', metaSlot: 'deck-meta' });
  const routinesHead = panelHeadMarkup({ glyph: 'clock', title: 'งานอัตโนมัติ', metaSlot: 'rt-meta' });
  return `
    <aside class="col col-l">
      <section class="panel panel-grow" data-panel="apps">
        ${appsHead}
        <div class="panel-body" data-slot="apps"></div>
      </section>

      <section class="panel panel-fix" data-panel="calendar">
        ${calendarHead}
        <div class="panel-body" data-slot="calendar"></div>
      </section>
    </aside>

    <main class="stage">
      <header class="stage-head">
        <h1 class="wordmark">
          <span class="wordmark-a">BIGNOSE</span>
          <span class="wordmark-b">OS</span>
        </h1>
        <p class="subline">เฉพาะไฟล์ในเครื่อง · ไม่ต้องใช้คีย์ API</p>
        <p class="subline">ตัวดูโครงสร้าง · .claude + .codex</p>
        <span class="stage-signal-rail" aria-hidden="true"></span>
        <div class="stage-tools">
          <button class="btn-icon" type="button" data-tool="search" title="ค้นหา Second Brain" aria-label="ค้นหา Second Brain">${icon('search', { size: 14 })}</button>
          <button class="btn-icon" type="button" data-tool="graph" title="กราฟ Second Brain" aria-label="กราฟ Second Brain">${icon('grid', { size: 14 })}</button>
          <button class="btn-icon" type="button" data-tool="info" title="ข้อมูลระบบ" aria-label="ข้อมูลระบบ" aria-expanded="false">${icon('info', { size: 14 })}</button>
        </div>
        <div class="info-pop" data-slot="info" hidden></div>
      </header>

      <div class="operator-status" data-slot="operator-status" role="status"></div>
      <section class="operator-brief" data-slot="operator-brief" aria-label="สรุปสถานการณ์ปัจจุบัน"></section>
      <div class="pulse-rail" data-slot="pulse" aria-hidden="true"></div>
      <div class="stage-body" data-slot="stage"></div>
      <aside class="operator-inspector" data-slot="inspector" aria-label="รายละเอียดสัญญาณ" hidden></aside>
      <div data-slot="needs"></div>

      <button class="stage-cta" type="button" data-action="brain">
        ดูโครงสร้างในเครื่องใน Second Brain
        ${icon('chevron', { size: 14 })}
      </button>
    </main>

    <aside class="col col-r">
      <section class="panel panel-fix" data-panel="email">
        ${emailHead}
        <div class="panel-body" data-slot="email"></div>
      </section>

      <section class="panel panel-grow" data-panel="deck">
        ${deckHead}
        <div class="panel-body" data-slot="deck"></div>
      </section>

      <section class="panel panel-fix" data-panel="routines">
        ${routinesHead}
        <div class="panel-body" data-slot="routines"></div>
      </section>
    </aside>
    <svg class="signal-trace-layer" data-slot="trace" aria-hidden="true"><polyline/></svg>`;
}

/**
 * @param {HTMLElement} rootEl
 * @returns {{destroy: () => void}}
 */
export function mountDashboard(rootEl) {
  const unsubs = [];
  const timers = [];
  const controllers = new Set();
  let disposed = false;
  let ro = null;

  let storedProvider = 'claude';
  try {
    const value = globalThis.localStorage?.getItem(PROVIDER_STORAGE_KEY);
    if (value === 'claude' || value === 'codex') storedProvider = value;
  } catch { /* storage can be unavailable in private or locked-down contexts */ }
  const initialRunUiState = createRunUiState(storedProvider);

  const model = {
    jobs: [],
    catalog: normalizeDashboardCatalog(null),
    hello: null,
    loading: { jobs: true, catalog: true },
    failed: { jobs: false, catalog: false },
  };
  const operatorUi = {
    inspectorOpen: false, selectedJobId: null, selectedTaskId: null,
    signalInspector: false, traceActive: false, returnFocus: null,
    focusRevision: 0, focusIntent: null, traceDrawPending: false,
  };

  // -- shell ---------------------------------------------------------------
  rootEl.innerHTML = dashboardShellMarkup();

  const slot = (name) => rootEl.querySelector(`[data-slot="${name}"]`);
  const els = {
    apps: slot('apps'), appsMeta: slot('apps-meta'),
    calendar: slot('calendar'), calMeta: slot('cal-meta'),
    stage: slot('stage'), needs: slot('needs'), operatorStatus: slot('operator-status'),
    brief: slot('operator-brief'), inspector: slot('inspector'), trace: slot('trace'),
    pulse: slot('pulse'), info: slot('info'),
    cmdbar: slot('cmdbar'), cmdstate: slot('cmdstate'),
    providerSwitch: slot('provider-switch'), resume: slot('resume'),
    resumeLabel: slot('resume-label'), runrail: slot('runrail'),
    email: slot('email'),
    deck: slot('deck'), deckMeta: slot('deck-meta'),
    routines: slot('routines'), rtMeta: slot('rt-meta'),
  };

  const controls = mountDashboardControls({
    elements: els,
    initialState: initialRunUiState,
    persistProvider(provider) {
      try { globalThis.localStorage?.setItem(PROVIDER_STORAGE_KEY, provider); }
      catch { /* provider preference is optional */ }
    },
    onSkillAction: handleSkillAction,
  });
  const runCoordinator = createDashboardRunCoordinator({ controls });

  async function launchRun({ prompt, provider, skillName = null, label, resumeSessionId = null }) {
    const request = skillName !== null && resumeSessionId === null
      ? buildCatalogSkillRunRequest(model.catalog, {
        prompt, provider, name: skillName,
      })
      : buildRunRequest({ prompt, provider, resumeSessionId });
    const requestToken = runCoordinator.beginRequest();
    const response = await sendRunRequest(request);
    if (disposed) {
      runCoordinator.finishRequest(requestToken);
      return null;
    }
    const now = Date.now();
    if (!response.ok) {
      runCoordinator.finishRequest(requestToken);
      const requestId = `request:${globalThis.crypto.randomUUID()}`;
      controls.commit(reduceRunUiState(controls.getState(), {
        type: 'request-failed',
        runId: requestId,
        provider: request.provider,
        skillName,
        label,
        at: now,
        errorCode: response.errorCode,
      }));
      return controls.getState().runs.get(requestId) ?? null;
    }
    return runCoordinator.registerAcceptedRun({
      runId: response.runId,
      provider: request.provider,
      skillName,
      label,
      state: 'running',
      ok: null,
      sessionId: null,
      startedAt: now,
      endedAt: null,
      errorCode: null,
      errorMessage: null,
    }, requestToken);
  }

  // =========================================================================
  // CALENDAR — entirely live, from this machine's clock
  // =========================================================================

  const localZone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch { return 'UTC'; }
  })();

  const zoneList = (() => {
    const pool = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
    const picked = [localZone];
    for (const z of pool) {
      if (picked.length >= 3) break;
      if (z !== localZone) picked.push(z);
    }
    return picked.map((tz) => {
      let fmt = null;
      try {
        fmt = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
        });
      } catch { fmt = null; }
      const leaf = tz.split('/').pop().replace(/_/g, ' ');
      return { tz, fmt, label: leaf, here: tz === localZone };
    });
  })();

  els.calendar.innerHTML = `
    <div class="cal-top">
      <svg class="cal-dial" width="62" height="62" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor"
                stroke-width="1" vector-effect="non-scaling-stroke"/>
        <circle cx="50" cy="50" r="1.6" fill="currentColor" stroke="none"/>
        <line data-hand="h" x1="50" y1="50" x2="50" y2="26" stroke="currentColor"
              stroke-width="1" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        <line data-hand="m" x1="50" y1="50" x2="50" y2="12" stroke="currentColor"
              stroke-width="1" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="cal-when">
        <span class="cal-wk" data-slot="wk"></span>
        <span class="cal-date tnum" data-slot="date"></span>
      </div>
    </div>
    <div class="cal-time">
      <span class="cal-time-num tnum" data-slot="time"></span>
      <span class="cal-ampm" data-slot="ampm"></span>
    </div>
    <div class="cal-zones">
      ${zoneList.map((z) => `
        <div class="zone${z.here ? ' zone-here' : ''}">
          <span class="zone-name">${esc(z.label)}</span>
          <span class="zone-time tnum" data-zone="${esc(z.tz)}">${DASH}</span>
        </div>`).join('')}
    </div>
    <div class="cal-quarters" data-slot="quarters"></div>`;

  const cal = {
    wk: els.calendar.querySelector('[data-slot="wk"]'),
    date: els.calendar.querySelector('[data-slot="date"]'),
    time: els.calendar.querySelector('[data-slot="time"]'),
    ampm: els.calendar.querySelector('[data-slot="ampm"]'),
    quarters: els.calendar.querySelector('[data-slot="quarters"]'),
    hourHand: els.calendar.querySelector('[data-hand="h"]'),
    minHand: els.calendar.querySelector('[data-hand="m"]'),
  };

  let lastWeekKey = '';

  function renderQuarters(now) {
    const { week, year } = isoWeek(now);
    const total = isoWeeksInYear(year);
    const rows = [13, 13, 13, total - 39];
    let idx = 1;
    let html = '';
    for (let q = 0; q < 4; q += 1) {
      let cells = '';
      for (let i = 0; i < rows[q]; i += 1, idx += 1) {
        const cls = idx < week ? ' is-past' : idx === week ? ' is-now' : '';
        cells += `<span class="q-cell${cls}"></span>`;
      }
      html += `<div class="q-row"><span class="q-label">ไตรมาส ${q + 1}</span>` +
        `<span class="q-cells">${cells}</span></div>`;
    }
    cal.quarters.innerHTML = html;
    els.calMeta.textContent = `สัปดาห์ ${week} / ${total} · ${year}`;
  }

  function tick() {
    const now = new Date();
    const h24 = now.getHours();
    const h12 = h24 % 12 || 12;
    const pad = (n) => String(n).padStart(2, '0');

    cal.time.textContent = `${pad(h12)}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    cal.ampm.textContent = h24 < 12 ? 'ก่อนเที่ยง' : 'หลังเที่ยง';

    const { week, year } = isoWeek(now);
    cal.wk.textContent = `สัปดาห์ ${week}`;
    cal.date.textContent =
      `${MONTHS[now.getMonth()]} ${now.getDate()} ${now.getFullYear()} (${DAYS[now.getDay()]})`;

    const mAngle = now.getMinutes() * 6 + now.getSeconds() * 0.1;
    const hAngle = (h24 % 12) * 30 + now.getMinutes() * 0.5;
    cal.minHand.setAttribute('transform', `rotate(${mAngle.toFixed(2)} 50 50)`);
    cal.hourHand.setAttribute('transform', `rotate(${hAngle.toFixed(2)} 50 50)`);

    for (const z of zoneList) {
      const node = els.calendar.querySelector(`[data-zone="${CSS.escape(z.tz)}"]`);
      if (node) node.textContent = z.fmt ? z.fmt.format(now) : DASH;
    }

    const key = `${year}-${week}`;
    if (key !== lastWeekKey) {
      lastWeekKey = key;
      renderQuarters(now);
    }
  }

  tick();
  timers.push(setInterval(tick, 1000));

  // =========================================================================
  // EMAIL — full treatment, zero invented data
  // =========================================================================

  function renderEmail() {
    els.email.innerHTML = `<p class="empty">ยังไม่ได้เชื่อมต่อแหล่งอีเมล</p>`;
  }
  renderEmail();

  // =========================================================================
  // APPLICATIONS — provider-aware catalog projection with legacy MCP fallback.
  // =========================================================================

  function renderApps() {
    const applications = applicationViewModel(model.catalog);
    els.appsMeta.textContent = applications.length ? String(applications.length) : '';
    if (!applications.length) {
      els.apps.innerHTML = model.loading.catalog ? '<p class="empty">กำลังอ่านข้อมูล…</p>'
        : model.failed.catalog ? '<p class="empty">อ่านข้อมูลความสามารถไม่สำเร็จ</p>'
          : '<p class="empty">ยังไม่พบความสามารถที่รายงาน</p>';
      return;
    }
    const stale = model.failed.catalog ? '<p class="empty" data-state="stale">ข้อมูลที่แสดงเป็นข้อมูลล่าสุดที่อ่านได้</p>' : '';
    els.apps.innerHTML = `${stale}<ul class="apps-list">${applications.map((application) => `
      <li class="app-row" data-provider="${providerId(application?.provider)}">
        <span class="provider-tick" aria-hidden="true"></span>
        <span class="app-glyph">${icon('hexagon', { size: 14 })}</span>
        <span class="app-name" title="${esc(application?.name)}">${esc(application?.name)}</span>
        <span class="provider-label">${providerLabel(application?.provider)}</span>
        <span class="app-tag">${application?.kind === 'plugin' ? 'ปลั๊กอิน' : 'MCP'}</span>
      </li>`).join('')}</ul>`;
  }

  // =========================================================================
  // STAGE — the ring comes from jobs.flatMap(j => j.fan)
  // =========================================================================

  const GEO = geodesicMarkup();
  const DOTS = dotsMarkup();

  function stageItems() {
    const items = [];
    for (const job of model.jobs) {
      const fan = Array.isArray(job?.fan) ? job.fan : [];
      let liveMarked = false;
      const wants = job?.state === 'blocked' || job?.state === 'working' || job?.state === 'running';
      for (const f of fan) {
        const done = Number(f?.doneAt) > 0;
        // Exactly one node per attention-state job is lit: its next open item.
        // The accent marks the live thing — a whole arc of orange would not.
        const live = wants && !done && !liveMarked;
        if (live) liveMarked = true;
        items.push({
          jobId: literal(job?.id),
          id: literal(f?.id),
          kind: String(f?.kind ?? ''),
          label: String(f?.label ?? ''),
          ageDays: Number(f?.ageDays) || 0,
          done,
          live,
        });
      }
    }
    return items;
  }

  function renderStage() {
    const items = stageItems();
    const rect = els.stage.getBoundingClientRect();
    const w = Math.max(320, rect.width || 820);
    const h = Math.max(280, rect.height || 520);

    const plan = planOrbit(items.length, w, h);

    let nodes = '';
    for (let i = 0; i < plan.slots.length; i += 1) {
      const s = plan.slots[i];
      const style = `--a:${s.a.toFixed(4)}rad;--r:${s.r.toFixed(1)}px;--i:${i}`;
      const it = items[i];
      const cls = it.live ? ' is-live' : it.done ? ' is-done' : '';
      // DESIGN.md: badge shows age. ageDays === 0 means "started today / not
      // started" — a ring of "0D" badges would be a lie about staleness, so
      // no badge is rendered at all and none is reserved.
      const badge = it.ageDays > 0
        ? `<span class="node-badge tnum">${it.ageDays}D</span>` : '';
      const glyph = KIND_GLYPH[it.kind] || 'diamond';
      nodes += `<button class="node${cls}${operatorUi.selectedJobId === it.jobId && operatorUi.selectedTaskId === it.id ? ' is-selected' : ''}" type="button" data-job-id="${esc(it.jobId)}" data-task-id="${esc(it.id)}" style="${style}" aria-label="${esc(it.label || it.kind || it.id)}">` +
        `<span class="node-dial">${icon(glyph, { size: Math.round(plan.size * 0.4) })}</span>` +
        `${badge}</button>`;
    }

    const overflowReadout = plan.overflow > 0
      ? `<p class="ring-overflow-readout">+${plan.overflow} งานเพิ่มเติม</p>` : '';

    const geoSize = Math.ceil(plan.extent * 2);
    const reactor = deriveReactorState(model, connectionState());
    const sectors = [['system', 'ระบบ'], ['work', 'งาน'], ['automation', 'อัตโนมัติ']]
      .map(([key, title]) => `<span class="reactor-sector" data-sector="${key}" data-state="${esc(reactor[key].state)}"><b>${title}</b><small>${esc(reactor[key].label)}</small></span>`).join('');
    const selected = items.find((item) => item.jobId === operatorUi.selectedJobId && item.id === operatorUi.selectedTaskId);
    els.stage.innerHTML = `
      ${DOTS}
      <div class="bignose-reactor" aria-label="สถานะระบบ งาน และงานอัตโนมัติ">
        <span class="reactor-core" aria-hidden="true"></span>${sectors}
      </div>
      <div class="ring-field" style="width:${geoSize}px;height:${geoSize}px">${stageRoutesMarkup(plan.slots, plan.size, plan.extent, plan.reactorRadius)}${GEO}</div>
      <div class="ring" style="--node-size:${plan.size}px">${nodes}</div>
      ${overflowReadout}
      <p class="orbit-current-label" data-slot="orbit-label">${esc(selected?.label || 'เลือกโหนดเพื่อดูรายละเอียดงาน')}</p>`;

    // the job's real `needs` string — genuine "this wants something from you"
    const needy = model.jobs.find((j) => typeof j?.needs === 'string' && j.needs.trim());
    els.needs.innerHTML = needy ? `
      <div class="needs-rail">
        <span class="needs-glyph">${icon('bolt', { size: 14 })}</span>
        <span class="needs-label label">ต้องการจากคุณ</span>
        <span class="needs-text" title="${esc(needy.needs)}">${esc(needy.needs)}</span>
      </div>` : '';
  }

  function connectionLabel(conn) {
    return conn === 'open' ? 'เชื่อมต่อสด' : conn === 'connecting' ? 'กำลังเชื่อมต่อ'
      : conn === 'closed' || conn === 'error' ? 'ขาดการเชื่อมต่อ' : 'ไม่ทราบการเชื่อมต่อ';
  }

  function renderOperatorStatus() {
    const conn = connectionState();
    const label = connectionLabel(conn);
    const stale = [
      model.failed.jobs && 'ข้อมูลงานล่าสุดอาจไม่ใหม่',
      model.failed.catalog && 'ข้อมูลความสามารถล่าสุดอาจไม่ใหม่',
    ].filter(Boolean);
    els.operatorStatus.innerHTML = `<span>ในเครื่อง</span><span aria-hidden="true">•</span>
      <strong>โหมดดูอย่างเดียว</strong><span aria-hidden="true">•</span>
      <span>Claude + Codex</span><span aria-hidden="true">•</span>
      <span data-state="${esc(conn)}">${label}</span>
      ${stale.map((message) => `<span data-state="stale">${esc(message)}</span>`).join('')}`;
  }

  function renderOperatorBrief(signal = deriveOperatorSignal(model, connectionState(), Date.now())) {
    els.brief.innerHTML = `<button class="next-signal" type="button" data-signal-action="open" data-signal-kind="${esc(signal.kind)}">
      <span class="next-signal-kicker">สัญญาณถัดไป</span>
      <span class="next-signal-title"><small>${esc(signal.state)}</small>${esc(signal.title)}</span>
      <span class="brief-line"><b>ตอนนี้</b><span>${esc(signal.current)}</span></span>
      <span class="brief-line"><b>สำคัญเพราะ</b><span>${esc(signal.why)}</span></span>
      <span class="brief-line"><b>ทำต่อได้</b><span>${esc(signal.next)}</span></span>
    </button>`;
  }

  function inspectorMarkup(view) {
    const rows = [
      view.job.state && ['สถานะ', view.job.state], view.job.detail && ['ตอนนี้', view.job.detail],
      view.job.needs && ['ต้องการจากคุณ', view.job.needs], view.job.suggestedReply && ['คำตอบที่แนะนำ', view.job.suggestedReply],
      view.job.cwd && ['ตำแหน่งงาน', view.job.cwd],
    ].filter(Boolean).map(([label, value]) => `<div class="inspector-field"><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('');
    const task = view.task ? `<section class="inspector-task" aria-label="งานย่อยที่เลือก"><p>${esc(view.task.label || view.task.id)}</p><span>${esc(view.task.kind || 'งานย่อย')} · ${esc(view.task.state)}</span>${view.task.ageDays > 0 ? `<span>${view.task.ageDays} วัน</span>` : ''}</section>` : '';
    const timeline = view.timeline.length ? `<section class="inspector-timeline" aria-label="ความเคลื่อนไหวล่าสุด"><h3>ความเคลื่อนไหวล่าสุด</h3><ol>${view.timeline.map((entry) => `<li>${entry.at ? `<time>${esc(entry.at)}</time>` : ''}<span>${esc([entry.state, entry.detail, entry.text].filter(Boolean).join(' · '))}</span></li>`).join('')}</ol></section>` : '';
    const copies = [
      view.copy.suggestedReply && ['suggestedReply', 'คัดลอกคำตอบที่แนะนำ'],
      view.copy.context && ['context', 'คัดลอกบริบทงาน'],
      view.copy.cwd && ['cwd', 'คัดลอกตำแหน่งงาน'],
    ].filter(Boolean).map(([field, label]) => `<button type="button" data-copy-field="${field}">${label}</button>`).join('');
    return `<header class="inspector-head"><div><span class="label">รายละเอียดสัญญาณ</span><h2 tabindex="-1" data-inspector-heading>${esc(view.heading)}</h2></div><button type="button" data-inspector-action="close" aria-label="ปิดรายละเอียด">${icon('x', { size: 16 })}</button></header>
      <p class="inspector-count">ทั้งหมด ${view.counts.total} · เปิด ${view.counts.open} · เสร็จ ${view.counts.done}</p>${task}<dl>${rows}</dl>${timeline}${copies ? `<div class="inspector-actions" aria-live="polite">${copies}</div>` : ''}`;
  }

  function signalInspectorMarkup(signal) {
    return `<header class="inspector-head"><div><span class="label">รายละเอียดสัญญาณ</span><h2 tabindex="-1" data-inspector-heading>${esc(signal.title)}</h2></div><button type="button" data-inspector-action="close" aria-label="ปิดรายละเอียด">${icon('x', { size: 16 })}</button></header>
      <dl><div class="inspector-field"><dt>สถานะ</dt><dd>${esc(signal.state)}</dd></div>
      <div class="inspector-field"><dt>ตอนนี้</dt><dd>${esc(signal.current)}</dd></div>
      <div class="inspector-field"><dt>สำคัญเพราะ</dt><dd>${esc(signal.why)}</dd></div>
      <div class="inspector-field"><dt>ทำต่อได้</dt><dd>${esc(signal.next)}</dd></div></dl>`;
  }

  function clearInspectorState() {
    operatorUi.inspectorOpen = false;
    operatorUi.selectedJobId = null;
    operatorUi.selectedTaskId = null;
    operatorUi.signalInspector = false;
    operatorUi.traceActive = false;
    operatorUi.traceDrawPending = false;
    operatorUi.returnFocus = null;
  }

  function reconcileInspectorSelection() {
    if (!operatorUi.inspectorOpen || operatorUi.signalInspector) return;
    const job = model.jobs.find((item) => literal(item?.id) === operatorUi.selectedJobId) ?? null;
    const selectedTaskIsGone = operatorUi.selectedTaskId !== null
      && (!job || !Array.isArray(job.fan) || !job.fan.some((task) => literal(task?.id) === operatorUi.selectedTaskId));
    if (!job || selectedTaskIsGone) clearInspectorState();
  }

  function renderInspector() {
    if (!operatorUi.inspectorOpen) { els.inspector.hidden = true; els.inspector.innerHTML = ''; return; }
    if (operatorUi.signalInspector) {
      els.inspector.hidden = false;
      els.inspector.innerHTML = signalInspectorMarkup(deriveOperatorSignal(model, connectionState(), Date.now()));
      return;
    }
    const job = model.jobs.find((item) => literal(item?.id) === operatorUi.selectedJobId) ?? null;
    const view = deriveJobInspector(job, operatorUi.selectedTaskId);
    if (!view) { clearInspectorState(); els.inspector.hidden = true; els.inspector.innerHTML = ''; return; }
    els.inspector.hidden = false;
    els.inspector.innerHTML = inspectorMarkup(view);
  }

  function updateOrbitLabel(label) {
    const target = els.stage.querySelector('[data-slot="orbit-label"]');
    if (target) target.textContent = label || 'เลือกโหนดเพื่อดูรายละเอียดงาน';
  }

  function openInspector(jobId, taskId = null, { focusHeading = false, returnFocus = null } = {}) {
    const job = model.jobs.find((item) => literal(item?.id) === literal(jobId));
    if (!job) return;
    const focusRevision = beginExplicitFocus(focusHeading ? { kind: 'inspector-heading' } : null);
    operatorUi.inspectorOpen = true;
    operatorUi.selectedJobId = literal(jobId);
    operatorUi.selectedTaskId = Array.isArray(job.fan) && job.fan.some((task) => literal(task?.id) === literal(taskId)) ? literal(taskId) : null;
    operatorUi.signalInspector = false;
    operatorUi.returnFocus = returnFocus;
    renderStage(); renderInspector(); scheduleTrace();
    if (focusHeading) queueExplicitFocus({ kind: 'inspector-heading' }, focusRevision);
  }

  function openSignalInspector({ focusHeading = false, returnFocus = null } = {}) {
    const focusRevision = beginExplicitFocus(focusHeading ? { kind: 'inspector-heading' } : null);
    operatorUi.inspectorOpen = true;
    operatorUi.selectedJobId = null;
    operatorUi.selectedTaskId = null;
    operatorUi.signalInspector = true;
    operatorUi.returnFocus = returnFocus;
    renderStage(); renderInspector(); scheduleTrace();
    if (focusHeading) queueExplicitFocus({ kind: 'inspector-heading' }, focusRevision);
  }

  function closeInspector() {
    const ref = operatorUi.returnFocus;
    const focusRevision = beginExplicitFocus(ref ?? null);
    clearInspectorState();
    renderStage(); renderInspector(); scheduleTrace();
    queueExplicitFocus(ref, focusRevision);
  }

  async function copyInspectorField(field, button) {
    const job = model.jobs.find((item) => literal(item?.id) === operatorUi.selectedJobId);
    const value = deriveJobInspector(job, operatorUi.selectedTaskId)?.copy?.[field] ?? '';
    if (!value) return;
    try { await navigator.clipboard.writeText(value); button.textContent = 'คัดลอกแล้ว'; }
    catch { button.textContent = 'คัดลอกไม่สำเร็จ'; }
  }

  function onOperatorInteraction(event) {
    const close = event.target.closest('[data-inspector-action="close"]');
    if (close) return closeInspector();
    const copy = event.target.closest('button[data-copy-field]');
    if (copy) return void copyInspectorField(copy.dataset.copyField, copy);
    const signal = event.target.closest('[data-signal-action="open"]');
    if (signal) {
      const current = deriveOperatorSignal(model, connectionState(), Date.now());
      operatorUi.traceActive = true;
      operatorUi.traceDrawPending = true;
      if (current.jobId) openInspector(current.jobId, current.taskId, { focusHeading: event.detail === 0, returnFocus: { kind: 'signal' } });
      else openSignalInspector({ focusHeading: event.detail === 0, returnFocus: { kind: 'signal' } });
      scheduleTrace(); return;
    }
    const task = event.target.closest('button[data-task-id][data-job-id]');
    if (task) openInspector(task.dataset.jobId, task.dataset.taskId, { focusHeading: event.detail === 0, returnFocus: { kind: 'task', jobId: task.dataset.jobId, taskId: task.dataset.taskId } });
  }

  // =========================================================================
  // SKILLS DECK
  // =========================================================================

  function renderDeck() {
    const skills = Array.isArray(model.catalog.skills) ? model.catalog.skills : [];
    els.deckMeta.textContent = skills.length ? String(skills.length) : '';
    if (!skills.length) {
      els.deck.innerHTML = model.loading.catalog ? '<p class="empty">กำลังอ่านข้อมูล…</p>'
        : model.failed.catalog ? '<p class="empty">อ่านข้อมูลคู่มือไม่สำเร็จ</p>'
          : '<p class="empty">ยังไม่พบคู่มือที่รายงาน</p>';
      return;
    }
    // A 2-across deck; the panel scrolls past the first 2x2 rather than
    // dumping all 68 cards into the viewport at once.
    const stale = model.failed.catalog ? '<p class="empty" data-state="stale">ข้อมูลที่แสดงเป็นข้อมูลล่าสุดที่อ่านได้</p>' : '';
    els.deck.innerHTML = `${stale}<div class="deck">${skills.map(skillCardMarkup).join('')}</div>`;
    for (const row of controls.getState().runs.values()) {
      if (row.state !== 'running' || row.skillName === null) continue;
      const card = els.deck.querySelector(skillCardSelector(row.provider, row.skillName));
      if (card) { card.classList.add('is-running'); note(card, 'Running', 'is-live'); }
    }
  }

  function note(card, text, cls) {
    const n = card.querySelector('[data-slot="note"]');
    if (!n) return;
    n.textContent = text;
    n.className = `skill-note${cls ? ` ${cls}` : ''}`;
  }

  function presentSkillRun(card, row) {
    const target = card.querySelector('[data-slot="note"]');
    const presentation = presentRunLaunch(target, row, 'skill-note');
    card.classList.remove('is-running');
    if (presentation?.running) card.classList.add('is-running');
  }

  async function handleSkillAction({ button, card, editor, name, provider }) {
    if (button.dataset.act === 'save') {
      const get = (f) => card.querySelector(`[data-field="${f}"]`).value || null;
      note(card, 'Saving…');
      const updated = await sendJSON(
        'PATCH',
        `/api/catalog/skill/${encodeURIComponent(name)}?provider=${encodeURIComponent(provider)}`,
        { model: get('model'), effort: get('effort') },
      );
      if (disposed) return;
      if (!updated) {
        note(card, 'Save failed', 'is-bad');
        return;
      }
      const list = model.catalog.skills;
      const key = skillKey(provider, name);
      const i = list.findIndex((s) => skillKey(s?.provider, s?.name) === key);
      if (i >= 0) list[i] = { ...list[i], ...updated };
      renderDeck();
      return;
    }
    if (button.dataset.act === 'run') {
      controls.commit(reduceRunUiState(
        reduceRunUiState(controls.getState(), { type: 'cancel-resume' }),
        { type: 'select-provider', provider },
      ), { persist: true });
      note(card, 'Starting…');
      const row = await launchRun({
        prompt: `/${name}`,
        provider,
        skillName: name,
        label: `${providerLabel(provider)} /${name}`,
      });
      if (!row) return;
      presentSkillRun(card, row);
    }
  }

  // =========================================================================
  // ROUTINES
  // =========================================================================

  function hhmm(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DASH;
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function renderRoutines() {
    const list = Array.isArray(model.catalog.routines) ? model.catalog.routines : [];
    els.rtMeta.textContent = list.length ? String(list.length) : '';
    if (!list.length) {
      els.routines.innerHTML = model.loading.catalog ? '<p class="empty">กำลังอ่านข้อมูล…</p>'
        : model.failed.catalog ? '<p class="empty">อ่านข้อมูลงานอัตโนมัติไม่สำเร็จ</p>'
          : '<p class="empty">ยังไม่มีงานอัตโนมัติที่รายงาน</p>';
      return;
    }

    // The lit row is whichever routine actually runs next: the server may say
    // so via status, otherwise it is derived as the soonest future nextRunAt.
    const now = Date.now();
    const nextId = provenUpcomingRoutine(list, now)?.id ?? null;

    const rows = list.map((r) => {
      const isNext = r?.id === nextId;
      const sourceStatus = literal(r?.status) || 'idle';
      const status = isNext ? 'next' : sourceStatus;
      const future = Number.isFinite(r?.nextRunAt) && r.nextRunAt > now;
      const timing = future ? hhmm(r.nextRunAt) : literal(r?.schedule) || 'ยังไม่ทราบเวลาทำงาน';
      const translated = status === 'next' ? 'คิวถัดไป' : status === 'fired' ? 'ทำงานแล้ว'
        : status === 'idle' ? 'รออยู่' : status === 'queued' ? 'อยู่ในคิว' : 'ไม่ทราบสถานะ';
      const presentation = status === 'next' ? 'is-next' : status === 'fired' ? 'is-fired'
        : status === 'idle' ? 'is-idle' : status === 'queued' ? 'is-queued' : 'is-unknown';
      const glyph = RUNNER_GLYPH[String(r?.runner ?? '').toLowerCase()] || 'dot';
      return `
        <tr class="rt-row ${presentation}" data-state="${esc(sourceStatus)}">
          <td class="rt-time tnum"><span>${esc(timing)}</span></td>
          <td class="rt-name">
            <span class="rt-runner">
              <span class="routine-junction" aria-hidden="true"></span>
              <span class="rt-runner-glyph" title="${esc(r?.runner ?? '')}">${icon(glyph, { size: 12 })}</span>
              <span class="rt-label" title="${esc(r?.name ?? r?.id ?? '')}">${esc(r?.name ?? r?.id ?? '')}</span>
            </span>
          </td>
          <td class="rt-status" data-state="${esc(sourceStatus)}">${esc(translated)}</td>
        </tr>`;
    }).join('');

    const stale = model.failed.catalog ? '<p class="empty" data-state="stale">ข้อมูลที่แสดงเป็นข้อมูลล่าสุดที่อ่านได้</p>' : '';
    els.routines.innerHTML = `${stale}
      <table class="rt">
        <thead><tr><th>เวลา</th><th>งานอัตโนมัติ</th><th>สถานะ</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // =========================================================================
  // stage tools
  // =========================================================================

  function renderInfo() {
    const c = model.catalog;
    const rows = [
      ['สตรีมเหตุการณ์', connectionLabel(connectionState())],
      ['เซิร์ฟเวอร์', model.hello?.version ? `v${model.hello.version}` : DASH],
      ['เริ่มทำงานเมื่อ', model.hello?.serverStartedAt ? new Date(model.hello.serverStartedAt).toLocaleTimeString('th-TH') : DASH],
      ['งาน', String(model.jobs.length)],
      ['คู่มือ', String(c.skills?.length ?? 0)],
      ['เอเจนต์', String(c.agents?.length ?? 0)],
      ['งานอัตโนมัติ', String(c.routines?.length ?? 0)],
      ['ความสามารถ', String(applicationViewModel(c).length)],
    ];
    els.info.innerHTML = rows.map(([k, v]) => `
      <div class="info-row">
        <span class="label label-dim">${esc(k)}</span>
        <span class="info-val tnum">${esc(v)}</span>
      </div>`).join('');
  }

  function onToolClick(ev) {
    const btn = ev.target.closest('button[data-tool]');
    if (!btn) return;
    const tool = btn.dataset.tool;
    if (tool === 'search' || tool === 'graph') {
      location.hash = '#brain';
      return;
    }
    if (tool === 'cmd') {
      if (!els.cmdbar) return;
      controls.commit(reduceRunUiState(controls.getState(), { type: 'cancel-resume' }));
      els.cmdbar.hidden = !els.cmdbar.hidden;
      if (!els.cmdbar.hidden) els.cmdbar.querySelector('input')?.focus();
      return;
    }
    if (tool === 'info') {
      const open = els.info.hidden;
      if (open) renderInfo();
      els.info.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    }
  }
  rootEl.querySelector('.stage-tools').addEventListener('click', onToolClick);

  function setCmdState(text, cls) {
    if (!els.cmdstate) return;
    els.cmdstate.textContent = text;
    els.cmdstate.className = `cmdbar-state${cls ? ` ${cls}` : ''}`;
  }

  async function onCmdSubmit(ev) {
    ev.preventDefault();
    const input = els.cmdbar.querySelector('input');
    const prompt = input.value.trim();
    if (!prompt) return;
    const currentState = controls.getState();
    const resume = currentState.resumeContext;
    const provider = resume?.provider ?? currentState.selectedProvider;
    setCmdState('Starting…');
    const row = await launchRun({
      prompt,
      provider,
      label: resume ? 'Codex continuation' : `${providerLabel(provider)} command`,
      resumeSessionId: resume?.sessionId ?? null,
    });
    if (!row) return;
    presentRunLaunch(els.cmdstate, row, 'cmdbar-state');
    input.value = '';
  }
  els.cmdbar?.addEventListener('submit', onCmdSubmit);

  const goBrain = () => { location.hash = '#brain'; };
  rootEl.querySelector('[data-action="brain"]').addEventListener('click', goBrain);
  rootEl.addEventListener('click', onOperatorInteraction);
  const onOrbitPreview = (event) => {
    const task = event.target.closest?.('button[data-task-id][data-job-id]');
    if (task) updateOrbitLabel(task.getAttribute('aria-label'));
  };
  rootEl.addEventListener('focusin', onOrbitPreview);
  rootEl.addEventListener('mouseover', onOrbitPreview);

  // =========================================================================
  // data
  // =========================================================================

  let framePending = false;
  let stageFloor = null;

  function captureOperatorFocus() {
    const active = document.activeElement;
    if (!active || !(els.brief.contains(active) || els.stage.contains(active) || els.inspector.contains(active))) return null;
    if (active.closest('[data-signal-action="open"]')) return { kind: 'signal' };
    const task = active.closest('button[data-task-id][data-job-id]');
    if (task) return { kind: 'task', jobId: task.dataset.jobId, taskId: task.dataset.taskId };
    if (active.closest('[data-inspector-heading]')) return { kind: 'inspector-heading' };
    if (active.closest('[data-inspector-action="close"]')) return { kind: 'inspector-close' };
    const copy = active.closest('button[data-copy-field]');
    if (copy) return { kind: 'copy', field: copy.dataset.copyField };
    return null;
  }

  function beginExplicitFocus(descriptor) {
    operatorUi.focusRevision += 1;
    operatorUi.focusIntent = descriptor ? { revision: operatorUi.focusRevision, descriptor } : null;
    return operatorUi.focusRevision;
  }

  function restoreOperatorFocus(ref, revision = null) {
    if (revision !== null && revision !== operatorUi.focusRevision) return;
    if (!ref) return;
    let target = null;
    if (ref.kind === 'signal') target = els.brief.querySelector('[data-signal-action="open"]');
    if (ref.kind === 'task') target = [...els.stage.querySelectorAll('button[data-task-id][data-job-id]')]
      .find((button) => button.dataset.jobId === ref.jobId && button.dataset.taskId === ref.taskId) ?? null;
    if (ref.kind === 'inspector-heading') target = els.inspector.querySelector('[data-inspector-heading]');
    if (ref.kind === 'inspector-close') target = els.inspector.querySelector('[data-inspector-action="close"]');
    if (ref.kind === 'copy') target = els.inspector.querySelector(`button[data-copy-field="${CSS.escape(ref.field)}"]`);
    target?.focus();
  }

  function queueExplicitFocus(ref, revision) {
    if (!ref) return;
    requestAnimationFrame(() => {
      if (disposed || revision !== operatorUi.focusRevision) return;
      restoreOperatorFocus(ref, revision);
      if (operatorUi.focusIntent?.revision === revision) operatorUi.focusIntent = null;
    });
  }

  function scheduleStage() {
    if (framePending || disposed) return;
    framePending = true;
    const scheduledRevision = operatorUi.focusRevision;
    const scheduledFocus = operatorUi.focusIntent?.descriptor ?? captureOperatorFocus();
    const run = () => {
      if (!framePending || disposed) return;
      framePending = false;
      reconcileInspectorSelection();
      renderOperatorStatus();
      renderOperatorBrief();
      renderStage();
      renderInspector();
      renderApps();
      renderDeck();
      renderRoutines();
      scheduleTrace();
      requestAnimationFrame(() => restoreOperatorFocus(scheduledFocus, scheduledRevision));
    };
    // rAF coalesces bursts of job.state events into one paint — but it is
    // PAUSED while the tab is hidden, which would leave the ring frozen on its
    // first empty paint until the tab was focused. The timeout is the floor
    // that guarantees the render actually happens either way.
    requestAnimationFrame(run);
    clearTimeout(stageFloor);
    stageFloor = setTimeout(run, 60);
  }

  function traceTargetElement(target) {
    if (target === 'work') return els.stage;
    if (target === 'routines') return rootEl.querySelector('[data-panel="routines"]');
    if (target === 'skills') return rootEl.querySelector('[data-panel="deck"]');
    if (target === 'apps') return rootEl.querySelector('[data-panel="apps"]');
    return rootEl.querySelector('.stage-head');
  }

  function renderSignalTrace() {
    const polyline = els.trace?.querySelector('polyline');
    if (!polyline) return;
    rootEl.querySelectorAll('.is-trace-target').forEach((element) => element.classList.remove('is-trace-target'));
    if (!operatorUi.traceActive) {
      polyline.setAttribute('points', '');
      polyline.classList.remove('is-drawing');
      polyline.style.removeProperty('--trace-length');
      operatorUi.traceDrawPending = false;
      clearTimeout(traceDrawTimer);
      return;
    }
    const signal = deriveOperatorSignal(model, connectionState(), Date.now());
    const source = els.brief.querySelector('[data-signal-action="open"]');
    const target = traceTargetElement(deriveTraceTarget(signal));
    if (!source || !target || target.hidden || target.getClientRects().length === 0) {
      polyline.setAttribute('points', '');
      operatorUi.traceDrawPending = false;
      return;
    }
    target.classList.add('is-trace-target');
    if (window.matchMedia('(max-width: 1100px)').matches) {
      polyline.setAttribute('points', '');
      polyline.classList.remove('is-drawing');
      operatorUi.traceDrawPending = false;
      return;
    }
    const shell = rootEl.getBoundingClientRect();
    const a = source.getBoundingClientRect(); const b = target.getBoundingClientRect();
    if (!shell.width || !shell.height) { polyline.setAttribute('points', ''); return; }
    els.trace.setAttribute('viewBox', `0 0 ${shell.width} ${shell.height}`);
    const sx = a.left - shell.left + a.width / 2; const sy = a.top - shell.top + a.height / 2;
    const tx = b.left - shell.left + b.width / 2; const ty = b.top - shell.top + Math.min(42, b.height / 2);
    const sameLane = Math.abs(tx - sx) < 24;
    const lane = Math.max(32, Math.min(96, shell.width * 0.12));
    let mx = sx + (tx - sx) * 0.52;
    if (sameLane) {
      mx = clamp(18, sx + (sx <= shell.width / 2 ? lane : -lane), shell.width - 18);
      if (Math.abs(mx - sx) < 8) mx = clamp(18, sx + (sx <= shell.width / 2 ? -lane : lane), shell.width - 18);
    }
    polyline.setAttribute('points', `${sx},${sy} ${mx},${sy} ${mx},${ty} ${tx},${ty}`);
    if (!operatorUi.traceDrawPending) return;
    operatorUi.traceDrawPending = false;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      polyline.classList.remove('is-drawing');
      polyline.style.removeProperty('--trace-length');
      return;
    }
    let length = 0;
    try { length = polyline.getTotalLength(); } catch { length = 0; }
    polyline.style.setProperty('--trace-length', String(Math.max(0, length)));
    polyline.classList.remove('is-drawing');
    void polyline.getBoundingClientRect();
    polyline.classList.add('is-drawing');
    clearTimeout(traceDrawTimer);
    traceDrawTimer = setTimeout(() => polyline.classList.remove('is-drawing'), 900);
  }

  let traceFrame = 0;
  let traceDrawTimer = null;
  function scheduleTrace() {
    if (traceFrame || disposed) return;
    traceFrame = requestAnimationFrame(() => { traceFrame = 0; if (!disposed) renderSignalTrace(); });
  }

  async function loadJobs() {
    const ctl = new AbortController();
    controllers.add(ctl);
    let data = null;
    try { data = await getJSON('/api/jobs', { signal: ctl.signal }); }
    catch { data = null; }
    controllers.delete(ctl);
    if (disposed) return;
    model.failed.jobs = data == null;
    if (data != null) model.jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    model.loading.jobs = false;
    scheduleStage();
  }

  async function loadCatalog() {
    const ctl = new AbortController();
    controllers.add(ctl);
    let data = null;
    try { data = await getJSON('/api/catalog', { signal: ctl.signal }); }
    catch { data = null; }
    controllers.delete(ctl);
    if (disposed) return;
    model.failed.catalog = data == null;
    if (data != null) model.catalog = normalizeDashboardCatalog(data);
    model.loading.catalog = false;
    renderApps();
    renderDeck();
    renderRoutines();
    scheduleStage();
  }

  // first paint with empty models, so a dead server still renders full chrome
  renderApps();
  renderDeck();
  renderRoutines();
  renderOperatorStatus();
  renderOperatorBrief();
  renderStage();
  renderInspector();

  loadJobs();
  loadCatalog();

  // -- live wiring ---------------------------------------------------------

  unsubs.push(subscribe('hello', (p) => { model.hello = p; scheduleStage(); }));

  unsubs.push(subscribe('job.state', (job) => {
    if (!job || typeof job.id !== 'string') return;
    const i = model.jobs.findIndex((j) => j?.id === job.id);
    if (i >= 0) model.jobs[i] = job; else model.jobs.push(job);
    scheduleStage();
  }));

  unsubs.push(subscribe('job.removed', (p) => {
    const id = p?.id;
    if (!id) return;
    model.jobs = model.jobs.filter((j) => j?.id !== id);
    scheduleStage();
  }));

  unsubs.push(subscribe('catalog.invalidated', () => { loadCatalog(); }));

  // A hook fired somewhere in Claude Code: one 1px accent flash on the rail
  // under the wordmark. Small, honest, and not a panel of its own.
  let pulseTimer = null;
  unsubs.push(subscribe('hook.event', () => {
    els.pulse.classList.add('is-live');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => els.pulse.classList.remove('is-live'), 520);
  }));

  unsubs.push(subscribe('run.done', (p) => {
    // Only react to runs THIS view started. Runs begun elsewhere (another tab,
    // a hook, slice E itself) must not rewrite our command bar.
    const row = runCoordinator.handleDone(p);
    if (!row) return;
    if (row.skillName !== null) {
      const card = els.deck.querySelector(skillCardSelector(row.provider, row.skillName));
      if (card) presentSkillRun(card, row);
    } else {
      presentRunLaunch(els.cmdstate, row, 'cmdbar-state');
    }
  }));

  unsubs.push(subscribe('__state', () => { scheduleStage(); }));

  const onVisible = () => { if (!document.hidden) scheduleStage(); };
  document.addEventListener('visibilitychange', onVisible);
  unsubs.push(() => document.removeEventListener('visibilitychange', onVisible));

  // -- responsive ring -----------------------------------------------------

  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { scheduleStage(); scheduleTrace(); });
    ro.observe(els.stage);
  } else {
    const onResize = () => { scheduleStage(); scheduleTrace(); };
    window.addEventListener('resize', onResize);
    unsubs.push(() => window.removeEventListener('resize', onResize));
  }

  // =========================================================================

  return {
    destroy() {
      disposed = true;
      for (const t of timers) clearInterval(t);
      clearTimeout(stageFloor);
      clearTimeout(pulseTimer);
      clearTimeout(traceDrawTimer);
      if (traceFrame) cancelAnimationFrame(traceFrame);
      for (const u of unsubs) { try { u(); } catch { /* already gone */ } }
      for (const c of controllers) { try { c.abort(); } catch { /* done */ } }
      controllers.clear();
      if (ro) ro.disconnect();
      runCoordinator.destroy();
      controls.destroy();
      els.cmdbar?.removeEventListener('submit', onCmdSubmit);
      rootEl.querySelector('.stage-tools')?.removeEventListener('click', onToolClick);
      rootEl.removeEventListener('click', onOperatorInteraction);
      rootEl.removeEventListener('focusin', onOrbitPreview);
      rootEl.removeEventListener('mouseover', onOrbitPreview);
      rootEl.replaceChildren();
    },
  };
}
