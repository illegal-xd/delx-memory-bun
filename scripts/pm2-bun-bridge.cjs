#!/usr/bin/env bun
/**
 * PM2 Bun container CJS bridge.
 *
 * PM2's Bun fork container loads the app entry with a patched require()
 * (require-in-the-middle), which cannot require async (ESM) modules —
 * dist/index.js is ESM, so a direct `pm2 start dist/index.js --interpreter bun`
 * dies with "require() async module ... is unsupported".
 *
 * This bridge is a synchronous CJS module that PM2's Bun container can load;
 * it then loads the real ESM entry with dynamic import(). PM2 still manages
 * the Bun process directly (real RSS, restart, logs).
 */
const { join } = require("node:path");

const entry = join(__dirname, "..", "dist", "index.js");

import(entry).catch((err) => {
  console.error(`[pm2-bun-bridge] failed to load ${entry}:`, err);
  process.exit(1);
});
