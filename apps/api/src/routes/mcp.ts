import { handleMcpRequest } from 'ultracontext-mcp-server/handler';
import type { ContextReader } from 'ultracontext-mcp-server/types';
import { listContexts, getContextMessages } from '../domain/context-ops';
import type { HttpApp, HttpContext } from '../types/http';

// -- storage-backed reader (no HTTP loopback) ---------------------------------

function storageReader(c: HttpContext): ContextReader {
    const { projectId } = c.get('auth');
    const storage = c.get('storage');

    return {
        listContexts: (input) => listContexts(storage, projectId, input),
        getMessages: (id) => getContextMessages(storage, projectId, id),
    };
}

// -- MCP endpoint (stateless — no SSE/sessions, POST only per MCP spec) ------

const METHOD_NOT_ALLOWED = {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
};

export function registerMcpRoutes(app: HttpApp) {
    app.post('/mcp', async (c: HttpContext) => {
        return handleMcpRequest(c.req.raw, storageReader(c));
    });

    app.get('/mcp', (c) => c.json(METHOD_NOT_ALLOWED, 405));
    app.delete('/mcp', (c) => c.json(METHOD_NOT_ALLOWED, 405));
}
