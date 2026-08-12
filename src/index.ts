#!/usr/bin/env node
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";

const args = new Set(process.argv.slice(2));
const firstArg = process.argv[2];

// CLI detection happens before any server import so a server start never pays
// for loading cli/commands.js (lazy-loading RSS optimization).
const CLI_COMMANDS = new Set([
  "setup",
  "doctor",
  "status",
  "version",
  "--version",
  "-v",
  "help",
  "--help",
  "-h",
]);
const isCliCommand =
  firstArg !== undefined && (CLI_COMMANDS.has(firstArg) || !firstArg.startsWith("--"));

let cliResult: number | undefined;
if (isCliCommand) {
  try {
    const { runCliCommand } = await import("./cli/commands.js");
    cliResult = await runCliCommand(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function resolveTransport(): "lite" | "sdk" | "http" {
  if (args.has("--http") || process.env.DELX_MEMORY_TRANSPORT === "http") return "http";
  if (args.has("--sdk") || process.env.DELX_MEMORY_TRANSPORT === "sdk") return "sdk";
  if (args.has("--lite") || process.env.DELX_MEMORY_TRANSPORT === "lite") return "lite";
  // Default: lite stdio (tools-only, no MCP SDK load) — lowest RSS for always-on agents.
  // Full prompts/resources: DELX_MEMORY_TRANSPORT=sdk or --sdk.
  const env = process.env.DELX_MEMORY_TRANSPORT;
  if (env === "stdio") return "lite"; // stdio alias → lite
  return "lite";
}

if (cliResult !== undefined) {
  process.exitCode = cliResult;
} else if (process.exitCode === undefined) {
  const mode = resolveTransport();
  if (mode === "http") {
    // Defer sdk-stdio load until the first request: sdk-stdio.ts statically
    // imports the whole MCP SDK dependency tree, so importing it at boot
    // would pay that cost up front (~+50MB boot RSS). The factory below is
    // only invoked per request inside http-server.ts.
    const { runHttp } = await import("./http-server.js");
    await runHttp(async () => {
      const { createSdkServer } = await import("./sdk-stdio.js");
      return createSdkServer();
    });
  } else if (mode === "sdk") {
    const { runSdkStdio } = await import("./sdk-stdio.js");
    await runSdkStdio();
  } else {
    const { runLiteStdio } = await import("./lite-stdio.js");
    await runLiteStdio();
  }
}

void SERVER_NAME;
void SERVER_VERSION;
