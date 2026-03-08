import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextReader } from "./types.js";

// -- MCP server factory -------------------------------------------------------

export function createMcpServer(reader: ContextReader) {
  const mcp = new McpServer({ name: "ultracontext", version: "0.1.0" });

  // list contexts with optional filters
  mcp.registerTool(
    "list_contexts",
    {
      title: "List Contexts",
      description: "List recent agent contexts. Filter by source, user_id, host, session_id, or time range.",
      inputSchema: {
        source: z.string().optional().describe("Agent source: claude, codex, or openclaw"),
        user_id: z.string().optional().describe("User identifier"),
        host: z.string().optional().describe("Machine hostname (e.g. Fabios-MacBook-Pro.local)"),
        project_path: z.string().optional().describe("Project directory path (e.g. /Users/fabio/Code/myapp)"),
        session_id: z.string().optional().describe("Session identifier"),
        after: z.string().optional().describe("ISO8601 timestamp — only contexts created after this time"),
        before: z.string().optional().describe("ISO8601 timestamp — only contexts created before this time"),
        limit: z.number().optional().describe("Max results (default 10)"),
      },
    },
    async (args) => {
      const res = await reader.listContexts({
        limit: args.limit ?? 10,
        source: args.source,
        user_id: args.user_id,
        host: args.host,
        project_path: args.project_path,
        session_id: args.session_id,
        after: args.after,
        before: args.before,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  // get messages from a specific context
  mcp.registerTool(
    "get_context_messages",
    {
      title: "Get Context Messages",
      description: "Retrieve messages from a specific context by ID. Returns the full conversation.",
      inputSchema: {
        context_id: z.string().describe("Context public ID"),
      },
    },
    async (args) => {
      const res = await reader.getMessages(args.context_id);
      if (!res) return { content: [{ type: "text" as const, text: "Context not found." }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }] };
    },
  );

  // convenience: get recent activity from an agent
  mcp.registerTool(
    "get_recent_activity",
    {
      title: "Get Recent Activity",
      description: "Get recent messages from the latest context of a specific agent (or all agents). Shortcut for 'what did I do last?'",
      inputSchema: {
        source: z.string().optional().describe("Agent source: claude, codex, or openclaw"),
        message_limit: z.number().optional().describe("Max messages to return (default 10)"),
      },
    },
    async (args) => {
      // get most recent context
      const list = await reader.listContexts({ limit: 1, source: args.source });
      if (list.data.length === 0) {
        return { content: [{ type: "text" as const, text: "No recent activity found." }] };
      }

      // fetch its messages
      const ctx = list.data[0];
      const messages = await reader.getMessages(ctx.id);
      if (!messages) {
        return { content: [{ type: "text" as const, text: "No recent activity found." }] };
      }

      const limit = args.message_limit ?? 10;
      const recent = messages.data.slice(-limit);

      const result = {
        context: { id: ctx.id, metadata: ctx.metadata, created_at: ctx.created_at },
        messages: recent,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  return mcp;
}
