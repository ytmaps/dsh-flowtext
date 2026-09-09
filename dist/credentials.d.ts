/** Persistence boundary for a FlowText Gateway credential. */
export interface FlowTextCredentialStore {
    load(baseUrl: string): Promise<string | undefined>;
    save(baseUrl: string, token: string): Promise<void>;
    clear(baseUrl: string): Promise<void>;
}
/** Mode-0600 local credential file, separate from profile configuration and repositories. */
export declare class FileCredentialStore implements FlowTextCredentialStore {
    readonly path: string;
    private readonly scope;
    constructor(path?: string, scope?: string);
    load(baseUrl: string): Promise<string | undefined>;
    save(baseUrl: string, token: string): Promise<void>;
    clear(baseUrl: string): Promise<void>;
}
