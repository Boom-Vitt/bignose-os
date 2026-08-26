const API_ROOT = '/api/brain';
const MAX_ASK_QUERY_LENGTH = 160;
const MAX_TEXT_LENGTH = 360;
const MAX_PATH_ID_LENGTH = 320;
const ALLOWED_PROVIDERS = new Set(['claude', 'codex', 'all']);

export const LAST_SEEN_BUILT_AT_KEY = 'boombignose.brain.lastSeenBuiltAt';

function plainText(value, limit = MAX_TEXT_LENGTH) {
  const normalized = typeof value === 'string' ? value.normalize('NFKC') : '';
  const compact = normalized
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function evidenceText(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '�')
    : '';
}

function pathId(value) {
  return plainText(value, MAX_PATH_ID_LENGTH);
}

function nonnegativeSafeInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function providerValue(value) {
  const provider = plainText(value, 20).toLowerCase();
  return ALLOWED_PROVIDERS.has(provider) ? provider : 'all';
}

function itemSummary(item) {
  const title = plainText(item?.title, 160);
  const status = plainText(item?.status, 80);
  const summary = plainText(item?.summary, MAX_TEXT_LENGTH);
  const lines = [];
  if (title) lines.push(`ชื่อ: ${title}`);
  if (status) lines.push(`สถานะ: ${status}`);
  if (summary) lines.push(`สรุป: ${summary}`);
  return lines;
}

function itemList(items) {
  const entries = Array.isArray(items) ? items.slice(0, 3) : [];
  const lines = entries
    .map((item) => {
      const details = itemSummary(item);
      return details.length ? `- ${details.join(' | ')}` : '';
    })
    .filter(Boolean);
  return lines.length ? lines : ['- ไม่มีรายการ'];
}

function citationList(citations) {
  const entries = Array.isArray(citations) ? citations.slice(0, 8) : [];
  const lines = entries
    .map((citation) => {
      const provider = evidenceText(citation?.provider);
      const path = evidenceText(citation?.path);
      const title = evidenceText(citation?.title);
      if (!provider || !path) return '';
      return title ? `- ${provider}: ${path} — ${title}` : `- ${provider}: ${path}`;
    })
    .filter(Boolean);
  return lines.length ? lines : ['- ไม่มีแหล่งอ้างอิง'];
}

function projectValue(candidate) {
  if (typeof candidate?.project !== 'string') return '';
  const normalized = candidate.project
    .normalize('NFKC')
    .replace(/\r\n?|\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/[\t\f\v ]+/g, ' ')
    .trim();
  if (!normalized) return '';
  const bounded = normalized.slice(0, MAX_ASK_QUERY_LENGTH);
  return bounded
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

export function resumePath(id) {
  const params = new URLSearchParams({ id: pathId(id) });
  return `${API_ROOT}/resume?${params.toString()}`;
}

export function inboxPath(since) {
  const safeSince = nonnegativeSafeInteger(since) ?? 0;
  const params = new URLSearchParams({ since: String(safeSince) });
  return `${API_ROOT}/inbox?${params.toString()}`;
}

export function askPath(options = {}) {
  const query = plainText(options?.q ?? options?.query, MAX_ASK_QUERY_LENGTH);
  const params = new URLSearchParams({ q: query, provider: providerValue(options?.provider) });
  const project = typeof options?.project === 'string' ? plainText(options.project, MAX_ASK_QUERY_LENGTH) : '';
  if (project) params.set('project', project);
  return `${API_ROOT}/ask?${params.toString()}`;
}

export function gapPath() {
  return `${API_ROOT}/gaps`;
}

export function refreshPath() {
  return `${API_ROOT}/refresh`;
}

export function focusPath(id, depth) {
  const params = new URLSearchParams({ focus: pathId(id), depth: String(depth === 2 ? 2 : 1) });
  return `${API_ROOT}?${params.toString()}`;
}

export function formatResumeBrief(payload, provider) {
  const target = provider === 'codex' ? 'codex' : 'claude';
  const instructions = target === 'codex'
    ? ['สวัสดี Codex', 'โปรดอ่านแหล่งอ้างอิงด้านล่าง แล้วทำงานต่อจากบริบทนี้']
    : ['สวัสดี Claude', 'โปรดอ่านแหล่งอ้างอิงด้านล่าง แล้วทำงานต่อจากบริบทนี้'];
  const selected = itemSummary(payload?.selected);
  const nextAction = itemSummary(payload?.nextAction);
  const lines = [
    ...instructions,
    '',
    'งานที่เลือก:',
    ...(selected.length ? selected : ['- ไม่มีงานที่เลือก']),
    '',
    'การตัดสินใจ:',
    ...itemList(payload?.decisions),
    '',
    'สิ่งที่ต้องใส่ใจ:',
    ...itemList(payload?.attention),
    '',
    'งานถัดไป:',
    ...(nextAction.length ? nextAction : ['- ไม่มีงานถัดไป']),
    '',
    'แหล่งอ้างอิง:',
    ...citationList(payload?.citations),
  ];
  return lines.join('\n');
}

export function classificationTemplate(candidate) {
  const project = projectValue(candidate);
  const projectLine = project ? `\nproject: "${project}"` : '';
  return `---\ntype: note\nstatus: active${projectLine}\n---`;
}

export function readLastSeenBuiltAt(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return 0;
    return nonnegativeSafeInteger(storage.getItem(LAST_SEEN_BUILT_AT_KEY)) ?? 0;
  } catch {
    return 0;
  }
}

export function writeLastSeenBuiltAt(storage, value) {
  const timestamp = typeof value === 'number' ? nonnegativeSafeInteger(value) : null;
  if (timestamp === null) return false;
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(LAST_SEEN_BUILT_AT_KEY, String(timestamp));
    return true;
  } catch {
    return false;
  }
}
