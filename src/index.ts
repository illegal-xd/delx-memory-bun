#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";

const MAX_BODY_BYTES = 1024 * 1024;
const CORS_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE";

async function createServer() {
  const [{ McpServer }, { registerMemoryTools }, { registerMemoryPrompts }, { registerMemoryResources }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("./tools/memory-tools.js"),
      import("./prompts/memory-prompts.js"),
      import("./resources/memory-resources.js"),
    ]);
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerMemoryTools(server);
  registerMemoryPrompts(server);
  registerMemoryResources(server);
  return server;
}

async function runStdio(): Promise<void> {
  const server = await createServer();
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigin: string): void {
  const origin = req.headers.origin;
  if (!origin || (allowedOrigin !== "*" && origin !== allowedOrigin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", CORS_METHODS);
  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", reqHeaders ?? "Content-Type");
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [{ StreamableHTTPServerTransport }, server] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    createServer(),
  ]);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  const body = await readJsonBody(req);
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function runHttp(): Promise<void> {
  const host = process.env.DELX_MEMORY_HOST ?? "127.0.0.1";
  const port = Number(process.env.DELX_MEMORY_PORT ?? 3030);
  const allowedOrigin = process.env.DELX_MEMORY_ALLOWED_ORIGIN ?? `http://${host}:${port}`;

  const app = createHttpServer(async (req, res) => {
    applyCors(req, res, allowedOrigin);
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION });
      return;
    }
    if (req.method === "POST" && req.url === "/mcp") {
      try {
        await handleMcpRequest(req, res);
      } catch (error) {
        console.error("MCP HTTP request failed:", error);
        if (!res.headersSent) {
          const status = error instanceof HttpError ? error.status : 500;
          const message = error instanceof HttpError ? error.message : "Internal server error";
          sendJson(res, status, { error: message });
        }
      }
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  });

  app.listen(port, host, () => {
    console.error(`${SERVER_NAME} HTTP transport listening on http://${host}:${port}/mcp`);
  });
}

const args = new Set(process.argv.slice(2));
const firstArg = process.argv[2];
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

if (cliResult !== undefined) {
  process.exitCode = cliResult;
} else if (process.exitCode === undefined) {
  const transport = process.env.DELX_MEMORY_TRANSPORT ?? (args.has("--http") ? "http" : "stdio");
  if (transport === "http") {
    await runHttp();
  } else {
    await runStdio();
  }
}
