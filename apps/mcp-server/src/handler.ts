import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./server.js";
import type { ContextReader } from "./types.js";

// -- universal Web Standard handler (works in Hono, CF Workers, etc.) ---------

export async function handleMcpRequest(
  request: Request,
  reader: ContextReader,
): Promise<Response> {
  const mcp = createMcpServer(reader);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await mcp.connect(transport);
  return transport.handleRequest(request);
}
