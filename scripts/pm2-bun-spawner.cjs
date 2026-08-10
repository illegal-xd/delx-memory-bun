#!/usr/bin/env bun
/**
 * PM2 Bun spawner (CJS, container-safe).
 *
 * PM2's Bun container inflates RSS (~80MB) when the app ESM dependency tree is
 * loaded through its CJS require() chain (Node-compat loader). This spawner
 * keeps the container process tiny and delegates the real server to a bare
 * `bun dist/index.js` child process (native ESM loader, ~23MB RSS).
 *
 * Lifecycle: forwards SIGTERM/SIGINT to the child and exits with the child's
 * exit code so PM2's restart/stop semantics work as usual.
 */
const { spawn } = require("node:child_process");
const { join } = require("node:path");

const entry = join(__dirname, "..", "dist", "index.js");
const args = ["--http"];

const env = { ...process.env };
// Do not leak PM2's IPC fd to the child — the child must be a bare Bun.
delete env.NODE_CHANNEL_FD;
delete env.NODE_CHANNEL_SERIALIZATION_MODE;

const child = spawn("bun", [entry, ...args], {
  stdio: "inherit",
  env,
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

child.on("error", (err) => {
  console.error("[pm2-bun-spawner] failed to start bun:", err);
  process.exit(1);
});
