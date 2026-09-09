import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { FlowTextClient } from './client.js';
import type { FlowTextRunPolicy } from './protocol.js';
import { type FlowTextProgressMode } from './progress.js';
export type FlowTextStopReason = 'completed' | 'aborted' | 'error';
export interface FlowTextRunRequest {
    readonly prompt: readonly ContentBlock[];
    readonly signal: AbortSignal;
}
export interface FlowTextRunResult {
    readonly output: ContentBlock[];
    readonly stopReason: FlowTextStopReason;
    readonly diagnostic?: string;
}
export interface FlowTextRun {
    readonly id: string;
    readonly progress: AsyncIterable<string>;
    readonly result: Promise<FlowTextRunResult>;
    dispose(): Promise<void>;
}
/** Fully resolved inputs for one remote FlowText run. */
export interface FlowTextRunSpec {
    readonly client: FlowTextClient;
    readonly clientId: string;
    readonly modelId?: string;
    readonly activePath?: string;
    readonly contextPaths: readonly string[];
    readonly policy: FlowTextRunPolicy;
    readonly runOptions: Readonly<Record<string, unknown>>;
    readonly maxPromptBytes: number;
    readonly maxAnswerBytes: number;
    readonly progressMode: FlowTextProgressMode;
    readonly onError?: (error: Error) => void;
}
/**
 * Publish one remote FlowText task and own it until terminal settlement.
 * @param request - the latest DSH user task.
 * @param spec - client, authority, and response bounds.
 * @returns an owned FlowText run whose disposal cancels and awaits the task.
 */
export declare function startFlowTextRun(request: FlowTextRunRequest, spec: FlowTextRunSpec, context?: {
    readonly conversationId?: string;
    readonly vaultId?: string;
}): Promise<FlowTextRun>;
