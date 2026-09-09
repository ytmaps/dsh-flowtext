import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { FlowTextInteractionResolver } from './direct-adapter.js';
import type { FlowTextInteractionBridge } from './run.js';
/** Cancellation initiated from the DSH interaction surface. */
export declare class FlowTextInteractionCancelledError extends Error {
    readonly code = "FLOWTEXT_INTERACTION_CANCELLED";
    constructor(message: string);
}
/** Build a DSH-native interaction bridge for one exact live root Agent. */
export declare function createFlowTextInteractionBridge(ctx: Context, agent: Agent): FlowTextInteractionBridge;
/** Resolve DSH interactions by the exact Session/Agent identity carried by the model request. */
export declare function createFlowTextInteractionResolver(ctx: Context): FlowTextInteractionResolver;
