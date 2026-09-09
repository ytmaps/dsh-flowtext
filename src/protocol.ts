/** FlowText Agent Gateway v1 wire types consumed by this provider. */

/** A FlowText task state returned by the Gateway. */
export type FlowTextTaskStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'

/** The authority requested from FlowText. The server may only narrow it. */
export interface FlowTextRunPolicy {
  readonly allowRead?: boolean
  readonly allowWrite?: boolean
  readonly allowWeb?: boolean
  readonly allowCli?: boolean
  readonly allowImageGeneration?: boolean
  readonly allowedPaths?: string[]
  readonly deniedPaths?: string[]
  readonly maxSteps?: number
  readonly timeoutMs?: number
  readonly maxReadFiles?: number
  readonly maxWriteFiles?: number
  readonly approvalMode?: 'never' | 'dangerous' | 'always'
}

/** Context explicitly supplied to one FlowText task. */
export interface FlowTextTaskContext {
  readonly text?: string
  readonly activePath?: string
  readonly paths?: readonly string[]
}

/** Input accepted by `POST /tasks`. */
export interface FlowTextCreateTaskRequest {
  readonly clientId: string
  readonly requestId: string
  readonly vaultId?: string
  readonly conversationId?: string
  readonly presentation?: 'background' | 'agent_view'
  readonly goal: string
  readonly modelId?: string
  readonly context?: FlowTextTaskContext
  readonly policy?: FlowTextRunPolicy
  readonly runOptions?: Readonly<Record<string, unknown>>
}

/** A pending FlowText approval. */
export interface FlowTextPendingApproval {
  readonly requestId: string
  readonly kind: 'dangerous_cli' | 'external_action'
  readonly command: string
}

/** Terminal task result persisted by FlowText. */
export interface FlowTextTaskResult {
  readonly success: boolean
  readonly answer: string
}

/** Task snapshot returned by task endpoints. */
export interface FlowTextTaskSnapshot {
  readonly taskId: string
  readonly clientId: string
  readonly requestId?: string
  readonly conversationId?: string
  readonly presentation?: 'background' | 'agent_view'
  readonly status: FlowTextTaskStatus
  readonly lastSeq: number
  readonly result?: FlowTextTaskResult
  readonly error?: { readonly code: string; readonly message: string }
  readonly pendingInteraction?: { readonly requestId: string }
  readonly pendingApproval?: FlowTextPendingApproval
}

/** Incremental task event. Event payloads remain opaque to this provider. */
export interface FlowTextTaskEvent {
  readonly taskId: string
  readonly seq: number
  readonly type: string
  readonly timestamp: number
  readonly data?: unknown
}

/** Result of `GET /tasks/:id/events`. */
export interface FlowTextEventsResponse {
  readonly taskId: string
  readonly events: readonly FlowTextTaskEvent[]
  readonly lastSeq: number
}
