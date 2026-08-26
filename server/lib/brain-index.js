import fs from 'node:fs/promises';
import path from 'node:path';

import { parseFrontmatter } from './frontmatter.js';
import { redact } from './redact.js';

const STATUSES = new Set(['active', 'next', 'blocked', 'done', 'reference', 'unknown']);
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_EXTRACTED_TASKS = 50;
const MAX_CANDIDATES = 40;
const TYPE_ALIASES = new Map([
  ['project', 'project'],
  ['person', 'person'],
  ['user', 'person'],
  ['idea', 'idea'],
  ['decision', 'decision'],
  ['task', 'task'],
  ['note', 'note'],
  ['memory', 'note'],
  ['feedback', 'note'],
  ['source', 'source'],
  ['reference', 'source'],
]);
// The semantic index is intentionally narrower than the filesystem graph.
// Generated tools, plugin caches, and temporary work stay visible in /api/graph
// but never become projects, tasks, or sources in the user's knowledge summary.
const CLAUDE_ROOT_KNOWLEDGE_DIRS = new Set(['memory', 'memories', 'notes', 'rules']);
const CLAUDE_PROJECT_KNOWLEDGE_DIRS = new Set(['memory', 'memories', 'notes']);
const CODEX_MEMORY_DIRS = new Set(['extensions', 'rollout_summaries']);
const CODEX_MEMORY_FILES = new Set(['memory.md', 'memory_summary.md']);
const SEMANTIC_DIRECTORY_TYPES = new Map([
  ['people', 'person'],
  ['persons', 'person'],
  ['ideas', 'idea'],
  ['decisions', 'decision'],
  ['tasks', 'task'],
  ['todos', 'task'],
  ['notes', 'note'],
  ['sources', 'source'],
  ['references', 'source'],
]);

function compareId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function displayString(value) {
  return redact(typeof value === 'string' ? value : '');
}

function cleanInlineMarkdown(value) {
  return displayString(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_all, target, label) => label || target)
    .replace(/<https?:\/\/[^>]+>/gi, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bounded(value, limit) {
  const text = displayString(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function normalizedType(value) {
  const type = displayString(value).trim().toLowerCase();
  return TYPE_ALIASES.get(type) ?? null;
}

function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function metadataRecord(data) {
  return objectRecord(objectRecord(data).metadata);
}

function semanticValue(data, key) {
  const root = objectRecord(data);
  if (Object.hasOwn(root, key)) return root[key];
  return metadataRecord(root)[key];
}

function defaultTypeForPath(provider, relativePath) {
  const parts = String(relativePath).split('/').filter(Boolean);
  const first = parts[0]?.toLowerCase();
  const directoryType = SEMANTIC_DIRECTORY_TYPES.get(first);
  if (directoryType) return directoryType;
  if (first === 'projects' && parts.length === 2) return 'project';
  if (provider === 'claude' && parts[0]?.toLowerCase() === 'plans') return 'note';
  if (provider === 'codex' && parts[0]?.toLowerCase() === 'memories') return 'note';
  return null;
}

function documentType(data, provider, relativePath) {
  const root = objectRecord(data);
  const metadata = metadataRecord(root);
  const explicit = normalizedType(root.type);
  if (explicit) return explicit;
  const nested = normalizedType(metadata.type);
  if (nested) return nested;
  if (displayString(metadata.node_type).trim().toLowerCase() === 'memory') return 'note';
  return defaultTypeForPath(provider, relativePath);
}

function extractsTasks(data) {
  return objectRecord(objectRecord(data).semantic).extract_tasks === true;
}

function normalizedStatus(value) {
  const status = displayString(value).trim().toLowerCase();
  return STATUSES.has(status) ? status : 'unknown';
}

function normalizedTags(value) {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const tags = [];
  const seen = new Set();
  for (const entry of input) {
    const tag = displayString(String(entry)).trim().toLowerCase().slice(0, 40).trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length === 12) break;
  }
  return tags;
}

function firstTitle(body, relativePath) {
  const match = String(body).match(/^\s*#\s+(.+?)\s*$/m);
  if (match) return bounded(cleanInlineMarkdown(match[1]), 160);
  return bounded(path.basename(relativePath, path.extname(relativePath)).replace(/[-_]+/g, ' '), 160);
}

function firstProseParagraph(body) {
  const lines = String(body).split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line || /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)/.test(line)) {
      index += 1;
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim()) {
      const next = lines[index].trim();
      if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)/.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    const prose = cleanInlineMarkdown(paragraph.join(' '));
    if (prose) return bounded(prose, 240);
    index += 1;
  }
  return '';
}

function documentId(provider, relativePath) {
  return `${provider}/${relativePath}`;
}

function taskRows(body) {
  const tasks = [];
  const pattern = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/gm;
  const visibleLines = [];
  let fence = null;
  for (const line of String(body).split(/\r\n|\r|\n/)) {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})(.*)$/);
    if (marker) {
      const family = marker[1][0];
      const length = marker[1].length;
      if (fence === null) fence = { family, length };
      else if (fence.family === family && length >= fence.length && marker[2].trim() === '') fence = null;
      continue;
    }
    if (fence === null) visibleLines.push(line);
  }
  let match;
  while ((match = pattern.exec(visibleLines.join('\n'))) !== null) {
    const title = bounded(cleanInlineMarkdown(match[2]), 160);
    if (title) tasks.push({ checked: match[1].toLowerCase() === 'x', title });
    if (tasks.length === MAX_EXTRACTED_TASKS) break;
  }
  return tasks;
}

function linkTargets(body) {
  const targets = [];
  const markdown = /(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  const wiki = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = markdown.exec(String(body))) !== null) targets.push({ kind: 'markdown', target: match[1] });
  while ((match = wiki.exec(String(body))) !== null) targets.push({ kind: 'wiki', target: match[1] });
  return targets;
}

function normalizedLinkPath(fromRelativePath, rawTarget) {
  let target = displayString(rawTarget).trim().replace(/^<|>$/g, '');
  if (!target || target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    return null;
  }
  target = target.split('#', 1)[0].split('?', 1)[0];
  try { target = decodeURIComponent(target); } catch { return null; }
  if (!path.posix.extname(target)) target += '.md';
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelativePath), target));
  if (relative === '..' || relative.startsWith('../')) return null;
  return relative.replace(/^\.\//, '');
}

function relation(from, to, type, label, evidence, confidence = 1) {
  return {
    id: `${from}->${to}:${type}`,
    from,
    to,
    type,
    label: bounded(label, 160),
    evidence,
    confidence,
  };
}

function summaryFor(items) {
  const summary = {
    items: items.length,
    projects: 0,
    people: 0,
    ideas: 0,
    decisions: 0,
    tasks: 0,
    notes: 0,
    sources: 0,
    needsAttention: 0,
  };
  const plural = {
    project: 'projects', person: 'people', idea: 'ideas', decision: 'decisions',
    task: 'tasks', note: 'notes', source: 'sources',
  };
  for (const item of items) {
    summary[plural[item.type]] += 1;
    if (item.status === 'next' || item.status === 'blocked') summary.needsAttention += 1;
  }
  return summary;
}

function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function malformedMarkdown(raw) {
  if (raw.includes('\0')) return true;
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = clean.split(/\r\n|\r|\n/);
  const opening = lines.findIndex((line) => line.trim() !== '');
  if (opening < 0 || lines[opening].trim() !== '---') return false;
  return !lines.slice(opening + 1).some((line) => /^(?:---|\.\.\.)\s*$/.test(line.trim()));
}

function pathParts(relativePath) {
  return String(relativePath).split(/[\\/]+/).filter(Boolean);
}

function isTemporaryClaudeProject(name) {
  return /^-private-(?:var-|tmp(?:-|$))/i.test(String(name));
}

function shouldWalkKnowledgeDirectory(provider, relativePath) {
  const parts = pathParts(relativePath);
  if (parts.length === 0) return true;
  const first = parts[0].toLowerCase();

  if (provider === 'claude') {
    if (first === 'plans') return true;
    if (CLAUDE_ROOT_KNOWLEDGE_DIRS.has(first)) return true;
    if (SEMANTIC_DIRECTORY_TYPES.has(first)) return true;
    if (first !== 'projects') return false;
    if (parts.length === 1) return true;
    if (isTemporaryClaudeProject(parts[1])) return false;
    if (parts.length === 2) return true;
    return CLAUDE_PROJECT_KNOWLEDGE_DIRS.has(parts[2].toLowerCase());
  }

  if (provider === 'codex') {
    if (SEMANTIC_DIRECTORY_TYPES.has(first)) return true;
    if (first !== 'memories') return false;
    if (parts.length === 1) return true;
    return CODEX_MEMORY_DIRS.has(parts[1].toLowerCase());
  }

  return false;
}

function shouldCollectKnowledgeFile(provider, relativePath) {
  const parts = pathParts(relativePath);
  // Root Markdown is cheap to inspect and is included only when its frontmatter
  // resolves to a known semantic type; untyped provider instructions still drop out.
  if (parts.length === 1) return true;
  if (provider === 'claude') {
    const first = parts[0]?.toLowerCase();
    if (first === 'plans' || CLAUDE_ROOT_KNOWLEDGE_DIRS.has(first) || SEMANTIC_DIRECTORY_TYPES.has(first)) return true;
    if (first !== 'projects') return false;
    if (parts.length === 2) {
      const projectName = path.basename(parts[1], path.extname(parts[1]));
      return !isTemporaryClaudeProject(projectName);
    }
    return parts.length >= 4
      && !isTemporaryClaudeProject(parts[1])
      && CLAUDE_PROJECT_KNOWLEDGE_DIRS.has(parts[2]?.toLowerCase());
  }
  if (provider === 'codex') {
    const first = parts[0]?.toLowerCase();
    if (SEMANTIC_DIRECTORY_TYPES.has(first)) return true;
    if (first !== 'memories') return false;
    if (parts.length === 2) return CODEX_MEMORY_FILES.has(parts[1].toLowerCase());
    return parts.length >= 3 && CODEX_MEMORY_DIRS.has(parts[1]?.toLowerCase());
  }
  return false;
}

async function collectMarkdownFiles(root, { provider, stat, readdir, realpath, lstat }) {
  const found = [];
  let rootLinkStat;
  try { rootLinkStat = await lstat(root); } catch { return found; }
  if (rootLinkStat?.isSymbolicLink?.()) return found;
  let canonicalRoot;
  try { canonicalRoot = await realpath(root); } catch { return found; }
  let rootStat;
  try { rootStat = await stat(root); } catch { return found; }
  if (rootStat?.isFile?.()) {
    if (path.extname(root).toLowerCase() === '.md' && pathWithin(canonicalRoot, canonicalRoot)) {
      found.push({ absolutePath: canonicalRoot, relativePath: path.basename(root), stat: rootStat });
    }
    return found;
  }
  if (!rootStat?.isDirectory?.()) return found;

  async function walk(directory) {
    let canonicalDirectory;
    try { canonicalDirectory = await realpath(directory); } catch { return; }
    if (!pathWithin(canonicalRoot, canonicalDirectory)) return;
    let entries;
    try { entries = await readdir(canonicalDirectory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || entry.isSymbolicLink?.()) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (entry.isDirectory?.()) {
        if (!shouldWalkKnowledgeDirectory(provider, relativePath)) continue;
        await walk(absolutePath);
      } else if (entry.isFile?.() && path.extname(entry.name).toLowerCase() === '.md') {
        if (!shouldCollectKnowledgeFile(provider, relativePath)) continue;
        let fileStat;
        try { fileStat = await stat(absolutePath); } catch { continue; }
        let canonicalFile;
        try { canonicalFile = await realpath(absolutePath); } catch { continue; }
        if (!pathWithin(canonicalRoot, canonicalFile)) continue;
        found.push({
          absolutePath: canonicalFile,
          relativePath,
          stat: fileStat,
        });
      }
    }
  }
  await walk(root);
  return found;
}

export async function buildBrainIndex({
  sources = [],
  readFile = fs.readFile,
  stat = fs.stat,
  readdir = fs.readdir,
  realpath = fs.realpath,
  lstat = fs.lstat,
  now = Date.now,
} = {}) {
  const builtAt = Number(now());
  const documents = [];
  const candidates = [];

  for (const source of Array.isArray(sources) ? sources : []) {
    const provider = source?.provider === 'codex' ? 'codex' : source?.provider === 'claude' ? 'claude' : null;
    const root = typeof source?.root === 'string' ? path.resolve(source.root) : null;
    if (!provider || !root) continue;
    const files = await collectMarkdownFiles(root, { provider, stat, readdir, realpath, lstat });
    for (const file of files) {
      const fileSize = Number(file.stat?.size);
      if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > MAX_SOURCE_BYTES) continue;
      let raw;
      try { raw = await readFile(file.absolutePath, 'utf8'); } catch { continue; }
      if (typeof raw !== 'string' || malformedMarkdown(raw)) continue;
      const relativePath = displayString(file.relativePath.split(path.sep).join('/')).replace(/^\/+/, '');
      if (!relativePath) continue;
      const parsed = parseFrontmatter(raw);
      const type = documentType(parsed.data, provider, relativePath);
      const modifiedAt = Number.isFinite(file.stat?.mtimeMs) ? Math.max(0, Math.round(file.stat.mtimeMs)) : 0;
      if (!type) {
        candidates.push({
          id: `candidate:${provider}/${relativePath}`,
          title: firstTitle(parsed.body, relativePath),
          summary: firstProseParagraph(parsed.body),
          updatedAt: modifiedAt,
          reason: 'missing-type',
          source: { provider, path: relativePath, modifiedAt },
        });
        continue;
      }
      const title = firstTitle(parsed.body, relativePath);
      const projectValue = semanticValue(parsed.data, 'project');
      const project = typeof projectValue === 'string'
        ? bounded(projectValue, 160) || null
        : null;
      const item = {
        id: documentId(provider, relativePath),
        type,
        title,
        summary: firstProseParagraph(parsed.body),
        project,
        status: normalizedStatus(semanticValue(parsed.data, 'status')),
        tags: normalizedTags(semanticValue(parsed.data, 'tags')),
        updatedAt: modifiedAt,
        source: { provider, path: relativePath, modifiedAt },
      };
      documents.push({
        item,
        body: parsed.body,
        relativePath,
        extractsTasks: extractsTasks(parsed.data),
      });
    }
  }

  documents.sort((a, b) => compareId(a.item, b.item));
  const items = [];
  const relations = [];
  const documentsByPath = new Map(documents.map((document) => [
    `${document.item.source.provider}:${document.relativePath}`,
    document,
  ]));
  const documentsByTitle = new Map();
  for (const document of documents) {
    const key = `${document.item.source.provider}:${document.item.title.toLowerCase()}`;
    if (!documentsByTitle.has(key)) documentsByTitle.set(key, document);
  }

  for (const document of documents) {
    items.push(document.item);
    const tasks = document.extractsTasks ? taskRows(document.body) : [];
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      const taskItem = {
        id: `${document.item.id}#task-${index + 1}`,
        type: 'task',
        title: task.title,
        summary: bounded(`Task from ${document.item.title}`, 240),
        project: document.item.project || document.item.title || null,
        status: task.checked ? 'done' : 'next',
        tags: [...document.item.tags],
        updatedAt: document.item.updatedAt,
        source: { ...document.item.source },
      };
      items.push(taskItem);
      relations.push(relation(
        taskItem.id,
        document.item.id,
        'belongs-to',
        `Belongs to ${document.item.title}`,
        'declared',
      ));
    }
  }

  for (const document of documents) {
    const seen = new Set();
    for (const link of linkTargets(document.body)) {
      const targetPath = normalizedLinkPath(document.relativePath, link.target);
      let target = targetPath
        ? documentsByPath.get(`${document.item.source.provider}:${targetPath}`)
        : null;
      if (!target && link.kind === 'wiki') {
        target = documentsByTitle.get(
          `${document.item.source.provider}:${cleanInlineMarkdown(link.target).toLowerCase()}`,
        );
      }
      if (!target || target.item.id === document.item.id || seen.has(target.item.id)) continue;
      seen.add(target.item.id);
      relations.push(relation(
        document.item.id,
        target.item.id,
        'mentions',
        `Mentions ${target.item.title}`,
        'explicit-link',
      ));
    }
  }

  const explicitPairs = new Set(relations
    .filter((entry) => entry.evidence === 'explicit-link')
    .map((entry) => [entry.from, entry.to].sort().join('\0')));
  const projectGroups = new Map();
  for (const document of documents) {
    if (!document.item.project) continue;
    const key = document.item.project.toLowerCase();
    if (!projectGroups.has(key)) projectGroups.set(key, []);
    projectGroups.get(key).push(document.item);
  }
  for (const group of projectGroups.values()) {
    group.sort(compareId);
    for (let left = 0; left < group.length; left++) {
      for (let right = left + 1; right < group.length; right++) {
        const pairKey = [group[left].id, group[right].id].sort().join('\0');
        if (explicitPairs.has(pairKey)) continue;
        relations.push(relation(
          group[left].id,
          group[right].id,
          'related-to',
          `Shares project ${group[left].project}`,
          'shared-project',
          0.75,
        ));
      }
    }
  }

  items.sort(compareId);
  relations.sort(compareId);
  return {
    schema: 1,
    builtAt: Number.isFinite(builtAt) && builtAt >= 0 ? builtAt : 0,
    summary: summaryFor(items),
    items,
    relations,
    candidates: candidates.sort(compareId).slice(0, MAX_CANDIDATES),
  };
}
