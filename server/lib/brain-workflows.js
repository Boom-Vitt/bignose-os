import { redact } from './redact.js';

const MAX_RESUME_PROJECT_ITEMS = 8;
const MAX_RESUME_DECISIONS = 3;
const MAX_RESUME_ATTENTION = 3;
const MAX_CITATIONS = 8;
const MAX_INBOX_ITEMS = 12;
const MAX_ASK_QUERY_LENGTH = 160;
const MAX_ASK_RESULTS = 8;
const MAX_GAPS = 12;
const MAX_GAP_ITEMS_PER_PROVIDER = 48;
const MAX_GAP_TITLE_TOKENS = 8;
const MAX_GAP_TOKEN_BUCKET = 4;
const MAX_GAP_SIMILARITY_CANDIDATES = 24;

const PROVIDERS = new Set(['claude', 'codex']);
const GAP_TYPES = new Set(['project', 'decision', 'task', 'note', 'source']);
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'what', 'with',
  'กับ', 'ของ', 'คือ', 'ที่', 'ใน', 'และ', 'หรือ', 'ให้', 'ได้', 'เป็น', 'มี', 'ว่า', 'จาก', 'เพื่อ', 'เมื่อ',
]);
const INSTRUCTION_FILENAMES = new Set(['agents.md', 'claude.md', 'memory.md', 'memory_summary.md']);

function safeString(value, limit = 0) {
  const normalized = typeof value === 'string' ? value.normalize('NFKC') : '';
  const text = redact(normalized).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function rawString(value) {
  return typeof value === 'string' ? value : '';
}

function normalized(value) {
  return safeString(value).toLowerCase();
}

function safeList(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : [];
}

function stableId(value) {
  return rawString(value?.id);
}

function exactId(value) {
  return typeof value === 'string' ? value : '';
}

function updatedAt(value) {
  const timestamp = Number(value?.updatedAt);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : 0;
}

function newestFirst(left, right) {
  const difference = updatedAt(right) - updatedAt(left);
  if (difference !== 0) return difference;
  const leftId = stableId(left);
  const rightId = stableId(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function safeBuiltAt(index) {
  const timestamp = Number(index?.builtAt);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : 0;
}

function semanticItems(index) {
  return safeList(index?.items).filter((item) => stableId(item));
}

function candidateItems(index) {
  return safeList(index?.candidates).filter((candidate) => stableId(candidate));
}

function semanticRelations(index) {
  return safeList(index?.relations).filter((relation) => (
    rawString(relation?.from) && rawString(relation?.to)
  ));
}

function providerOf(item) {
  const provider = rawString(item?.source?.provider).trim().toLowerCase();
  return PROVIDERS.has(provider) ? provider : '';
}

function citationFor(item) {
  const provider = providerOf(item);
  const path = safeString(item?.source?.path);
  const title = safeString(item?.title, 160);
  if (!provider || !path || !title) return null;
  return { provider, path, title };
}

function distinctCitations(entries, limit = MAX_CITATIONS) {
  const citations = [];
  const seen = new Set();
  for (const entry of entries) {
    const citation = citationFor(entry);
    if (!citation) continue;
    const key = `${citation.provider}\u0000${citation.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push(citation);
    if (citations.length === limit) break;
  }
  return citations;
}

function tokenize(value) {
  const tokens = new Set();
  const matches = normalized(value).match(/[a-z0-9]+|[\u0e00-\u0e7f]+/gu) ?? [];
  for (const match of matches) {
    if (STOP_WORDS.has(match)) continue;
    if (/^[\u0e00-\u0e7f]+$/u.test(match)) {
      if (match.length >= 2) {
        tokens.add(match);
        for (let index = 0; index < match.length - 1; index += 1) tokens.add(match.slice(index, index + 2));
      }
      continue;
    }
    if (match.length >= 2) tokens.add(match);
  }
  return [...tokens].sort();
}

function normalizedProject(item) {
  return normalized(item?.project);
}

function selectedScope(options = {}) {
  const requestedProvider = normalized(options?.provider);
  const provider = PROVIDERS.has(requestedProvider) ? requestedProvider : 'all';
  const project = safeString(options?.project, 160);
  return { provider, project };
}

function projectionBase(index) {
  return { schema: 1, builtAt: safeBuiltAt(index) };
}

function redactedOutput(value, ancestors = new WeakSet()) {
  if (typeof value === 'string') return safeString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return null;
  if (ancestors.has(value)) return null;
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => redactedOutput(entry, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      safeString(key, 160),
      redactedOutput(entry, ancestors),
    ]));
  ancestors.delete(value);
  return result;
}

function orderedUnique(items) {
  const seen = new Set();
  return items.filter((item) => {
    const id = stableId(item);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function explicitRelatedItems(selected, items, relations) {
  const selectedId = stableId(selected);
  const byId = new Map(items.map((item) => [stableId(item), item]));
  const relatedIds = new Set();
  const project = normalizedProject(selected);

  if (project) {
    for (const item of items) {
      if (stableId(item) !== selectedId && normalizedProject(item) === project) relatedIds.add(stableId(item));
    }
  }

  for (const relation of relations) {
    if (rawString(relation?.evidence) === 'shared-project') continue;
    if (rawString(relation?.from) === selectedId) relatedIds.add(rawString(relation?.to));
    if (rawString(relation?.to) === selectedId) relatedIds.add(rawString(relation?.from));
  }

  return [...relatedIds]
    .filter((id) => id !== selectedId && byId.has(id))
    .map((id) => byId.get(id))
    .sort(newestFirst);
}

function attentionOrder(left, right) {
  const leftPriority = left?.status === 'blocked' ? 0 : 1;
  const rightPriority = right?.status === 'blocked' ? 0 : 1;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return newestFirst(left, right);
}

function safelyClampedSince(value, builtAt) {
  let timestamp;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) timestamp = Number(value.trim());
  else timestamp = 0;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) timestamp = 0;
  return Math.min(timestamp, builtAt);
}

function isInstructionCandidate(item) {
  const sourcePath = rawString(item?.source?.path).replace(/\\/g, '/');
  if (!sourcePath) return false;
  const parts = sourcePath.split('/').filter(Boolean).map((part) => part.toLowerCase());
  const filename = parts.at(-1) ?? '';
  if (INSTRUCTION_FILENAMES.has(filename)) return true;
  const provider = providerOf(item);
  const root = parts[0] ?? '';
  if (provider === 'claude') {
    if (root === 'rules' || root === 'memory' || root === 'memories') return true;
    return root === 'projects' && ['memory', 'memories'].includes(parts[2] ?? '');
  }
  return provider === 'codex' && root === 'memories';
}

function itemTextTokens(item, field) {
  if (field === 'title') return tokenize(item?.title);
  if (field === 'project') return tokenize(item?.project);
  if (field === 'summary') return tokenize(item?.summary);
  if (field === 'tags') return tokenize((Array.isArray(item?.tags) ? item.tags : []).filter((tag) => typeof tag === 'string').join(' '));
  return tokenize(`${safeString(item?.type)} ${providerOf(item)}`);
}

function tokenMatches(queryTokens, values) {
  const available = new Set(values);
  return queryTokens.filter((token) => available.has(token)).length;
}

function askScore(item, query, queryTokens) {
  const title = normalized(item?.title);
  const project = normalized(item?.project);
  let score = 0;
  if (query && title === query) score += 100000;
  if (query && project === query) score += 90000;
  if (query && title.includes(query)) score += 10000;
  if (query && project.includes(query)) score += 9000;
  score += tokenMatches(queryTokens, itemTextTokens(item, 'title')) * 120;
  score += tokenMatches(queryTokens, itemTextTokens(item, 'project')) * 100;
  score += tokenMatches(queryTokens, itemTextTokens(item, 'tags')) * 40;
  score += tokenMatches(queryTokens, itemTextTokens(item, 'summary')) * 25;
  score += tokenMatches(queryTokens, itemTextTokens(item, 'type')) * 20;
  return score;
}

function resultOrder(left, right) {
  if (left.score !== right.score) return right.score - left.score;
  return newestFirst(left.item, right.item);
}

function answerForResults(results) {
  if (results.length === 0) return 'ไม่พบข้อมูลใน Brain ที่ตรงกับคำถามนี้';
  const titles = results.slice(0, 3).map((result) => safeString(result.item.title, 80)).filter(Boolean);
  return safeString(`พบข้อมูลที่เกี่ยวข้อง ${results.length} รายการ: ${titles.join(' • ')}`, 360);
}

function titleSimilarity(left, right) {
  const leftTokens = new Set(tokenize(left?.title));
  const rightTokens = new Set(tokenize(right?.title));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / Math.min(leftTokens.size, rightTokens.size);
}

function materiallyDifferent(left, right) {
  const differences = [];
  if (normalized(left?.status) !== normalized(right?.status)) differences.push('status');
  if (normalized(left?.project) !== normalized(right?.project)) differences.push('project');
  if (normalized(left?.summary) !== normalized(right?.summary)) differences.push('summary');
  return differences;
}

function highValueForMissing(item) {
  return item?.type !== 'note' || ['active', 'next', 'blocked'].includes(item?.status);
}

function normalizedTitle(item) {
  return normalized(item?.title);
}

function itemMetadataSignature(item) {
  return [normalized(item?.status), normalized(item?.project), normalized(item?.summary)].join('\u0000');
}

function addLimitedIndexEntry(index, key, item, limit) {
  if (!key) return;
  const bucket = index.get(key) ?? [];
  if (bucket.length < limit) bucket.push(item);
  index.set(key, bucket);
}

function addExactTitleProfile(index, item) {
  const title = normalizedTitle(item);
  if (!title) return;
  const signature = itemMetadataSignature(item);
  const profile = index.get(title);
  if (!profile) {
    index.set(title, { primary: item, primarySignature: signature, alternate: null });
  } else if (!profile.alternate && profile.primarySignature !== signature) {
    profile.alternate = item;
  }
}

function buildGapLookup(exactItems, similarityItems) {
  const exactTitles = new Map();
  const tokens = new Map();
  for (const item of exactItems) addExactTitleProfile(exactTitles, item);
  for (const item of similarityItems) {
    for (const token of tokenize(item?.title).slice(0, MAX_GAP_TITLE_TOKENS)) {
      addLimitedIndexEntry(tokens, token, item, MAX_GAP_TOKEN_BUCKET);
    }
  }
  return { exactTitles, tokens };
}

function gapItemsByProvider(index) {
  const grouped = { claude: [], codex: [] };
  for (const item of semanticItems(index)) {
    const provider = providerOf(item);
    if (!GAP_TYPES.has(rawString(item?.type)) || !provider) continue;
    grouped[provider].push(item);
  }
  for (const provider of PROVIDERS) {
    grouped[provider].sort(newestFirst);
  }
  return grouped;
}

function boundedSimilarityCandidates(item, lookup) {
  const candidates = new Map();
  for (const token of tokenize(item?.title).slice(0, MAX_GAP_TITLE_TOKENS)) {
    for (const candidate of lookup.tokens.get(token) ?? []) {
      const id = stableId(candidate);
      if (id && !candidates.has(id)) candidates.set(id, candidate);
    }
  }
  return [...candidates.values()].sort(newestFirst).slice(0, MAX_GAP_SIMILARITY_CANDIDATES);
}

function exactTitleCounterpart(item, lookup) {
  const profile = lookup.exactTitles.get(normalizedTitle(item));
  if (!profile) return null;
  const signature = itemMetadataSignature(item);
  if (profile.primarySignature !== signature) return profile.primary;
  return profile.alternate;
}

function gapOrder(left, right) {
  const kindOrder = left.kind === right.kind ? 0 : left.kind === 'possible-divergence' ? -1 : 1;
  if (kindOrder !== 0) return kindOrder;
  const timeDifference = right.updatedAt - left.updatedAt;
  if (timeDifference !== 0) return timeDifference;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function resumeProjection(index, id) {
  const base = projectionBase(index);
  const items = semanticItems(index);
  const selected = items.find((item) => stableId(item) === exactId(id)) ?? null;
  if (!selected) {
    return redactedOutput({
      ...base,
      selected: null,
      projectItems: [],
      decisions: [],
      attention: [],
      citations: [],
      nextAction: null,
    });
  }

  const related = explicitRelatedItems(selected, items, semanticRelations(index));
  const projectItems = related.slice(0, MAX_RESUME_PROJECT_ITEMS);
  const context = orderedUnique([selected, ...related]);
  const decisions = context.filter((item) => item.type === 'decision').sort(newestFirst).slice(0, MAX_RESUME_DECISIONS);
  const attention = context
    .filter((item) => item.status === 'blocked' || item.status === 'next')
    .sort(attentionOrder)
    .slice(0, MAX_RESUME_ATTENTION);
  const nextAction = context
    .filter((item) => item.type === 'task' && (item.status === 'blocked' || item.status === 'next'))
    .sort(attentionOrder)[0] ?? selected;

  return redactedOutput({
    ...base,
    selected,
    projectItems,
    decisions,
    attention,
    citations: distinctCitations([selected, ...decisions, ...attention, nextAction, ...projectItems]),
    nextAction,
  });
}

export function inboxProjection(index, since) {
  const base = projectionBase(index);
  const safeSince = safelyClampedSince(since, base.builtAt);
  const newItems = semanticItems(index)
    .filter((item) => updatedAt(item) > safeSince)
    .sort(newestFirst)
    .slice(0, MAX_INBOX_ITEMS);
  const unclassified = candidateItems(index).sort(newestFirst).slice(0, MAX_INBOX_ITEMS);
  const changedInstructions = orderedUnique([
    ...semanticItems(index),
    ...candidateItems(index),
  ])
    .filter((item) => updatedAt(item) > safeSince && isInstructionCandidate(item))
    .sort(newestFirst)
    .slice(0, MAX_INBOX_ITEMS);
  const total = new Set([...newItems, ...unclassified, ...changedInstructions].map(stableId)).size;

  return redactedOutput({
    ...base,
    since: safeSince,
    newItems,
    unclassified,
    changedInstructions,
    total,
  });
}

export function askProjection(index, options = {}) {
  const base = projectionBase(index);
  const query = safeString(options?.q ?? options?.query, MAX_ASK_QUERY_LENGTH);
  const scope = selectedScope(options);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return redactedOutput({
      ...base,
      query,
      scope,
      answer: 'โปรดระบุคำถามให้เฉพาะเจาะจงขึ้น',
      results: [],
      citations: [],
    });
  }

  const scopedProject = normalized(scope.project);
  const matches = semanticItems(index)
    .filter((item) => (
      (scope.provider === 'all' || providerOf(item) === scope.provider)
      && (!scopedProject || normalizedProject(item) === scopedProject)
    ))
    .map((item) => ({ item, score: askScore(item, normalized(query), queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort(resultOrder)
    .slice(0, MAX_ASK_RESULTS);
  const results = matches.map(({ item, score }) => {
    const { citation: _ignoredCitation, ...record } = item;
    return { ...record, score, citation: citationFor(item) };
  });

  return redactedOutput({
    ...base,
    query,
    scope,
    answer: answerForResults(matches),
    results,
    citations: distinctCitations(matches.map((entry) => entry.item), MAX_ASK_RESULTS),
  });
}

export function gapProjection(index) {
  const base = projectionBase(index);
  const byProvider = gapItemsByProvider(index);
  const lookupByProvider = {
    claude: buildGapLookup(byProvider.claude, byProvider.claude.slice(0, MAX_GAP_ITEMS_PER_PROVIDER)),
    codex: buildGapLookup(byProvider.codex, byProvider.codex.slice(0, MAX_GAP_ITEMS_PER_PROVIDER)),
  };
  const items = [
    ...byProvider.claude.slice(0, MAX_GAP_ITEMS_PER_PROVIDER),
    ...byProvider.codex.slice(0, MAX_GAP_ITEMS_PER_PROVIDER),
  ];
  const gaps = [];
  const seenPairs = new Set();

  for (const item of items) {
    const provider = providerOf(item);
    const otherProvider = provider === 'claude' ? 'codex' : 'claude';
    const other = exactTitleCounterpart(item, lookupByProvider[otherProvider]);
    if (!other) continue;
    const pair = [stableId(item), stableId(other)].sort().join('\u0000');
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const differences = materiallyDifferent(item, other);
    if (differences.length === 0) continue;
    gaps.push({
      id: `possible-divergence:${pair}`,
      kind: 'possible-divergence',
      direction: `${provider}->${otherProvider}`,
      itemType: item.type,
      title: safeString(item.title, 160),
      reason: 'ชื่อเดียวกันแต่สถานะ โครงการ หรือสรุปต่างกัน ควรตรวจสอบ',
      differences,
      updatedAt: Math.max(updatedAt(item), updatedAt(other)),
      evidence: { from: citationFor(item), to: citationFor(other) },
    });
  }

  for (const item of items) {
    if (!highValueForMissing(item)) continue;
    const provider = providerOf(item);
    const otherProvider = provider === 'claude' ? 'codex' : 'claude';
    if (lookupByProvider[otherProvider].exactTitles.has(normalizedTitle(item))) continue;
    const hasSimilar = boundedSimilarityCandidates(item, lookupByProvider[otherProvider])
      .some((other) => titleSimilarity(item, other) >= 0.6);
    if (hasSimilar) continue;
    gaps.push({
      id: `missing-counterpart:${stableId(item)}:${otherProvider}`,
      kind: 'missing-counterpart',
      direction: `${provider}->${otherProvider}`,
      itemType: item.type,
      title: safeString(item.title, 160),
      reason: `ยังไม่พบรายการชื่อใกล้เคียงใน ${otherProvider === 'claude' ? 'Claude' : 'Codex'}`,
      updatedAt: updatedAt(item),
      evidence: { from: citationFor(item), to: null },
    });
  }

  return redactedOutput({
    ...base,
    gaps: gaps.sort(gapOrder).slice(0, MAX_GAPS),
  });
}
