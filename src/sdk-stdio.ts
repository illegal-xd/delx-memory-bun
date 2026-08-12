import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";

/**
 * SDK adapter — only loaded by transports that opt into the full MCP SDK
 * surface (--sdk, --http). Every SDK dependency is imported lazily inside the
 * factory so merely loading this module never pays the SDK dependency tree
 * (see lesson:dynamic-import-static-deps — top-level static imports would
 * pull express/hono/ajv/zod at boot).
 */
export async function createSdkServer(options?: { lean?: boolean }): Promise<McpServer> {
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
  registerMemoryTools(server as unknown as import("./tool-registry.js").ToolServerFacade);
  const lean =
    options?.lean === true ||
    process.env.DELX_MEMORY_LEAN === "1" ||
    process.env.DELX_MEMORY_LEAN === "true" ||
    process.argv.includes("--lean");
  if (!lean) {
    registerMemoryPrompts(server);
    registerMemoryResources(server);
  }
  return server;
}

export async function runSdkStdio(): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = await createSdkServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
