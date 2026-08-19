# delx-memory (bun 分支)

> Local-first persistent memory MCP server. One shared SQLite store any MCP-speaking agent (Claude Desktop, Cursor, Hermes, OpenClaw, Codex) can read and write — so context survives across sessions AND across tools.

[![status: alpha](https://img.shields.io/badge/status-alpha-orange)](https://github.com/illegal-xd/delx-memory-bun)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![runtime: bun](https://img.shields.io/badge/runtime-bun-%23fbf0df)](https://bun.sh)
[![node: >=20 compatible](https://img.shields.io/badge/node-%3E%3D20-green)](package.json)

本仓库是 [delx-memory](https://github.com/davidmosiah/delx-memory)（上游 0.4.0）的 **bun 运行时优化分支**：

- 生产部署完全使用 **Bun**（`bun:sqlite` 后端，原生 `node:http` 替代 Express）
- **Node 仍然兼容**：`better-sqlite3` 后备后端保留，全功能测试在 Node 20+ 通过（见 [Runtime support](#runtime-support)）
- 跟进上游 0.4.0：`memory_handoff`、批量读写、`DELX_MEMORY_NAMESPACE` 多代理隔离、`list.since` 增量过滤

## Why

Every chat client has its own ephemeral context. Quit the tab → preferences gone. Switch from Claude Desktop to Cursor → starting from scratch. Pin a side project in Hermes → invisible to the next agent.

`delx-memory` is a tiny MCP server that exposes a single shared SQLite file as a key/value memory layer. Any client that speaks MCP can read and write the same memory file → real continuity, real cross-tool context.

- 15 MCP tools — 11 read-only, 4 mutating.
- **`memory_handoff`** — 一次调用生成会话恢复简报（store stats + 最近 keys + agent 指引）。
- **批量读写** — `memory_get_many` / `memory_set_batch`（≤50 条，批量写走单事务）。
- **`DELX_MEMORY_NAMESPACE`** — 多代理/多项目 key 隔离（`namespace::key` 前缀）。
- **`list.since`** — 按 `updated_at` 增量同步（会话恢复 / delta sync）。
- SQLite at `~/.delx-memory/db.sqlite` (0700 dir, 0600 file).
- **Secret-blocking**: refuses to store credential-shaped keys or values.
- TTL support (lazy expiry on read).
- Tags + prefix filters + FTS5 full-text search (bm25 ranking, stemming, diacritic folding; LIKE fallback if FTS5 is unavailable).
- Mutations require `explicit_user_intent: true` so over-eager agents can't silently rewrite your context.
- Zero telemetry. Zero phone-home. The file is yours.

---

## Runtime support

| 运行时 | 状态 | 后端 | 说明 |
|---|---|---|---|
| **Bun ≥ 1.3**（推荐） | ✅ 生产路径 | `bun:sqlite` | FTS5 + 自定义 tokenizer 实测可用；HTTP 走原生 `node:http`；RSS 最低 |
| Node ≥ 20（兼容） | ✅ 测试通过 | `better-sqlite3` | 双运行时自动检测（`typeof Bun`）；0.4.0 全特性（事务/namespace/busy_timeout）实测通过 |

运行时自动选择：`services/db.ts` 在启动时检测 Bun 并加载对应 SQLite 后端，业务层无感。

### RSS 基线（Bun 1.3.2 / macOS，同口径实测）

| 模式 | 空闲 RSS | 说明 |
|---|---|---|
| `lite` stdio（默认，无 MCP SDK） | ~47 MB | 常驻 agent 最低开销 |
| `--sdk` stdio | ~68 MB | prompts + resources |
| `--http`（node:http + SDK） | boot ~24 MB / 请求后 ~80 MB | SDK 首个请求才加载 |

---

## Install + run（本地构建）

本分支不发布 npm 包，直接克隆构建：

```bash
git clone https://github.com/illegal-xd/delx-memory-bun
cd delx-memory-bun

bun install
bun run build                  # tsc → dist/

bun dist/index.js              # lite stdio（默认，tools-only，不加载 MCP SDK）
bun dist/index.js --sdk        # 完整 SDK stdio（prompts + resources）
bun dist/index.js --http       # HTTP MCP on 127.0.0.1:3030
bun dist/index.js doctor       # 健康检查 + 下一步
```

Node 运行方式相同：`node dist/index.js ...`（需 `npm ci` 安装 better-sqlite3）。

### PM2 部署（bun）

```bash
pmx=false pm2 start scripts/pm2-bun-spawner.cjs --name delx-memory-bun \
  --interpreter bun --interpreter-args "--smol"
```

- `pmx=false` 关闭 PM2 容器的 `@pm2/io` 注入（省 ~16 MB RSS）。
- spawner（容器 CJS，~19 MB）委托子进程 `bun dist/index.js --http`（boot ~24 MB）。
- 健康检查：`curl http://127.0.0.1:3030/health` → `{"ok":true,"name":"delx-memory","version":"0.4.0"}`

---

## HTTP (v2 stateless)

默认是 **stdio**。可选 Streamable HTTP —— 无 session id、JSON 响应、仅回环地址（loopback）：

```bash
bun dist/index.js --http
# GET  http://127.0.0.1:3030/health
# POST http://127.0.0.1:3030/mcp   (sessionless)
```

本分支 HTTP 用原生 `node:http` 实现（替代上游的 Express + cors，省内存；SDK 首个请求才懒加载）。

Env: `DELX_MEMORY_HOST`、`DELX_MEMORY_PORT`、`DELX_MEMORY_TRANSPORT=http`。

---

## Wire it into your MCP client

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "delx-memory": {
      "command": "bun",
      "args": ["/Users/allen/Desktop/github/delx-memory-bun/dist/index.js"]
    }
  }
}
```

需要 prompts/resources（或客户端不支持裸 JSON-RPC）时加 `--sdk`；HTTP 模式加 `--http` 并把 `args` 保持为单命令、客户端走 Streamable HTTP。本分支的客户端示例配置见 [`examples/`](./examples/)。

### Cursor

Add to `~/.cursor/mcp.json`. See [`examples/cursor.json`](./examples/cursor.json).

### Hermes / OpenClaw / Codex CLI

See [`examples/hermes.md`](./examples/hermes.md)、[`examples/openclaw.md`](./examples/openclaw.md)、[`examples/codex.toml`](./examples/codex.toml)。

---

## The 15 tools

### Reads (always safe — call without confirmation)

| Tool | Purpose |
|---|---|
| `memory_agent_manifest` | Machine-readable install & operating instructions for AI agents. Call first when onboarding. |
| `memory_connection_status` | Local SQLite path readiness and size. Safe first call every session. |
| `memory_data_inventory` | Static inventory of memory domains, privacy modes and recommended first calls. |
| `memory_capabilities` | Self-description of this MCP incl. privacy modes and mutation gating. |
| `memory_handoff` | One-call session resume brief: store stats + most recent keys (optional values) + agent instructions. |
| `memory_get_many` | Batch exact-key lookup (max 50). Missing keys omitted. |
| `memory_stats` | High-level: total keys, DB size, oldest entry, DB path. **Start here on any session.** |
| `memory_list` | List keys (not values) with optional prefix, tag or **`since`** (updated_at) filter. |
| `memory_get` | Exact key lookup. Returns value + timestamps + tags + metadata. |
| `memory_search` | FTS5 full-text search across keys, values and tags — bm25 relevance ranking, stemming, diacritic folding, prefix matching; LIKE fallback if FTS5 is missing. Returns snippets. See the [search quickstart](./examples/fts5-search.md). |

### Mutations (require `explicit_user_intent: true`)

| Tool | Purpose |
|---|---|
| `memory_set_batch` | Atomic multi-entry upsert (max 50, one transaction). |
| `memory_set` | Upsert a key. Rejects credential-shaped keys/values. |
| `memory_forget` | Delete one key. Idempotent. |
| `memory_forget_by_tag` | Bulk-delete every entry carrying a given tag. |
| `memory_export` | Dump store as JSON / JSONL / Markdown, with optional `since` / `until` window. |

Every mutation refuses to run unless the caller passes `explicit_user_intent: true`. The intent: an agent that decides on its own to update memory must show its work. The user can see the flag in the tool call and reject it if they didn't ask.

---

## Privacy contract (read this)

`delx-memory` is **NOT** a secrets manager. Use macOS Keychain / gnome-keyring / Windows Credential Manager for those.

**What we refuse to store:**

- **Keys** matching: `oauth`, `token`, `secret`, `password`, `cookie`, `refresh`, `api_key`, `api-key`, `apikey`, `bearer`, `credential`, `session_id` (case-insensitive).
- **Values** matching credential shapes:
  - JWT tokens (`eyJ…`)
  - `Bearer <token>` headers
  - Stripe `sk_live_…` / `sk_test_…`
  - Slack `xoxb-…` / `xoxp-…` / etc.
  - GitHub `github_pat_…` / `ghp_…` / `gho_…` / `ghs_…` / `ghr_…`
  - OpenAI / Anthropic `sk-…` (with realistic length)
  - AWS access keys `AKIA…`
  - `Authorization: <scheme> <token>` strings
- Nested objects are walked recursively — a nested field named `refresh_token` (even with an empty value) is rejected.

**What stays local:**

- The DB file lives at `~/.delx-memory/db.sqlite`.
- Directory is created with mode `0700`; file with mode `0600`. (Best effort on Windows / WSL / non-POSIX filesystems.)
- Nothing is uploaded. No telemetry. No phone-home.

**What we do NOT promise:**

- **Other users of the same machine** (root, your `sudo`-using housemate) can read the file. Use full-disk encryption (FileVault, BitLocker, LUKS) if that matters.
- **TTL is best-effort.** Expired rows are deleted lazily on next read; SQLite doesn't `VACUUM` automatically, so freed pages may sit on disk. For sensitive ephemera, treat the DB file like any other unencrypted dotfile.
- **No durability promise.** Back up `~/.delx-memory/db.sqlite` like any other dotfile if you care about losing it.

---

## Example session

```
agent> memory_handoff({ limit: 5 })
→ { total_keys: 3, recent: [{ key: "user_preferences", updated_at: … }], agent_instructions: [...] }

user> Remember that I prefer concise responses in pt-BR.

agent> memory_set({
  key: "user_preferences",
  value: { language: "pt-BR", verbosity: "concise" },
  tags: ["profile", "preferences"],
  explicit_user_intent: true
})
→ { action: "created", key: "user_preferences", … }

# … new chat, possibly different tool …

agent> memory_handoff({})
→ { total_keys: 1, recent: [{ key: "user_preferences", … }] }

agent> memory_get({ key: "user_preferences" })
→ { found: true, value: { language: "pt-BR", verbosity: "concise" } }
```

---

## Storage layout

| | |
|---|---|
| Default path | `~/.delx-memory/db.sqlite` |
| Override | `DELX_MEMORY_PATH` env var |
| Namespace | `DELX_MEMORY_NAMESPACE` env var（`namespace::key` 前缀隔离） |
| Directory mode | `0700` |
| File mode | `0600` |
| Schema | `memory(key PRIMARY KEY, value, created_at, updated_at, ttl_expires_at, tags, metadata)` |
| Indexes | partial index on `ttl_expires_at`, plus `tags`, `updated_at` |
| Per-value cap | 64 KB (JSON-serialized) |
| Per-key cap | 512 chars |

---

## CLI

```
delx-memory                Start MCP server (lite stdio — tools-only, no MCP SDK)
delx-memory --sdk          Full MCP SDK stdio (prompts + resources)
delx-memory --http         Start local HTTP MCP server (127.0.0.1:3030)
delx-memory setup          Print MCP client config snippets
delx-memory setup --json   Print as JSON
delx-memory doctor         Health check + next steps
delx-memory doctor --json  Health check as JSON
delx-memory version        Print version
```

### Environment

| Var | Default | Purpose |
|---|---|---|
| `DELX_MEMORY_PATH` | `~/.delx-memory/db.sqlite` | DB file location |
| `DELX_MEMORY_NAMESPACE` | — | 多代理隔离：key 存为 `ns::key`，list/search 作用域过滤（≤64 字符，禁 `::`） |
| `DELX_MEMORY_TRANSPORT` | `lite` | `lite` (tools-only stdio, no SDK), `sdk` (full stdio), or `http` |
| `DELX_MEMORY_LEAN` | — | `1` on SDK path: skip prompts/resources |
| `DELX_MEMORY_HOST` | `127.0.0.1` | HTTP host |
| `DELX_MEMORY_PORT` | `3030` | HTTP port |
| `DELX_MEMORY_ALLOWED_ORIGIN` | `http://HOST:PORT` | CORS origin |

---

## Footprint / lightweight mode

- **Default transport is `lite`**: tools-only MCP over stdio **without loading the MCP SDK** (biggest RSS win for always-on agents).
- Full SDK surface (prompts + resources): `--sdk` / `DELX_MEMORY_TRANSPORT=sdk`.
- Optional HTTP: `--http` (native `node:http`, no Express; SDK lazy-loaded per request — boot ~24 MB).
- `DELX_MEMORY_LEAN=1` applies to the **SDK** path only (skip prompts/resources).
- `doctor` reports `transport_default` / `transports` / `lean_mode` (via `--json`). Dominant cost is the runtime + SQLite (no embeddings).

---

## Development

```bash
git clone https://github.com/illegal-xd/delx-memory-bun
cd delx-memory-bun
bun install          # node 运行需 npm ci（better-sqlite3）
bun run typecheck
bun run build
npm test             # 全量门禁：typecheck + build + smoke + smoke:lite + secret-detector + ttl + tag-delete + metadata
npm run bench:rss    # lite vs sdk RSS 方向性基准（node 版）
```

测试矩阵：`smoke-tools`（node + `--sdk`，验证 Node 兼容）+ `smoke-lite`（bun + `--lite`，验证 bun:sqlite 后端）。

See [`AGENTS.md`](./AGENTS.md) for repo conventions, [`SECURITY.md`](./SECURITY.md) for the security model and reporting policy, and [`CONTRIBUTING.md`](./CONTRIBUTING.md) for PR rules.

---

## Changelog

本分支版本历史见 [`CHANGELOG.md`](./CHANGELOG.md)（0.4.0：handoff/batch/namespaces/since + bun 适配；0.3.0：lite transport + tool catalog 架构）。

## License

MIT © 2026 David Batista
