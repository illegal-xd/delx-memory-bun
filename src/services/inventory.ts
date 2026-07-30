import { NPM_PACKAGE_NAME, SERVER_VERSION } from "../constants.js";

export function buildDataInventory() {
  return {
    kind: "data_inventory" as const,
    project: NPM_PACKAGE_NAME,
    version: SERVER_VERSION,
    privacy_modes: ["summary", "structured", "raw"],
    domains: [
      {
        id: "key_value_memory",
        description: "Local SQLite key/value entries with optional tags, TTL and metadata.",
        tools: ["memory_get", "memory_list", "memory_search", "memory_set", "memory_forget"],
      },
      {
        id: "bulk_export",
        description: "Full or filtered export for backup/inspection.",
        tools: ["memory_export", "memory_forget_by_tag"],
      },
      {
        id: "self_description",
        description: "Agent onboarding and readiness.",
        tools: [
          "memory_agent_manifest",
          "memory_connection_status",
          "memory_data_inventory",
          "memory_capabilities",
          "memory_stats",
        ],
      },
    ],
    recommended_first_calls: [
      "memory_agent_manifest",
      "memory_connection_status",
      "memory_stats",
      "memory_list",
    ],
    storage: {
      default_path: "~/.delx-memory/db.sqlite",
      override_env: "DELX_MEMORY_PATH",
      max_value_bytes: 65536,
    },
  };
}
