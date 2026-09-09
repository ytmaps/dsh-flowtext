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
  readonly interactionMode?: 'flowtext_ui' | 'gateway_client'
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
  readonly action?: unknown
}

/** One option in a pending FlowText clarification. */
export interface FlowTextPendingInteractionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly recommended?: boolean
}

/** One question in a pending FlowText clarification. */
export interface FlowTextPendingInteractionQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options: readonly FlowTextPendingInteractionOption[]
  readonly multiSelect?: boolean
  readonly allowFreeText?: boolean
  readonly required?: boolean
}

/** A clarification durably owned by one FlowText task. */
export interface FlowTextPendingInteraction {
  readonly requestId: string
  readonly kind: 'clarification'
  readonly status: 'pending'
  readonly questions: readonly FlowTextPendingInteractionQuestion[]
  readonly createdAt: number
  readonly turn?: number
}

/** One answer accepted by the FlowText interaction endpoint. */
export interface FlowTextInteractionAnswer {
  readonly questionId: string
  readonly selectedOptionIds: readonly string[]
  readonly customText?: string
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
  readonly interactionMode?: 'flowtext_ui' | 'gateway_client'
  readonly status: FlowTextTaskStatus
  readonly lastSeq: number
  readonly result?: FlowTextTaskResult
  readonly error?: { readonly code: string; readonly message: string }
  readonly pendingInteraction?: FlowTextPendingInteraction
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
