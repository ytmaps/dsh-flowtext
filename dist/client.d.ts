import type { FlowTextCreateTaskRequest, FlowTextEventsResponse, FlowTextInteractionAnswer, FlowTextTaskSnapshot } from './protocol.js';
import type { FlowTextCredentialStore } from './credentials.js';
/** HTTP client configuration after plugin defaults are resolved. */
export interface FlowTextClientOptions {
    readonly baseUrl: string;
    readonly token?: string;
    readonly autoPair?: boolean;
    readonly clientId?: string;
    readonly clientName?: string;
    readonly expectedVaultId?: string;
    readonly credentialStore?: FlowTextCredentialStore;
    readonly requestTimeoutMs: number;
    readonly longPollMs: number;
    readonly maxResponseBytes: number;
}
/** A safe HTTP failure that never includes credentials or raw response bodies. */
export declare class FlowTextClientError extends Error {
    readonly code: string;
    readonly status?: number | undefined;
    constructor(message: string, code: string, status?: number | undefined);
}
/** Minimal authenticated client for FlowText Agent Gateway v1. */
export declare class FlowTextClient {
    private readonly options;
    readonly baseUrl: string;
    private token;
    private resolvingToken;
    constructor(options: FlowTextClientOptions);
    /** Verify that a discovered loopback endpoint still belongs to the selected vault. */
    verifyVault(vaultId: string, signal: AbortSignal): Promise<void>;
    private acquireToken;
    private pair;
    /** Create or recover an idempotent task. */
    createTask(input: FlowTextCreateTaskRequest, signal: AbortSignal): Promise<FlowTextTaskSnapshot>;
    /** Read one current task snapshot. */
    getTask(taskId: string, signal: AbortSignal): Promise<FlowTextTaskSnapshot>;
    /** Wait for task events newer than `after`. */
    waitForEvents(taskId: string, after: number, signal: AbortSignal): Promise<FlowTextEventsResponse>;
    /** Request cancellation with an operation-owned timeout. */
    cancelTask(taskId: string): Promise<void>;
    /** Answer a pending FlowText clarification. */
    answerInteraction(taskId: string, requestId: string, answers: readonly FlowTextInteractionAnswer[], signal: AbortSignal): Promise<void>;
    /** Resolve a pending FlowText approval. */
    resolveApproval(taskId: string, requestId: string, decision: 'once' | 'session' | 'deny', signal: AbortSignal): Promise<void>;
    private request;
    private requestWithToken;
    private unwrap;
}
