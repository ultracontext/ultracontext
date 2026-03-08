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

// -- MCP endpoint -------------------------------------------------------------

export function registerMcpRoutes(app: HttpApp) {
    const handler = async (c: HttpContext) => {
        return handleMcpRequest(c.req.raw, storageReader(c));
    };

    app.post('/mcp', handler);
    app.get('/mcp', handler);
    app.delete('/mcp', handler);
}
