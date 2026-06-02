// =============================================================================
// init — `uc init`. First-run onboarding. Interactive (clack) on a tty; the
// non-interactive path (--yes, or a piped/non-tty/--json stdout) writes a
// sensible default config without prompting. Optional --remote <baseUrl> /
// --api-key seed the hosted-backend slice. io + persistence + the prompt are
// injected so the non-interactive path is testable with no real fs / tty.
// =============================================================================

import { Command } from '@commander-js/extra-typings';
import * as clack from '@clack/prompts';

import { emit, outputError, shouldJson } from '../../../lib/output';
import { writeJsonAtomic, configPath, dbUrl as defaultDbUrl } from '../../../lib/config';
import { createSqliteAdapter } from '@ultracontext/storage/sqlite';

// -- injectable runtime -------------------------------------------------------

// a minimal writable sink — the real process streams satisfy this
type Writable = { write(s: string): boolean };

// io overrides for tests; real process streams are the defaults
type Runtime = { io?: { stdout?: Writable; stderr?: Writable; isTTY?: boolean } };

// -- persisted slice ----------------------------------------------------------

// the config init writes — local-only by default, plus optional hosted creds
type InitConfig = { baseUrl?: string; apiKey?: string };

// -- options ------------------------------------------------------------------

// flags that steer onboarding; --yes / machine mode skip the prompts
type InitOptions = { json?: boolean; yes?: boolean; remote?: string; apiKey?: string };

// -- deps ---------------------------------------------------------------------

// the prompt result: the hosted-backend slice the wizard collected (or empty)
type PromptResult = InitConfig;

// every side effect onboarding performs, injected for tests
export type InitDeps = {
    saveConfig: (config: InitConfig) => Promise<void>;
    ensureLocalDb: () => Promise<void>;
    prompt: () => Promise<PromptResult>;
};

// -- config assembly ----------------------------------------------------------

// build the persisted slice from flags (only present keys are written)
function configFromFlags(opts: InitOptions): InitConfig {
    const config: InitConfig = {};
    if (opts.remote) config.baseUrl = opts.remote;
    if (opts.apiKey) config.apiKey = opts.apiKey;
    return config;
}

// -- handler ------------------------------------------------------------------

// onboard: collect the config (flags or wizard), persist it, init the local db
export async function runInit(opts: InitOptions, deps: InitDeps, runtime: Runtime = {}): Promise<number> {
    const io = runtime.io;
    const json = shouldJson({ json: opts.json }, io);

    // non-interactive when --yes is set or we're in machine mode (piped/--json)
    const interactive = !opts.yes && !json;

    try {
        // collect the config: the wizard when interactive, else straight from flags
        const config = interactive ? await deps.prompt() : configFromFlags(opts);

        // persist the config + initialize the local db
        await deps.saveConfig(config);
        await deps.ensureLocalDb();

        // report success — data → stdout, JSON in machine mode
        emit({ ok: true, config }, { json, human: () => 'ultracontext initialized' }, io);
        return 0;
    } catch (error) {
        return outputError(error, { ...io, json });
    }
}

// -- real persistence ---------------------------------------------------------

// write the config slice atomically to ~/.ultracontext/config.json
function saveConfig(config: InitConfig): Promise<void> {
    return writeJsonAtomic(configPath(), config);
}

// open the local sqlite store once so its schema is created
async function ensureLocalDb(): Promise<void> {
    await createSqliteAdapter(defaultDbUrl());
}

// -- real prompt --------------------------------------------------------------

// the clack wizard: ask whether to connect a hosted backend, collect creds
async function prompt(): Promise<PromptResult> {
    clack.intro('ultracontext');

    // local-first by default — only collect hosted creds when the user opts in
    const wantRemote = await clack.confirm({ message: 'Connect a hosted backend?', initialValue: false });
    if (clack.isCancel(wantRemote)) throw cancelError();

    // local-only: nothing more to persist
    if (!wantRemote) {
        clack.outro('ready (local-only)');
        return {};
    }

    // hosted: collect the base url + api key
    const baseUrl = await clack.text({ message: 'API base URL', placeholder: 'https://api.ultracontext.ai' });
    if (clack.isCancel(baseUrl)) throw cancelError();

    const apiKey = await clack.password({ message: 'API key' });
    if (clack.isCancel(apiKey)) throw cancelError();

    clack.outro('ready (hosted)');
    return { baseUrl: String(baseUrl), apiKey: String(apiKey) };
}

// a clack cancellation surfaces as the marker outputError maps to exit 130
function cancelError(): Error {
    return Object.assign(new Error('cancelled'), { code: 'cancel' });
}

// -- command factory ----------------------------------------------------------

// build the `init` verb, wiring the real persistence + wizard behind the seam
export function buildInitCommand(): Command {
    const command = new Command('init');

    // initialize ultracontext for this machine
    command
        .description('initialize ultracontext for this project')
        .option('--yes', 'accept defaults without prompting')
        .option('--remote <baseUrl>', 'seed a hosted backend base url')
        .option('--api-key <key>', 'seed a hosted backend api key')
        .action(async (opts, cmd) => {
            const json = Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);

            // wire the live deps behind the injectable seam
            const deps: InitDeps = { saveConfig, ensureLocalDb, prompt };

            process.exitCode = await runInit(
                { json, yes: opts.yes, remote: opts.remote, apiKey: opts.apiKey },
                deps,
            );
        });

    return command;
}
