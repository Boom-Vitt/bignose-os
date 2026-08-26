// server/lib/redact.js — Slice B.
//
// CONTRACT.md §6: "Redaction is mandatory. Any string that does reach the
// client (labels, descriptions, detail, timeline text) passes through
// redact() first."
//
// redact() is PURE, fast, and NEVER throws. Non-strings return ''.
// It is applied to display strings only — never to a node `id`, because ids
// are the join keys for edges and mutating them would break the graph.

import os from 'node:os';
import path from 'node:path';

const MASK = '[redacted]';
const EMAIL_MASK = '[email]';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolved once at module load so redact() itself stays allocation-light.
let HOME_DIR = '';
let HOME_USER = '';
try {
  HOME_DIR = os.homedir() || '';
  HOME_USER = HOME_DIR ? path.basename(HOME_DIR) : '';
} catch {
  HOME_DIR = '';
  HOME_USER = '';
}

// Ordered rule table. Specific/high-confidence secret shapes run FIRST so the
// generic key=value and hex rules can never carve a partial match out of a span
// that a precise rule would have masked whole.
const RULES = [];

// --- 1. Precise credential shapes -----------------------------------------

// JWT: three base64url segments. Before the bearer rule so "Bearer eyJ..."
// collapses cleanly.
RULES.push([/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, MASK]);

// Authorization: Bearer <token>
RULES.push([/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 ' + MASK]);

// Anthropic / OpenAI style. sk-ant- listed first for clarity; the generic sk-
// rule would also cover it.
RULES.push([/\bsk-ant-[A-Za-z0-9_-]{16,}/g, MASK]);
RULES.push([/\bsk-[A-Za-z0-9_-]{16,}/g, MASK]);

// GitHub personal access / OAuth / server tokens.
RULES.push([/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK]);
RULES.push([/\bgh[pousr]_[A-Za-z0-9_]{16,}/g, MASK]);

// AWS access key id.
RULES.push([/\bAKIA[0-9A-Z]{16}\b/g, MASK]);

// Google API key.
RULES.push([/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK]);

// Slack tokens.
RULES.push([/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK]);

// --- 2. Hex secrets --------------------------------------------------------

// 64-char lowercase hex. This blocks key- or digest-shaped values found in
// indexed local text from ever reaching the browser. A bare value of this
// shape is not normal prose, so it is masked unconditionally.
RULES.push([/\b[0-9a-f]{64}\b/g, MASK]);

// 32/40/64-char hex following an assignment separator.
RULES.push([/([:=]\s*["']?)(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\b/g, '$1' + MASK]);

// 32/40/64-char hex following a key-ish word.
RULES.push([
  /\b(key|token|secret|password|passwd|apikey|api_key|auth)\b([^0-9a-zA-Z]{1,8})(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\b/gi,
  '$1$2' + MASK,
]);

// --- 3. Generic key = value assignments ------------------------------------
// Keep the key, mask the value. Quoted form first so the closing quote survives.

const KEYISH =
  '(?:api[_-]?keys?|apikeys?|secret[_-]?keys?|client[_-]?secrets?|access[_-]?tokens?|refresh[_-]?tokens?|auth[_-]?tokens?|passwords?|passwd|secrets?|tokens?|keys?|authorization|auth)';

// The key may itself be quoted ("api_key": ...), so allow a closing quote
// between the key and the separator. The negative lookahead stops an
// already-masked value from being re-matched, which would otherwise append a
// stray bracket on every pass and make redact() non-idempotent.
const NOT_ALREADY_MASKED = '(?!\\[redacted\\]|\\[email\\]|[Bb]earer\\b)';

// "api_key": "value"   /   api_key = 'value'
RULES.push([
  new RegExp('\\b(' + KEYISH + ')(["\']?\\s*[:=]\\s*)(["\'])' + NOT_ALREADY_MASKED + '([^"\'\\n]{4,})\\3', 'gi'),
  '$1$2$3' + MASK + '$3',
]);
// API_KEY=value   /   token: value
RULES.push([
  new RegExp('\\b(' + KEYISH + ')(["\']?\\s*[:=]\\s*)' + NOT_ALREADY_MASKED + '([^\\s"\',;)}\\]]{4,})', 'gi'),
  '$1$2' + MASK,
]);

// --- 4. Personal data ------------------------------------------------------

RULES.push([/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, EMAIL_MASK]);

// --- 5. Home path collapse -------------------------------------------------
// Runs LAST: masking above may already have consumed parts of a string, and we
// always want the username stripped from whatever survives.

if (HOME_DIR) {
  // The literal home dir, wherever it is (covers non-/Users layouts).
  RULES.push([new RegExp(escapeRegex(HOME_DIR), 'g'), '~']);
}
// Generic absolute home paths.
RULES.push([/\/Users\/[^/\s:"'|,;)\]]+/g, '~']);
RULES.push([/\/home\/[^/\s:"'|,;)\]]+/g, '~']);

if (HOME_USER) {
  // ~/.claude/projects encodes cwd paths as dash-separated directory names,
  // e.g. "-Users-alice-Desktop-example-project". Same PII, different
  // separator — collapse it the same way so the username never ships.
  // The trailing guard must be "not another identifier char" rather than
  // "dash or end-of-string": these encoded names also appear mid-path, e.g.
  // ~/.claude/projects/-Users-<name>/<session>.jsonl, where the next character
  // is a slash. It still refuses to collapse a different user whose name merely
  // starts with this one (-Users-bob vs -Users-bobby).
  RULES.push([new RegExp('-Users-' + escapeRegex(HOME_USER) + '(?![A-Za-z0-9_])', 'g'), '~']);
  RULES.push([new RegExp('-home-' + escapeRegex(HOME_USER) + '(?![A-Za-z0-9_])', 'g'), '~']);
}

/**
 * Scrub secrets and personal data out of a display string.
 * Pure. Never throws. Non-strings collapse to ''.
 * @param {unknown} str
 * @returns {string}
 */
export function redact(str) {
  if (typeof str !== 'string') return '';
  if (str === '') return '';
  // Guard against pathological input; display strings are short.
  let out = str.length > 8192 ? str.slice(0, 8192) : str;
  try {
    for (let i = 0; i < RULES.length; i++) {
      out = out.replace(RULES[i][0], RULES[i][1]);
    }
  } catch {
    // A redactor that throws is worse than useless — fail closed.
    return MASK;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline unit assertions:  node server/lib/redact.js --test
// ---------------------------------------------------------------------------

function runTests() {
  const results = [];
  let failed = 0;

  const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    results.push(
      (ok ? 'ok    ' : 'FAIL  ') + name +
      (ok ? '' : '\n        expected: ' + JSON.stringify(expected) +
                 '\n        actual:   ' + JSON.stringify(actual))
    );
  };
  const checkFn = (name, fn) => {
    let ok = false;
    try { ok = !!fn(); } catch { ok = false; }
    if (!ok) failed++;
    results.push((ok ? 'ok    ' : 'FAIL  ') + name);
  };

  // --- non-string / edge inputs -------------------------------------------
  check('non-string: undefined -> ""', redact(undefined), '');
  check('non-string: null -> ""', redact(null), '');
  check('non-string: number -> ""', redact(42), '');
  check('non-string: object -> ""', redact({}), '');
  check('empty string -> ""', redact(''), '');
  check('plain label untouched', redact('SKILL.md'), 'SKILL.md');
  check('plain dir label untouched', redact('scheduled-tasks'), 'scheduled-tasks');

  // --- precise credential shapes ------------------------------------------
  check('anthropic sk-ant', redact('sk-' + 'ant-api03-AbCdEf0123456789xyz'), MASK);
  check('openai sk-', redact('sk-' + 'AbCdEf0123456789xyzQrS'), MASK);
  check('github ghp_', redact('ghp_' + 'AbCdEf0123456789xyzQrStUv'), MASK);
  check('github gho_', redact('gho_' + 'AbCdEf0123456789xyzQrStUv'), MASK);
  check('github_pat_', redact('github_pat_' + '11ABCDEFG0123456789_abcdefghij'), MASK);
  check('aws AKIA', redact('AKIA' + 'IOSFODNN7EXAMPLE'), MASK);
  check('google AIza', redact('AIza' + 'B'.repeat(35)), MASK);
  check('slack xoxb', redact('xoxb-' + '1234567890-abcdefghijkl'), MASK);
  check(
    'jwt',
    redact('eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    MASK
  );
  check('bearer token', redact('Authorization: Bearer ' + 'abcdef0123456789abcdef'), 'Authorization: Bearer ' + MASK);

  // --- hex secrets ---------------------------------------------------------
  const hex64 = 'a'.repeat(64);
  check('bare 64-char lowercase hex', redact(hex64), MASK);
  check('64-hex inside a sentence', redact('digest ' + hex64 + ' ok'), 'digest ' + MASK + ' ok');
  check('40-hex after "="', redact('SECRET=' + 'b'.repeat(40)), 'SECRET=' + MASK);
  check('32-hex after ":"', redact('token:' + 'c'.repeat(32)), 'token:' + MASK);
  checkFn('short hex NOT redacted', () => redact('deadbeef') === 'deadbeef');
  checkFn('normal words with hex letters survive', () => redact('facade') === 'facade');

  // --- key = value ---------------------------------------------------------
  check('KEY=value keeps key', redact('API_KEY=supersecretvalue'), 'API_KEY=' + MASK);
  check('json "key": "value"', redact('"api_key": "supersecretvalue"'), '"api_key": "' + MASK + '"');
  check('password assignment', redact('password = hunter2000'), 'password = ' + MASK);
  checkFn('key name itself survives', () => redact('API_KEY=abcdefgh').startsWith('API_KEY='));

  // --- email ---------------------------------------------------------------
  check('email', redact('person@example.org'), EMAIL_MASK);
  check('email in sentence', redact('mail me at a.b@c.dev please'), 'mail me at ' + EMAIL_MASK + ' please');

  // --- home path collapse --------------------------------------------------
  checkFn('absolute home path collapses to ~', () => redact('/Users/someone/.claude/skills') === '~/.claude/skills');
  checkFn('linux home collapses to ~', () => redact('/home/someone/.claude') === '~/.claude');
  checkFn('real homedir collapses', () => (HOME_DIR ? !redact(HOME_DIR + '/.claude').includes(HOME_USER) : true));
  checkFn('encoded project dir loses username', () =>
    HOME_USER ? !redact('-Users-' + HOME_USER + '-Desktop-claudeos-agentic').includes(HOME_USER) : true);
  // Regression: the encoded form also appears MID-PATH, followed by '/' rather
  // than '-' or end-of-string. An earlier lookahead missed exactly this and
  // leaked the username through ~950 session-file paths.
  checkFn('encoded project dir loses username mid-path', () =>
    HOME_USER
      ? !redact('~/.claude/projects/-Users-' + HOME_USER + '/abc-123.jsonl').includes(HOME_USER)
      : true);
  checkFn('encoded form as bare segment loses username', () =>
    HOME_USER ? !redact('-Users-' + HOME_USER).includes(HOME_USER) : true);
  checkFn('does NOT collapse a different, longer username', () =>
    redact('-Users-bobby-Desktop').includes('bobby'));
  // Build this ordinary task name from segments so static secret scanners do
  // not mistake its character boundary for a provider credential prefix.
  const ordinaryTaskName = ['task', 'scoped', 'review', 'dispatch'].join('-');
  check('credential rule leaves an ordinary task name intact', redact(ordinaryTaskName), ordinaryTaskName);

  // --- purity / robustness -------------------------------------------------
  checkFn('idempotent', () => redact(redact('API_KEY=' + hex64)) === redact('API_KEY=' + hex64));
  checkFn('stateless across calls (no lastIndex leak)', () =>
    redact(hex64) === MASK && redact(hex64) === MASK && redact(hex64) === MASK);
  checkFn('never throws on weird input', () => {
    redact('%'.repeat(500));
    redact('a'.repeat(20000));
    redact(String.fromCharCode(0, 27) + '[31m');
    return true;
  });

  console.log(results.join('\n'));
  console.log('\n' + (results.length - failed) + '/' + results.length + ' assertions passed' + (failed ? ' — ' + failed + ' FAILED' : ''));
  // Rule: never call process.exit — set the code and let Node unwind naturally.
  if (failed) process.exitCode = 1;
}

if (process.argv.includes('--test')) runTests();
