import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";

export type CreateServerFn = () => McpServer | Promise<McpServer>;

const MAX_BODY_BYTES = 1024 * 1024;
const CORS_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE";

/**
 * HTTP transport only loaded when --http / DELX_MEMORY_TRANSPORT=http.
 * Native node:http (no Express/CORS) — keeps the bun runtime RSS footprint
 * low; the SDK itself loads lazily inside this module's request path.
 */
export async function runHttp(createServer: CreateServerFn): Promise<void> {
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
        await handleMcpRequest(req, res, createServer);
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

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  createServer: CreateServerFn,
): Promise<void> {
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const server = await createServer();
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
