import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildAgentManifest } from "../services/agent-manifest.js";
import { buildCapabilities } from "../services/capabilities.js";
import { buildDataInventory } from "../services/inventory.js";
import { getDbSizeBytes, resolveDbPath, sweepExpired } from "../services/db.js";
import { getDb } from "../services/db.js";

function jsonResource(uri: URL, data: unknown) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function registerMemoryResources(server: McpServer): void {
  server.registerResource(
    "memory_data_inventory",
    "memory://inventory",
    {
      title: "Memory Data Inventory",
      description: "Static inventory of memory domains and recommended first calls.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, buildDataInventory()),
  );

  server.registerResource(
    "memory_agent_manifest",
    "memory://agent-manifest",
    {
      title: "Memory Agent Manifest",
      description: "Machine-readable install and operating instructions for AI agents.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, buildAgentManifest("generic")),
  );

  server.registerResource(
    "memory_capabilities",
    "memory://capabilities",
    {
      title: "Memory Capabilities",
      description: "Self-description of the delx-memory MCP surface.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, buildCapabilities()),
  );

  server.registerResource(
    "memory_connection_status",
    "memory://connection-status",
    {
      title: "Memory Connection Status",
      description: "Local SQLite path readiness and size (no entry values).",
      mimeType: "application/json",
    },
    async (uri) => {
      sweepExpired();
      const db = getDb();
      const countRow = db
        .prepare<unknown[], { total: number }>("SELECT COUNT(*) AS total FROM memory")
        .get();
      return jsonResource(uri, {
        ok: true,
        ready: true,
        db_path: resolveDbPath(),
        total_keys: countRow?.total ?? 0,
        total_size_bytes: getDbSizeBytes(),
      });
    },
  );
}
