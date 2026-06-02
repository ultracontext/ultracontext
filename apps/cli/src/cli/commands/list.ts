// =============================================================================
// list — `uc list` lists a project's contexts via the local-first
// ContextClient. Filters: --source --project_path --limit. Defaults to the
// current project (cwd). Pipe-aware: --json (or non-tty) → machine JSON.
// =============================================================================

import { Command } from '@commander-js/extra-typings';

import { resolveClient } from '../../../lib/resolve-client';
import type { ListInput } from '../../../lib/context-client';
import { emit, outputError } from '../../../lib/output';

// -- io context ---------------------------------------------------------------

// the injectable streams + tty the action writes through (tests capture these)
type Io = { stdout: { write(s: string): boolean }; stderr: { write(s: string): boolean }; isTTY?: boolean };

// resolved runtime: where to read from (db/cwd/remote) + where to write to
type ListContext = { dbUrl?: string; cwd?: string; remote?: boolean; io?: Io };

// -- options ------------------------------------------------------------------

// the parsed flags: filters + the global --json/--remote toggles
type ListOptions = { json?: boolean; remote?: boolean; source?: string; project_path?: string; limit?: number };

// -- action -------------------------------------------------------------------

// list contexts and emit them; returns the process exit code (0 ok, 1 error)
export async function listAction(opts: ListOptions, ctx: ListContext = {}): Promise<number> {
    const remote = opts.remote ?? ctx.remote;
    const io = ctx.io;

    try {
        // pick the backend (local sqlite by default, remote stub when asked)
        const client = await resolveClient({ remote, dbUrl: ctx.dbUrl, cwd: ctx.cwd });

        // list ALL contexts by default; filters are optional (no cwd default)
        const filters: ListInput = {
            source: opts.source,
            project_path: opts.project_path,
            limit: opts.limit,
        };

        // fetch, then emit the { data } envelope (JSON line or human list)
        const result = await client.list(filters);
        emit(
            result,
            { json: opts.json, human: (d) => (d as { data: Array<{ id: string }> }).data.map((r) => r.id).join('\n') },
            io,
        );

        return 0;
    } catch (error) {
        // clean failure → error on stderr, stdout untouched, exit 1
        return outputError(error, { ...io, json: opts.json });
    }
}

// -- registration -------------------------------------------------------------

// register `uc list` on the program root with its filter options
export function registerList(program: Command): void {
    program
        .command('list')
        .alias('ls')
        .description('list contexts')
        .option('--source <source>', 'filter by capture source')
        .option('--project_path <path>', 'filter by project path')
        .option('--limit <n>', 'max contexts to return', (v) => Number(v))
        .action(async (opts, cmd) => {
            // merge in the global --json/--remote flags off the program root
            const globals = cmd.optsWithGlobals() as { json?: boolean; remote?: boolean };

            // await the action so output settles before the program resolves;
            // surface failures via exitCode (not process.exit, which races writes)
            process.exitCode = await listAction({ ...opts, json: globals.json, remote: globals.remote });
        });
}
