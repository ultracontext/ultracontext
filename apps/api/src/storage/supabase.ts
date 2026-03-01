import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { StorageAdapter, NodeRow, NodeInsertRow, ApiKeyRow, ProjectRow } from './types';

// =============================================================================
// SUPABASE ADAPTER — same interface via Supabase REST client
// =============================================================================

export class SupabaseAdapter implements StorageAdapter {
    private client: SupabaseClient;

    constructor(url: string, serviceRoleKey: string) {
        this.client = createClient(url, serviceRoleKey);
    }

    // -- nodes: queries -------------------------------------------------------

    async findNodesByContextId(contextId: string): Promise<Partial<NodeRow>[]> {
        const { data, error } = await this.client
            .from('nodes')
            .select('public_id, prev_id')
            .eq('context_id', contextId);
        if (error) throw error;
        return data ?? [];
    }

    async findContextBranches(contextId: string) {
        const { data, error } = await this.client
            .from('nodes')
            .select('public_id, prev_id, created_at')
            .eq('context_id', contextId)
            .eq('type', 'context');
        if (error) throw error;
        return data ?? [];
    }

    async findVersions(contextId: string) {
        const { data, error } = await this.client
            .from('nodes')
            .select('public_id, created_at, metadata')
            .eq('context_id', contextId)
            .eq('type', 'context')
            .order('created_at', { ascending: true });
        if (error) throw error;
        return data ?? [];
    }

    async findNonContextNodes(contextId: string): Promise<NodeRow[]> {
        const { data, error } = await this.client
            .from('nodes')
            .select('*')
            .eq('context_id', contextId)
            .neq('type', 'context');
        if (error) throw error;
        return (data ?? []) as NodeRow[];
    }

    async findRootContext(projectId: number, publicId: string) {
        const { data, error } = await this.client
            .from('nodes')
            .select('public_id')
            .eq('project_id', projectId)
            .eq('public_id', publicId)
            .eq('type', 'context')
            .is('context_id', null)
            .limit(1)
            .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        return data;
    }

    async findRootContextByPublicId(publicId: string) {
        const { data, error } = await this.client
            .from('nodes')
            .select('public_id')
            .eq('public_id', publicId)
            .eq('type', 'context')
            .is('context_id', null)
            .limit(1)
            .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        return data;
    }

    async listRootContexts(projectId: number, limit: number) {
        const { data, error } = await this.client
            .from('nodes')
            .select('public_id, metadata, created_at')
            .eq('project_id', projectId)
            .eq('type', 'context')
            .is('context_id', null)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return data ?? [];
    }

    // -- nodes: mutations -----------------------------------------------------

    async insertNodes(values: NodeInsertRow | NodeInsertRow[]): Promise<Partial<NodeRow>[]> {
        const rows = Array.isArray(values) ? values : [values];
        const { data, error } = await this.client
            .from('nodes')
            .insert(rows)
            .select('public_id, content, metadata, created_at');
        if (error) throw error;
        return data ?? [];
    }

    async deleteNodesByContextId(projectId: number, contextId: string) {
        const { error } = await this.client
            .from('nodes')
            .delete()
            .eq('project_id', projectId)
            .eq('context_id', contextId);
        if (error) throw error;
    }

    async deleteNodeByPublicId(projectId: number, publicId: string) {
        const { error } = await this.client
            .from('nodes')
            .delete()
            .eq('project_id', projectId)
            .eq('public_id', publicId);
        if (error) throw error;
    }

    // -- api keys -------------------------------------------------------------

    async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
        const { data, error } = await this.client
            .from('api_keys')
            .select('id, project_id, key_hash')
            .eq('key_prefix', prefix)
            .limit(1)
            .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        return data;
    }

    async insertApiKey(values: { project_id: number; key_prefix: string; key_hash: string }) {
        const { error } = await this.client.from('api_keys').insert(values);
        if (error) throw error;
    }

    // -- projects -------------------------------------------------------------

    async insertProject(name: string): Promise<ProjectRow | null> {
        const { data, error } = await this.client
            .from('projects')
            .insert({ name })
            .select('id')
            .single();
        if (error) throw error;
        return data;
    }

    async deleteProject(id: number) {
        const { error } = await this.client.from('projects').delete().eq('id', id);
        if (error) throw error;
    }
}
