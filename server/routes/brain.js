import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { buildBrainIndex } from '../lib/brain-index.js';
import {
  askProjection,
  gapProjection,
  inboxProjection,
  resumeProjection,
} from '../lib/brain-workflows.js';

const ITEM_TYPES = new Set(['project', 'person', 'idea', 'decision', 'task', 'note', 'source']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_QUERY_LENGTH = 120;
const FOCUS_RELATION_LIMIT = 6;
const FOCUS_ITEM_LIMIT = 13;
const FOCUS_DEPTH_TWO_RELATION_LIMIT = 32;
const FOCUS_DEPTH_TWO_ITEM_LIMIT = 25;
const MAP_ITEMS_PER_TYPE_PROVIDER = 6;
const MAP_PROVIDERS = Object.freeze(['claude', 'codex']);
const DEFAULT_CACHE_TTL_MS = 30_000;
const RELATION_EVIDENCE_PRIORITY = new Map([
  ['explicit-link', 0],
  ['declared', 1],
  ['shared-project', 2],
]);

function emptyBrainPayload() {
  return {
    schema: 1,
    builtAt: 0,
    summary: {
      items: 0,
      projects: 0,
      people: 0,
      ideas: 0,
      decisions: 0,
      tasks: 0,
      notes: 0,
      sources: 0,
      needsAttention: 0,
    },
    page: { total: 0, offset: 0, limit: DEFAULT_LIMIT, hasMore: false },
    today: { continueWorking: null, recentDecisions: [], needsAttention: [] },
    items: [],
    relations: [],
    unavailable: true,
  };
}

const EMPTY_WORKFLOW_INDEX = Object.freeze({
  schema: 1,
  builtAt: 0,
  items: Object.freeze([]),
  relations: Object.freeze([]),
  candidates: Object.freeze([]),
});

async function loadLocalBrain() {
  const home = os.homedir();
  return buildBrainIndex({
    sources: [
      { provider: 'claude', root: path.join(home, '.claude') },
      { provider: 'codex', root: path.join(home, '.codex') },
    ],
  });
}

function queryString(value) {
  return typeof value === 'string' ? value : '';
}

function boundedInteger(value, fallback, minimum, maximum) {
  const raw = queryString(value).trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function relationIdOrder(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function relationPriorityOrder(left, right) {
  const leftPriority = RELATION_EVIDENCE_PRIORITY.get(left.evidence) ?? 3;
  const rightPriority = RELATION_EVIDENCE_PRIORITY.get(right.evidence) ?? 3;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  const leftConfidence = Number.isFinite(left.confidence) ? left.confidence : 0;
  const rightConfidence = Number.isFinite(right.confidence) ? right.confidence : 0;
  if (leftConfidence !== rightConfidence) return rightConfidence - leftConfidence;
  return relationIdOrder(left, right);
}

function newestItemOrder(left, right) {
  const leftUpdatedAt = Number.isFinite(left.updatedAt) ? left.updatedAt : 0;
  const rightUpdatedAt = Number.isFinite(right.updatedAt) ? right.updatedAt : 0;
  if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
  return relationIdOrder(left, right);
}

function todayProjection(index) {
  const items = Array.isArray(index.items) ? index.items : [];
  const continueWorking = items
    .filter((item) => item.status === 'active' && (item.type === 'project' || item.type === 'task'))
    .sort(newestItemOrder)[0] ?? null;
  const recentDecisions = items
    .filter((item) => item.type === 'decision')
    .sort(newestItemOrder)
    .slice(0, 3);
  const blocked = items
    .filter((item) => item.status === 'blocked')
    .sort(newestItemOrder);
  const next = items
    .filter((item) => item.status === 'next')
    .sort(newestItemOrder);

  return {
    continueWorking,
    recentDecisions,
    needsAttention: [...blocked, ...next].slice(0, 3),
  };
}

function payloadBase(index) {
  return {
    schema: index.schema,
    builtAt: index.builtAt,
    summary: index.summary,
    today: todayProjection(index),
  };
}

function searchableItemText(item) {
  return [
    item?.title,
    item?.summary,
    item?.project,
    ...(Array.isArray(item?.tags) ? item.tags : []),
  ].filter((value) => typeof value === 'string').join('\n').toLowerCase();
}

function focusProjection(index, focusId, depth = 1) {
  const allItems = Array.isArray(index.items) ? index.items : [];
  const allRelations = Array.isArray(index.relations) ? index.relations : [];
  const itemsById = new Map(allItems.map((item) => [item.id, item]));
  const selected = itemsById.get(focusId);
  const itemLimit = depth === 2 ? FOCUS_DEPTH_TWO_ITEM_LIMIT : FOCUS_ITEM_LIMIT;
  if (!selected) {
    return {
      ...payloadBase(index),
      page: { total: 0, offset: 0, limit: itemLimit, hasMore: false },
      items: [],
      relations: [],
    };
  }

  const completeRelations = allRelations.filter((relation) => (
    itemsById.has(relation.from) && itemsById.has(relation.to)
  ));
  const incoming = completeRelations
    .filter((relation) => relation.to === focusId && relation.from !== focusId)
    .sort(relationPriorityOrder)
    .slice(0, FOCUS_RELATION_LIMIT);
  const outgoing = completeRelations
    .filter((relation) => relation.from === focusId)
    .sort(relationPriorityOrder)
    .slice(0, FOCUS_RELATION_LIMIT);
  const relations = [...incoming, ...outgoing];
  const items = [selected];
  const included = new Set([focusId]);
  for (const relation of relations) {
    for (const endpoint of [relation.from, relation.to]) {
      if (included.has(endpoint)) continue;
      included.add(endpoint);
      items.push(itemsById.get(endpoint));
    }
  }

  if (depth === 2) {
    const relationIds = new Set(relations.map((relation) => relation.id));
    const firstHopIds = items.slice(1).map((item) => item.id);
    const incidentRelations = new Map();
    for (const relation of completeRelations) {
      for (const endpoint of [relation.from, relation.to]) {
        const incident = incidentRelations.get(endpoint) ?? [];
        incident.push(relation);
        incidentRelations.set(endpoint, incident);
      }
    }
    for (const incident of incidentRelations.values()) incident.sort(relationPriorityOrder);

    for (const firstHopId of firstHopIds) {
      if (items.length >= FOCUS_DEPTH_TWO_ITEM_LIMIT || relations.length >= FOCUS_DEPTH_TWO_RELATION_LIMIT) break;
      for (const relation of incidentRelations.get(firstHopId) ?? []) {
        if (items.length >= FOCUS_DEPTH_TWO_ITEM_LIMIT || relations.length >= FOCUS_DEPTH_TWO_RELATION_LIMIT) break;
        const neighborId = relation.from === firstHopId ? relation.to : relation.from;
        if (!neighborId || included.has(neighborId) || relationIds.has(relation.id)) continue;
        included.add(neighborId);
        items.push(itemsById.get(neighborId));
        relations.push(relation);
        relationIds.add(relation.id);
      }
    }

    const additionalRelations = completeRelations
      .filter((relation) => (
        relation.from !== focusId
        && relation.to !== focusId
        && included.has(relation.from)
        && included.has(relation.to)
        && !relationIds.has(relation.id)
      ))
      .sort(relationPriorityOrder);
    for (const relation of additionalRelations) {
      if (relations.length >= FOCUS_DEPTH_TWO_RELATION_LIMIT) break;
      relations.push(relation);
      relationIds.add(relation.id);
    }
  }

  return {
    ...payloadBase(index),
    page: { total: items.length, offset: 0, limit: itemLimit, hasMore: false },
    items,
    relations,
  };
}

function mapProjection(index) {
  const allItems = Array.isArray(index.items) ? index.items : [];
  const items = [];
  for (const provider of MAP_PROVIDERS) {
    for (const type of ITEM_TYPES) {
      items.push(...allItems
        .filter((item) => item?.source?.provider === provider && item.type === type)
        .sort(newestItemOrder)
        .slice(0, MAP_ITEMS_PER_TYPE_PROVIDER));
    }
  }
  const endpointIds = new Set(items.map((item) => item.id));
  const relations = (Array.isArray(index.relations) ? index.relations : []).filter((relation) => (
    endpointIds.has(relation.from) && endpointIds.has(relation.to)
  ));
  const providers = Object.fromEntries(MAP_PROVIDERS.map((provider) => [
    provider,
    items.filter((item) => item?.source?.provider === provider).length,
  ]));
  return {
    ...payloadBase(index),
    page: { total: items.length, offset: 0, limit: items.length, hasMore: false },
    providers,
    items,
    relations,
  };
}

export function projectBrainIndex(index, query = {}) {
  const focusId = queryString(query.focus);
  if (focusId) {
    const depth = queryString(query.depth).trim() === '2' ? 2 : 1;
    return focusProjection(index, focusId, depth);
  }
  if (queryString(query.view).trim().toLowerCase() === 'map') return mapProjection(index);

  const q = queryString(query.q).trim().slice(0, MAX_QUERY_LENGTH).toLowerCase();
  const requestedType = queryString(query.type).trim().toLowerCase();
  const type = ITEM_TYPES.has(requestedType) ? requestedType : '';
  const limit = boundedInteger(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = boundedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const allItems = Array.isArray(index.items) ? index.items : [];
  const filtered = allItems.filter((item) => (
    (!type || item.type === type) && (!q || searchableItemText(item).includes(q))
  ));
  const items = filtered.slice(offset, offset + limit);
  const endpointIds = new Set(items.map((item) => item.id));
  const relations = (Array.isArray(index.relations) ? index.relations : []).filter((relation) => (
    endpointIds.has(relation.from) && endpointIds.has(relation.to)
  ));

  return {
    ...payloadBase(index),
    page: {
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + items.length < filtered.length,
    },
    items,
    relations,
  };
}

export function createBrainRouter({
  indexLoader = loadLocalBrain,
  now = Date.now,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
} = {}) {
  const route = express.Router();
  const ttl = Number.isFinite(cacheTtlMs) && cacheTtlMs >= 0
    ? cacheTtlMs
    : DEFAULT_CACHE_TTL_MS;
  let cachedIndex;
  let hasCachedIndex = false;
  let expiresAt = 0;
  let inFlight = null;
  let cacheGeneration = 0;

  async function getFullIndex({ refresh = false } = {}) {
    if (refresh) {
      cachedIndex = undefined;
      hasCachedIndex = false;
      expiresAt = 0;
      if (!(inFlight?.refresh && inFlight.generation === cacheGeneration)) cacheGeneration += 1;
    }
    const current = Number(now());
    if (hasCachedIndex && Number.isFinite(current) && current < expiresAt) return cachedIndex;
    if (inFlight?.generation === cacheGeneration) return inFlight.promise;

    const generation = cacheGeneration;
    const pending = Promise.resolve().then(() => indexLoader());
    const activeBuild = { generation, refresh: Boolean(refresh), promise: pending };
    inFlight = activeBuild;
    try {
      const index = await pending;
      const completedAt = Number(now());
      if (generation === cacheGeneration) {
        cachedIndex = index;
        hasCachedIndex = true;
        expiresAt = (Number.isFinite(completedAt) ? completedAt : 0) + ttl;
      }
      return index;
    } finally {
      if (inFlight === activeBuild) inFlight = null;
    }
  }

  function unavailableWorkflow(projection, argument) {
    return { ...projection(EMPTY_WORKFLOW_INDEX, argument), unavailable: true };
  }

  async function workflowResponse(req, res, label, projection, argument) {
    try {
      const index = await getFullIndex();
      return res.status(200).json(projection(index, argument));
    } catch {
      console.warn(`[claudeos:brain] ${label} unavailable`);
      return res.status(200).json(unavailableWorkflow(projection, argument));
    }
  }

  route.get('/brain/resume', (req, res) => (
    workflowResponse(req, res, 'GET /brain/resume', resumeProjection, queryString(req.query.id))
  ));

  route.get('/brain/inbox', (req, res) => (
    workflowResponse(req, res, 'GET /brain/inbox', inboxProjection, queryString(req.query.since))
  ));

  route.get('/brain/ask', (req, res) => (
    workflowResponse(req, res, 'GET /brain/ask', askProjection, req.query)
  ));

  route.get('/brain/gaps', (req, res) => (
    workflowResponse(req, res, 'GET /brain/gaps', gapProjection)
  ));

  route.post('/brain/refresh', async (req, res) => {
    try {
      const index = await getFullIndex({ refresh: true });
      return res.status(200).json({ ...projectBrainIndex(index, {}), refreshed: true });
    } catch {
      console.warn('[claudeos:brain] POST /brain/refresh unavailable');
      return res.status(200).json({ ...emptyBrainPayload(), refreshed: true });
    }
  });

  route.get('/brain', async (req, res) => {
    try {
      const payload = await getFullIndex();
      return res.status(200).json(projectBrainIndex(payload, req.query));
    } catch {
      console.warn('[claudeos:brain] GET /brain unavailable');
      return res.status(200).json(emptyBrainPayload());
    }
  });

  return route;
}

export const router = createBrainRouter();
