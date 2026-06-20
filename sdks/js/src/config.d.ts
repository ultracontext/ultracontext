export interface ProjectConfigOptions {
    projectRoot?: string
    cwd?: string
    configPath?: string
    db?: string
    contentDir?: string
    inlineLimit?: number
}

export interface ProjectConfig {
    projectRoot: string
    configPath: string
    db: string
    contentDir: string
    inlineLimit: number
    raw: unknown
}

export function loadProjectConfig(options?: ProjectConfigOptions): Promise<ProjectConfig>
export function findProjectConfig(start?: string): string | null
