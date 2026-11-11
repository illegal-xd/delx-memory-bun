import { listCatalogTools } from "../catalog.js";

type CallResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
};

/**
 * `delx-memory call <tool> --json '{...}'` — run any catalog tool without an
 * MCP client. Same handlers, same `explicit_user_intent` gate as MCP.
 */
export async function runToolCall(args: string[]): Promise<number> {
  const tools = listCatalogTools();
  const names = tools.map((t) => t.name);
  const name = args[0];
  if (!name || name.startsWith("-")) {
    console.error(`Usage: delx-memory call <tool> [--json '{...}']`);
    console.error(`Tools: ${names.join(", ")}`);
    return 1;
  }
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    console.error(`Unknown tool: ${name}`);
    console.error(`Tools: ${names.join(", ")}`);
    return 1;
  }
  const jsonIdx = args.indexOf("--json");
  let input: Record<string, unknown> = {};
  if (jsonIdx >= 0) {
    const raw = args[jsonIdx + 1];
    if (!raw) {
      console.error("--json requires an object string");
      return 1;
    }
    input = JSON.parse(raw) as Record<string, unknown>;
  }
  const result = (await tool.handler(input)) as CallResult;
  const payload = result.structuredContent ?? result.content ?? result;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return result.isError ? 1 : 0;
}
