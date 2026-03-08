import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { UltraContext } from "ultracontext";

import { createMcpServer } from "./server.js";
import { sdkReader } from "./reader-sdk.js";

// -- resolve config from ~/.ultracontext/config.json → env vars → fail -------

function loadConfig() {
  const configPath = join(homedir(), ".ultracontext", "config.json");

  // try config file first
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    if (raw.apiKey) {
      return {
        apiKey: String(raw.apiKey),
        baseUrl: String(raw.baseUrl ?? "https://api.ultracontext.ai"),
      };
    }
  } catch { /* fall through */ }

  // fallback to env vars
  if (process.env.ULTRACONTEXT_API_KEY) {
    return {
      apiKey: process.env.ULTRACONTEXT_API_KEY,
      baseUrl: process.env.ULTRACONTEXT_BASE_URL ?? "https://api.ultracontext.ai",
    };
  }

  console.error("ULTRACONTEXT_API_KEY is required (set in ~/.ultracontext/config.json or env)");
  process.exit(1);
}

// -- start stdio transport ----------------------------------------------------

const { apiKey, baseUrl } = loadConfig();
const uc = new UltraContext({ apiKey, baseUrl });
const mcp = createMcpServer(sdkReader(uc));
const transport = new StdioServerTransport();

await mcp.connect(transport);
