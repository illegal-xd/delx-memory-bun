## 0.4.0 - 2026-08-12

SOTA-oriented agent memory release (still local-first, still no embeddings/cloud). Upstream integration into the bun fork — transport architecture unchanged (lite default preserved).

- **`memory_handoff`** — one-call session resume brief (stats + recent keys).
- **`memory_get_many` / `memory_set_batch`** — batch read/write (max 50), batch writes are transactional (`db.transaction`, verified on bun:sqlite).
- **`memory_list.since`** — delta sync by `updated_at` for session resume.
- **`DELX_MEMORY_NAMESPACE`** — multi-agent key isolation (`namespace::key`).
- SQLite **`busy_timeout=5000`** (WAL already on) for concurrent agent writers — bun branch applies it via `exec("PRAGMA busy_timeout = 5000")` (bun:sqlite has no `pragma()`).
- `scripts/bench-rss.mjs` — directional lite vs sdk RSS probe.
- Docs/README: accurate 15-tool surface.

## 0.4.0 follow-up (2026-08-19) — upstream post-0.4.0 docs/CI sync

Upstream commits after the 0.4.0 release integrated into the bun fork (no code change — the 0.4.0 feature surface was already in place; this sync catches the doc/CI/community surface):

- `.github/dependabot.yml` — security-only monthly updates (high/critical advisories, grouped security PRs; matches upstream a3888f9).
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1 (upstream 094d6e8).
- `docs/BENCHMARKS.md` — directional lite vs sdk RSS benchmark notes (upstream 6007879).
- `docs/drafts/2026-08-12-x-post-delx-memory.md` — upstream 0.4.0 release draft (kept as-is for parity).
- README: **HTTP (v2 stateless)** section added — `--http` /health + sessionless `/mcp`, adapted to the bun branch (native `node:http`, no Express).

## 0.4.1 - 2026-10-26 — namespace isolation for export, tag deletion, list and handoff

Port of upstream `b28224c` (*fix: isolate memory export and tag deletion by namespace*). Both tools previously ignored `DELX_MEMORY_NAMESPACE`, so a scoped agent could read — and bulk-delete — other agents' rows (including global, non-namespaced entries).

- **`memory_forget_by_tag`** — DELETE now adds `AND instr(key, ?) = 1` with the literal `namespace::` prefix when a namespace is set. `instr` is used instead of `LIKE` on purpose: it is case-sensitive and treats `%`/`_`/`\` in a namespace literally.
- **`memory_export`** — the same `instr` predicate is prepended to the WHERE clauses, so `since`/`until` still compose. Unset namespace keeps the previous global behavior.
- `scripts/test-bulk-tag-delete.mjs` — rewritten against the real tool handlers (upstream `b28224c`): 5 `node:test` cases covering exact-tag deletion, `explicit_user_intent` gating, all three export formats, date-filter composition, idempotent re-delete, and two namespace pairs (`team_%\lab` vs `teamXYlab`, `team` vs `TEAM`) that differ at LIKE wildcard/backslash and case positions.
- **Read paths too (fork-only, upstream not fixed):** `memory_list` and `memory_handoff` still scoped with `key LIKE 'ns::%'`, which is ASCII case-insensitive — under `DELX_MEMORY_NAMESPACE=team` they also returned `TEAM::…` rows (export/delete were already correct after the port). Both now use `instr(key, ?) = 1` via the new `namespaceKeyPrefix()` helper in `src/services/db.ts`, which is also reused by `memory_export` / `memory_forget_by_tag`. Divergence tracked in `docs/UPSTREAM-DIVERGENCES.md`; extra `list and handoff isolate namespace team from TEAM` test case added (fails on upstream's code path).
- Dependencies refreshed to the same targets as upstream's security bump: `@modelcontextprotocol/sdk` 1.32.x, `zod` 4.6.x, `better-sqlite3` 12.11.x, `proxy-addr` 2.0.8, `ip-address` 10.7.x, `fast-uri` 3.1.9. Both lockfiles updated (`package-lock.json` tracked, `pnpm-lock.yaml` local), and the `package.json` ranges were raised to the security floor (upstream bumped the lock only). Full `npm test` green on node 25 and bun 1.3.
- Dev-env note: `packageManager` pins `pnpm@11.0.9` while the global pnpm is 12.x, which fails with `ERR_PNPM_LOCKFILE_READ_FILE` — use `npx -y pnpm@11.0.9 <cmd>`. pnpm also ignores npm `overrides`, so `hono` / `@hono/node-server` resolve above the pinned versions under pnpm but are honoured by npm (see `docs/UPSTREAM-DIVERGENCES.md`).

## 0.3.0 - 2026-08-12

### Added / Changed (upstream 0.3.0 integration, bun fork)

- **Lite stdio transport (default):** newline JSON-RPC tools path that does **not** load `@modelcontextprotocol/sdk` at boot (`--lite` / `DELX_MEMORY_TRANSPORT=lite`). Lowest RSS for always-on agents.
- **SDK path:** `--sdk` / `DELX_MEMORY_TRANSPORT=sdk` for full prompts + resources (previous default surface).
- **Tool catalog behind a facade** (`tool-registry.ts` + `catalog.ts`): handlers captured once via `capturingServer()`, shared by lite + SDK — core/adapter separation at the transport boundary.
- **HTTP transport extracted** to `http-server.ts`, still native `node:http` (no Express/CORS) — bun fork RSS optimization preserved.
- Smoke: full suite on `--sdk`; new `smoke:lite` (runs under `bun`, exercising the `bun:sqlite` backend).
- `doctor` reports `transport_default` / `transports` / `lean_mode`.
- **HTTP boot RSS fix**: deferred `sdk-stdio` load to first request (lazy server factory) — boot RSS 71MB → 24MB (0.3.0 initial integration paid the full MCP SDK dependency tree at startup; request steady-state also improved 78 → 76MB).
- **sdk-stdio internal lazy loading**: `createSdkServer()` is now async and imports McpServer/tools/prompts/resources inside the factory — merely loading `sdk-stdio.js` no longer pulls the SDK dependency tree.
- **PM2 container RSS**: rebuilt with `pmx=false` (disables `@pm2/io` injection in the pm2 container process) — container 35MB → 19MB. Server child is unaffected (already a bare bun process).
- Note: reusing one `McpServer` across HTTP requests is not possible — the MCP SDK `Protocol.connect()` throws if already connected (per-request server is the SDK's stateless-HTTP contract). Per-request server creation measured at ~8-15ms, acceptable; further HTTP memory work would require a custom streamable-HTTP transport (see `experience:no-sdk-jsonrpc-memory-gain`).

## 0.2.5 - 2026-07-30

### Added / Fixed

- MCP prompts: setup_status, search_then_act, triage_errors.

## 0.2.4 - 2026-07-30

### Added

- Agent-readiness surface: `memory_agent_manifest`, `memory_connection_status`, `memory_data_inventory`, `memory_capabilities` + MCP resources.
- Optional `privacy_mode` on read tools (`summary` omits full values / search snippets).

# Changelog

All notable changes to `delx-memory` follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adhere to [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.2.3] — 2026-06-27

### Security
- Pin transitive `hono` resolution to `4.12.27` via npm overrides, resolving production audit advisories while keeping the public MCP API unchanged.

## [0.2.2] — 2026-06-02

### Added
- **Tool annotations on all 8 tools** (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) so MCP agents (Claude, Goose, Cursor) can reason about each tool's safety before calling. `memory_get` / `memory_list` / `memory_search` / `memory_stats` are read-only + idempotent; `memory_forget` / `memory_forget_by_tag` are destructive; `memory_set` is a non-destructive idempotent upsert; `memory_export` is read-only (still gated by `explicit_user_intent`). Every tool is `openWorldHint: false` — the whole server is local SQLite and never touches the network. No behavior, schema, or gating change.

## [0.2.1] — 2026-05-29

### Added
- `examples/fts5-search.md` quickstart plus a runnable
  `examples/fts5-search-quickstart.mjs` that boots the real server against a
  throwaway DB and demonstrates the v0.2 FTS5 engine: bm25-ranked multi-word
  search, prefix matching, diacritic folding, and tag indexing. The Markdown is
  the script's verbatim captured output. README links to it.

## [0.2.0] — 2026-05-29

### Added
- FTS5 full-text search backing `memory_search`: an external-content virtual
  table mirrors `key`/`value`/`tags`, kept in sync via insert/update/delete
  triggers. Queries use bm25 relevance ranking (key-weighted), Porter stemming,
  diacritic folding, and per-token prefix matching, so multi-word, partial and
  accent-insensitive queries now rank by relevance instead of last-write order.
- `memory_search` responses now include an `engine` field (`"fts5"` or
  `"like"`) so callers can see which path served the query.

### Changed
- `memory_search` automatically falls back to the previous LIKE substring scan
  when the SQLite build lacks the FTS5 module, preserving behavior everywhere.
- Existing 0.1.x databases are backfilled into the FTS index on first open
  after upgrade — no manual migration needed.

## [0.1.0] — 2026-05-23

Initial release.

### Added
- 8 MCP tools: `memory_get`, `memory_list`, `memory_search`, `memory_stats`, `memory_set`, `memory_forget`, `memory_forget_by_tag`, `memory_export`.
- SQLite store at `~/.delx-memory/db.sqlite` (override via `DELX_MEMORY_PATH`).
- Directory `0700` + file `0600` permissions (POSIX best-effort).
- Credential-shape refusal — keys + nested values walked for OAuth/Bearer/Stripe/Slack/GitHub/OpenAI/AWS/Authorization patterns.
- `explicit_user_intent: true` gate on every mutating tool.
- TTL with lazy expiry sweep on every read.
- Tags + prefix filters on `memory_list`.
- LIKE-based keyword search across keys and values (FTS planned for a later release).
- Export to JSON / JSONL / Markdown with optional `since` / `until` window on `updated_at`.
- CLI: `setup`, `doctor`, `version`, `help` plus `--http` / `--json` flags.
- HTTP transport binding `127.0.0.1:3030` by default with strict CORS.

### Security
- No telemetry, no phone-home.
- All test scripts use ephemeral tmpdirs — no test ever touches the user's real DB.

[0.2.3]: https://github.com/davidmosiah/delx-memory/releases/tag/v0.2.3
[0.2.2]: https://github.com/davidmosiah/delx-memory/releases/tag/v0.2.2
[0.2.1]: https://github.com/davidmosiah/delx-memory/releases/tag/v0.2.1
[0.2.0]: https://github.com/davidmosiah/delx-memory/releases/tag/v0.2.0
[0.1.0]: https://github.com/davidmosiah/delx-memory/releases/tag/v0.1.0
