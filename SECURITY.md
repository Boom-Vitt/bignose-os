# Security Policy

BIGNOSE OS is designed to run locally on `127.0.0.1` and to inspect only the
local `.claude` and `.codex` roots allowed by the application. Do not expose
port `4317` to the public internet and do not commit local knowledge, session
data, credentials, environment files, logs, or screenshots to a fork.

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories for
this repository. Do not include real credentials, private notes, session data,
or unredacted local paths in an issue.

## Public repository boundary

The public repository contains source code, documentation, and synthetic
developer fixtures only. It intentionally excludes real root-level `.claude/`
and `.codex/` state, along with `.impeccable/`, `.playwright-cli/`,
`.superpowers/`, `output/`, `node_modules/`, environment files, certificates,
logs, and browser artifacts. Files under `test/fixtures/project/.claude/` are
synthetic structure examples and contain no developer data. A local
installation indexes the installing user's own permitted files; it does not
receive the developer's local knowledge or index.
