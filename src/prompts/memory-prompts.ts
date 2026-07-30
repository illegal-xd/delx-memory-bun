import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMemoryPrompts(server: McpServer): void {
  server.registerPrompt(
    "memory_setup_status",
    {
      title: "Memory setup and status",
      description: "Check local agent memory readiness and safe first calls.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Call memory_connection_status then memory_agent_manifest. Summarize store path, readiness, and recommended_first_calls. Never print secrets. Use privacy_mode=summary for listings when available.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "memory_search_then_act",
    {
      title: "Search memory before writing",
      description: "Search local memories for a topic before any write.",
      argsSchema: {
        query: z.string().describe("Search query"),
      },
    },
    ({ query }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Call memory_search (or equivalent list/search tool) with query=${JSON.stringify(query)} and privacy_mode=summary. If the user asks to save a new fact, only call write tools with explicit_user_intent=true after confirmation. Prefer USER_ACTION_REQUIRED over silent writes.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "memory_triage_errors",
    {
      title: "Triage memory errors",
      description: "Interpret AUTH/USER_ACTION_REQUIRED style errors from memory tools.",
      argsSchema: {
        error_text: z.string().describe("Error message from a tool"),
      },
    },
    ({ error_text }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Given this tool error: ${JSON.stringify(error_text)}. Classify as USER_ACTION_REQUIRED, AUTH_REQUIRED, INVALID_INPUT, or OTHER. Suggest one next tool call. Do not invent store contents.`,
          },
        },
      ],
    }),
  );
}
