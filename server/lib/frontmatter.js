// server/lib/frontmatter.js — Slice D · catalog
//
// Dependency-free YAML-subset parser for the `---` fenced block at the top of a
// markdown file. Deliberately NOT a full YAML implementation: it covers exactly
// the shapes that appear in Claude Code SKILL.md / agent frontmatter.
//
// Supported:
//   key: value                      plain scalars, type-coerced
//   key: "…" / key: '…'             quoted scalars, may span lines, escapes decoded
//   key: [a, b]                     inline flow sequences
//   key: {a: b}                     inline flow mappings
//   key:\n  - item                  block sequences
//   key:\n  sub: value              nested mappings -> NESTED OBJECTS (documented choice,
//                                   e.g. `metadata: {author, version, category}`)
//   key: |  /  key: >               block scalars, with -/+ chomping indicators
//   # comment                       comments outside quotes
//
// Coercion: true/false -> boolean, `null`/`~`/empty -> null, bare integers -> number,
// everything else stays a string. Floats stay strings on purpose ("1.9.9" and "1.0"
// are version-ish in this corpus, not arithmetic).
//
// parseFrontmatter NEVER throws. No frontmatter -> { data: {}, body: text }.

const FENCE = /^(---|\.\.\.)\s*$/;

/** Decode the escape sequences YAML allows inside a double-quoted scalar. */
function decodeEscapes(raw, allowFull) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[i + 1];
    if (next === undefined) { out += ch; break; }
    i++;
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '0': out += '\0'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case '/': out += '/'; break;
      case '\\': out += '\\'; break;
      case 'u': {
        if (!allowFull) { out += '\\u'; break; }
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
        else out += '\\u';
        break;
      }
      case 'x': {
        if (!allowFull) { out += '\\x'; break; }
        const hex = raw.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; }
        else out += '\\x';
        break;
      }
      default:
        // Unknown escape: keep it verbatim rather than silently eating the backslash.
        out += '\\' + next;
    }
  }
  return out;
}

/** Coerce a bare (unquoted) scalar to boolean / null / number / string. */
function coerceScalar(raw) {
  const s = String(raw).trim();
  if (s === '' || s === '~') return null;
  const lower = s.toLowerCase();
  if (lower === 'null') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^[+-]?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
    return s;
  }
  return s;
}

/**
 * Strip a trailing `# comment` from a plain scalar. YAML only starts a comment
 * at a `#` that is at the start or preceded by whitespace.
 */
function stripPlainComment(s) {
  if (s.startsWith('#')) return '';
  const m = s.match(/\s#/);
  if (!m) return s;
  return s.slice(0, m.index);
}

/**
 * Read a quoted scalar starting at lines[i], column `col`.
 * Handles values that continue across physical lines until the closing quote.
 * Returns { value, nextIndex, rest } where `rest` is whatever followed the
 * closing quote on its line.
 */
function readQuoted(lines, i, col) {
  const quote = lines[i][col];
  const dq = quote === '"';
  let buf = '';
  let li = i;
  let c = col + 1;
  while (li < lines.length) {
    const line = lines[li];
    while (c < line.length) {
      const ch = line[c];
      if (dq && ch === '\\') { buf += ch + (line[c + 1] ?? ''); c += 2; continue; }
      if (ch === quote) {
        if (!dq && line[c + 1] === quote) { buf += "'"; c += 2; continue; } // '' escape
        const decoded = dq ? decodeEscapes(buf, true) : decodeEscapes(buf, false);
        return { value: decoded, nextIndex: li + 1, rest: line.slice(c + 1).trim() };
      }
      buf += ch; c++;
    }
    // Unterminated on this line: YAML folds the newline to a space.
    li++; c = 0;
    if (li < lines.length) buf += ' ' + lines[li].trim().replace(/^/, '');
    if (li < lines.length) { c = lines[li].length; }
  }
  const decoded = dq ? decodeEscapes(buf, true) : decodeEscapes(buf, false);
  return { value: decoded, nextIndex: lines.length, rest: '' };
}

/** Split a flow (`[…]` / `{…}`) body on top-level commas, honouring quotes/nesting. */
function splitFlow(src) {
  const parts = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && quote === '"') { buf += src[i + 1] ?? ''; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[' || ch === '{') { depth++; buf += ch; continue; }
    if (ch === ']' || ch === '}') { depth--; buf += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim() !== '') parts.push(buf);
  return parts;
}

/** Parse one flow item / scalar that is already on a single line. */
function parseInlineValue(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if (s[0] === '[' && s[s.length - 1] === ']') {
    return splitFlow(s.slice(1, -1)).map((p) => parseInlineValue(p));
  }
  if (s[0] === '{' && s[s.length - 1] === '}') {
    const obj = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const idx = findKeySplit(part);
      if (idx < 0) continue;
      const k = parseInlineValue(part.slice(0, idx));
      obj[String(k)] = parseInlineValue(part.slice(idx + 1));
    }
    return obj;
  }
  if (s[0] === '"' || s[0] === "'") {
    const r = readQuoted([s], 0, 0);
    return r.value;
  }
  return coerceScalar(stripPlainComment(s));
}

/**
 * Index of the `:` that separates key from value on a line, or -1.
 * YAML requires the colon be followed by a space or end-of-line; quoted keys
 * are scanned past so a colon *inside* the key does not split.
 */
function findKeySplit(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (line[i] === '"' || line[i] === "'") {
    const q = line[i];
    i++;
    while (i < line.length) {
      if (line[i] === '\\' && q === '"') { i += 2; continue; }
      if (line[i] === q) { i++; break; }
      i++;
    }
    while (i < line.length && line[i] === ' ') i++;
    return line[i] === ':' ? i : -1;
  }
  for (; i < line.length; i++) {
    if (line[i] === ':' && (i + 1 >= line.length || line[i + 1] === ' ' || line[i + 1] === '\t')) return i;
  }
  return -1;
}

function indentOf(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function isBlankOrComment(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** Consume a `|` / `>` block scalar. */
function readBlockScalar(lines, i, parentIndent, header) {
  const style = header[0];                       // '|' or '>'
  const chomp = /[-+]/.test(header) ? header.match(/[-+]/)[0] : '';
  const explicit = header.match(/(\d+)/);
  const collected = [];
  let blockIndent = explicit ? parentIndent + Number(explicit[1]) : -1;
  let li = i;
  while (li < lines.length) {
    const line = lines[li];
    if (line.trim() === '') { collected.push(''); li++; continue; }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (blockIndent < 0) blockIndent = ind;
    if (ind < blockIndent) break;
    collected.push(line.slice(blockIndent));
    li++;
  }
  while (collected.length && collected[collected.length - 1] === '') collected.pop();
  let value;
  if (style === '>') {
    // Folded: join non-blank runs with a space; blank lines become newlines.
    const out = [];
    let run = [];
    for (const l of collected) {
      if (l === '') { if (run.length) { out.push(run.join(' ')); run = []; } out.push(''); }
      else if (l.startsWith(' ')) { if (run.length) { out.push(run.join(' ')); run = []; } out.push(l); }
      else run.push(l);
    }
    if (run.length) out.push(run.join(' '));
    value = out.join('\n');
  } else {
    value = collected.join('\n');
  }
  if (chomp === '+') value += '\n';
  else if (chomp !== '-' && value !== '') value += '\n';
  return { value, nextIndex: li };
}

/** Look ahead for the indent of the next content line; -1 when none remains. */
function nextContentIndent(lines, i) {
  for (let k = i; k < lines.length; k++) {
    if (isBlankOrComment(lines[k])) continue;
    return indentOf(lines[k]);
  }
  return -1;
}

function parseSequence(lines, start, indent) {
  const arr = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankOrComment(line)) { i++; continue; }
    const ind = indentOf(line);
    if (ind !== indent || !/^-(\s|$)/.test(line.slice(ind))) break;
    const rest = line.slice(ind + 1).trim();
    if (rest === '') {
      const childIndent = nextContentIndent(lines, i + 1);
      if (childIndent > indent) {
        const sub = parseMapping(lines, i + 1, childIndent);
        arr.push(sub.value); i = sub.nextIndex; continue;
      }
      arr.push(null); i++; continue;
    }
    // `- key: value` -> a mapping whose first key sits at ind+2
    if (findKeySplit(rest) >= 0 && rest[0] !== '"' && rest[0] !== "'" && rest[0] !== '{' && rest[0] !== '[') {
      const inner = [line.slice(0, ind) + '  ' + rest, ...lines.slice(i + 1)];
      const sub = parseMapping(inner, 0, ind + 2);
      arr.push(sub.value);
      i = i + sub.nextIndex;
      continue;
    }
    if (rest[0] === '"' || rest[0] === "'") {
      const q = readQuoted(lines, i, line.length - line.slice(ind + 1).trimStart().length);
      arr.push(q.value); i = q.nextIndex; continue;
    }
    arr.push(parseInlineValue(rest));
    i++;
  }
  return { value: arr, nextIndex: i };
}

function parseMapping(lines, start, indent) {
  const obj = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankOrComment(line)) { i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) { i++; continue; }               // stray over-indent: skip
    if (/^-(\s|$)/.test(line.slice(ind))) break;       // sequence, not our mapping

    const split = findKeySplit(line);
    if (split < 0) { i++; continue; }

    const rawKey = line.slice(ind, split).trim();
    const key = (rawKey[0] === '"' || rawKey[0] === "'") ? readQuoted([rawKey], 0, 0).value : rawKey;
    const rest = line.slice(split + 1).trim();

    if (rest === '') {
      const childIndent = nextContentIndent(lines, i + 1);
      if (childIndent > ind) {
        const childLine = lines.slice(i + 1).find((l) => !isBlankOrComment(l)) || '';
        if (/^-(\s|$)/.test(childLine.slice(childIndent))) {
          const seq = parseSequence(lines, i + 1, childIndent);
          obj[key] = seq.value; i = seq.nextIndex; continue;
        }
        const sub = parseMapping(lines, i + 1, childIndent);
        obj[key] = sub.value; i = sub.nextIndex; continue;
      }
      // A block sequence may also sit at the SAME indent as its key.
      const sameLine = lines.slice(i + 1).find((l) => !isBlankOrComment(l)) || '';
      if (childIndent === ind && /^-(\s|$)/.test(sameLine.slice(ind))) {
        const seq = parseSequence(lines, i + 1, ind);
        obj[key] = seq.value; i = seq.nextIndex; continue;
      }
      obj[key] = null; i++; continue;
    }

    if (/^[|>][-+]?\d*\s*$/.test(rest)) {
      const blk = readBlockScalar(lines, i + 1, ind, rest);
      obj[key] = blk.value; i = blk.nextIndex; continue;
    }

    if (rest[0] === '"' || rest[0] === "'") {
      const col = line.indexOf(rest[0], split + 1);
      const q = readQuoted(lines, i, col);
      obj[key] = q.value; i = q.nextIndex; continue;
    }

    if (rest[0] === '[' || rest[0] === '{') {
      // Flow collections may wrap; accumulate until brackets balance.
      let acc = rest; let li = i;
      const open = rest[0]; const close = open === '[' ? ']' : '}';
      while (li + 1 < lines.length && countUnbalanced(acc, open, close) > 0) { li++; acc += ' ' + lines[li].trim(); }
      obj[key] = parseInlineValue(acc); i = li + 1; continue;
    }

    obj[key] = coerceScalar(stripPlainComment(rest));
    i++;
  }
  return { value: obj, nextIndex: i };
}

function countUnbalanced(s, open, close) {
  let depth = 0; let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\' && quote === '"') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) depth--;
  }
  return depth;
}

/**
 * parseFrontmatter(text) -> { data: object, body: string }
 * Never throws. Returns { data: {}, body: text } when there is no frontmatter.
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return { data: {}, body: '' };
  try {
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const lines = clean.split(/\r\n|\r|\n/);

    let open = 0;
    while (open < lines.length && lines[open].trim() === '') open++;
    if (open >= lines.length || lines[open].trim() !== '---') return { data: {}, body: text };

    let close = -1;
    for (let i = open + 1; i < lines.length; i++) {
      if (FENCE.test(lines[i])) { close = i; break; }
    }
    if (close < 0) return { data: {}, body: text };

    const block = lines.slice(open + 1, close);
    const baseIndent = nextContentIndent(block, 0);
    const data = baseIndent < 0 ? {} : parseMapping(block, 0, baseIndent).value;
    const body = lines.slice(close + 1).join('\n');
    return { data: data && typeof data === 'object' ? data : {}, body };
  } catch {
    return { data: {}, body: text };
  }
}
