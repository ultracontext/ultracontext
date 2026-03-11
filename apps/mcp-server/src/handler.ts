import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./server.js";
import type { ContextReader } from "./types.js";

// -- universal Web Standard handler (works in Hono, CF Workers, etc.) ---------

export async function handleMcpRequest(
  request: Request,
  reader: ContextReader,
): Promise<Response> {
  const mcp = createMcpServer(reader);
  // stateless + JSON responses — rejects GET/DELETE with 405 per MCP spec
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await mcp.connect(transport);
  return transport.handleRequest(request);
}
