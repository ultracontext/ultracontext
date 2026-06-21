export interface ProjectConfigOptions {
    projectRoot?: string
    cwd?: string
    configPath?: string
    db?: string
    contentDir?: string
    inlineLimit?: number
    storageDriver?: 'local-dir' | 's3' | 'inline'
    s3?: S3ProjectConfig
}

export interface ProjectConfig {
    projectRoot: string
    configPath: string
    db: string
    contentDir?: string
    inlineLimit: number
    storageDriver: 'local-dir' | 's3' | 'inline' | string
    s3?: S3ProjectConfig
    raw: unknown
}

export interface S3ProjectConfig {
    endpoint?: string
    bucket?: string
    region?: string
    accessKeyId?: string
    access_key_id?: string
    secretAccessKey?: string
    secret_access_key?: string
    sessionToken?: string
    session_token?: string
    prefix?: string
}

export function loadProjectConfig(options?: ProjectConfigOptions): Promise<ProjectConfig>
export function loadProjectConfigSync(options?: ProjectConfigOptions): ProjectConfig
export function findProjectConfig(start?: string): string | null
