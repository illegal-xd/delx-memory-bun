# Upstream divergences (bun fork)

Deliberate places where this bun fork differs from
[`davidmosiah/delx-memory`](https://github.com/davidmosiah/delx-memory).
Each entry records **what** differs, **why**, **how it is covered by tests**, and
**how to reconcile** when upstream catches up.

Baseline for the entries below: upstream `dc6d936` (0.4.2 release). Entries 1–2
were written against upstream `4e45921`; entries 5–8 record what the 0.4.2 port
deliberately did not copy.

## 1. Namespace scoping uses `instr`, also on the read paths

| | |
|---|---|
| Status | Upstream fixed the list/handoff half in `d134735` (0.4.2); fork keeps the shared helper |
| Files | `src/services/db.ts`, `src/tools/memory-tools.ts` |
| Upstream ref | `b28224c` — *fix: isolate memory export and tag deletion by namespace* |

Upstream fixed `memory_export` and `memory_forget_by_tag` by adding
`instr(key, ?) = 1` with the literal `namespace::` prefix. `memory_list` and
`memory_handoff` kept using `key LIKE 'ns::%'`, and SQLite's `LIKE` is ASCII
case-insensitive, so with `DELX_MEMORY_NAMESPACE=team` they also returned rows
from `TEAM::…`. Repro (pre-fix): `memory_list` under `ns=team` returned
`TEAM::upper-only` while `memory_export` correctly returned only the `team::`
row.

Change:

- new `namespaceKeyPrefix()` in `src/services/db.ts` — the single source of the
  literal `ns::` prefix (`instr`-compatible: no LIKE escaping, case-sensitive).
- `memory_list` and `memory_handoff` now filter with `instr(key, ?) = 1`.
- `memory_export` / `memory_forget_by_tag` use the same helper (behaviour
  identical to upstream, expression de-duplicated).

Not changed: `memory_search` already post-filters with case-sensitive
`startsWith`, and `memory_stats` is intentionally store-wide.

Tests: `scripts/test-bulk-tag-delete.mjs` → `list and handoff isolate namespace
team from TEAM` (fails on the upstream code path, passes here).

Reconcile: upstream now uses `instr` on `memory_list`/`memory_handoff` as well.
The fork keeps `namespaceKeyPrefix()` because five call sites share it (list,
handoff, export, forget-by-tag, search); renaming to upstream's inline
`${namespace}::` form is cosmetic and not worth a churn diff. The fork-only test
case stays: it now passes against both implementations.

## 2. Test script goes beyond the upstream fixture

`scripts/test-bulk-tag-delete.mjs` is upstream's `node:test` rewrite plus one
fork-only case (entry 1). The `team_%\lab` vs `teamXYlab` pair does not catch the
read-path leak — LIKE wildcard escaping already handles it — so the
case-differing `team` vs `TEAM` pair is the one that matters for entry 1.

Reconcile: keep the fork case while entry 1 lives; it is additive and does not
touch upstream's assertions.

## 3. Dependency resolution: pnpm here, npm upstream

- Upstream's bump was **lock-only** (ranges untouched). Here the ranges were
  raised to the security floor as well (`^1.32.2` / `^4.6.7` / `^12.11.1` /
  `^25.9.9` / `^4.23.15`) so a fresh install cannot resolve back to the
  vulnerable versions. Revert the ranges and keep the lock bump if strict
  upstream parity is preferred.
- Upstream upgrades `package-lock.json` (npm). This fork develops with
  `pnpm-lock.yaml` (untracked locally) while `package-lock.json` stays the
  tracked artifact, so both were refreshed to the same targets:
  `@modelcontextprotocol/sdk` 1.32.x, `zod` 4.6.x, `better-sqlite3` 12.11.x,
  `proxy-addr` 2.0.8, `ip-address` 10.7.x, `fast-uri` 3.1.9.
- `package.json` `overrides` (`hono` 4.12.27, `@hono/node-server` 2.0.12,
  `esbuild` 0.28.1) are honoured by **npm only**; pnpm ignores npm `overrides`
  (it reads `pnpm.overrides`) and currently resolves `hono` 4.13.x /
  `@hono/node-server` 2.1.x. That mismatch predates this sync.
- `packageManager` pins `pnpm@11.0.9`, but the globally installed pnpm is 12.x;
  pnpm 12 fails version switching in this workspace with
  `ERR_PNPM_LOCKFILE_READ_FILE`. Workaround used: `npx -y pnpm@11.0.9 <cmd>`.

Reconcile: when the fork drops pnpm experiments, run `npm ci` + `npm test` and
delete `pnpm-lock.yaml`; or move the pins into `pnpm.overrides` if pnpm stays.

## 4. Not ported from `4e45921`

Nothing else — `src/tools/memory-tools.ts` and the test script match upstream
apart from entries 1–2. The CHANGELOG keeps the upstream-vs-fork split explicit.

## 5. FTS bootstrap commits with explicit `BEGIN IMMEDIATE`

Upstream wraps the bootstrap in better-sqlite3's `db.transaction(fn).immediate()`.
`bun:sqlite` exposes `transaction()` but not the `.immediate()` variant, and the
fork's `SqliteDatabase` facade must stay backend-neutral. Both sides get the same
write-locked, all-or-nothing bootstrap through `exec("BEGIN IMMEDIATE")` /
`exec("COMMIT")`, with an explicit `ROLLBACK` on error.

`scripts/test-fts-bootstrap.mjs` therefore kills the fixture child just before
`COMMIT` (patched `Database.prototype.exec`) instead of inside the
better-sqlite3 transaction wrapper. Everything else — docsize counting, rebuild
on mismatch, LIKE fallback — is upstream behaviour.

## 6. Statement cache and native HTTP kept

- `prepareCached()` (SQL-text → prepared statement) stays. Upstream removed it;
  the fork's hot read paths use it for RSS/latency reasons and it is cleared on
  connection change.
- `src/http-server.ts` stays on native `node:http`. Upstream 0.4.2 moved HTTP
  back to Express + `cors`; the fork keeps native `node:http` (no Express at
  all) and implements the same contract: 1 MiB body cap (413, body drained),
  invalid JSON → 400, non-identity `Content-Encoding` → 415, `/health`.
- `src/index.ts` keeps CLI/transport lazy loading and `src/sdk-stdio.ts` keeps
  its lazy SDK imports; only `maxToolInputElements: 10_000` was added.

## 7. Agent Plugins package pins the published npm release

`agent-plugin/mcp.json` pins `delx-memory@0.4.2` from npm. This fork is not
published, so the plugin package installs the upstream release rather than this
source tree. Repoint the pin if the fork ever gets its own published name.

## 8. Search scoping is now parity, not divergence

`memory_search` applies the exact namespace filter inside SQL before `LIMIT`
(upstream `00e4540`). No fork-specific behaviour remains there; the ported
integration test compares FTS and LIKE ordering against an independent query.
