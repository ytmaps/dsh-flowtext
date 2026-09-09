import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { FlowTextClient, FlowTextClientError } from './client.js'
import type {
  FlowTextInteractionAnswer,
  FlowTextPendingApproval,
  FlowTextPendingInteraction,
  FlowTextRunPolicy,
  FlowTextTaskSnapshot,
} from './protocol.js'
import {
  summarizeFlowTextEvent,
  summarizeTerminalTask,
  type FlowTextProgressMode,
} from './progress.js'

export type FlowTextStopReason = 'completed' | 'aborted' | 'error'

export interface FlowTextRunRequest {
  readonly prompt: readonly ContentBlock[]
  readonly signal: AbortSignal
}

export interface FlowTextRunResult {
  readonly output: ContentBlock[]
  readonly stopReason: FlowTextStopReason
  readonly diagnostic?: string
}

export interface FlowTextRun {
  readonly id: string
  readonly progress: AsyncIterable<string>
  readonly result: Promise<FlowTextRunResult>
  dispose(): Promise<void>
}

/** DSH-owned presentation channel for a FlowText interaction. */
export interface FlowTextInteractionBridge {
  ask(interaction: FlowTextPendingInteraction, signal: AbortSignal): Promise<readonly FlowTextInteractionAnswer[]>
  approve(approval: FlowTextPendingApproval, signal: AbortSignal): Promise<'once' | 'deny'>
}

/** Fully resolved inputs for one remote FlowText run. */
export interface FlowTextRunSpec {
  readonly client: FlowTextClient
  readonly clientId: string
  readonly modelId?: string
  readonly activePath?: string
  readonly contextPaths: readonly string[]
  readonly policy: FlowTextRunPolicy
  readonly runOptions: Readonly<Record<string, unknown>>
  readonly maxPromptBytes: number
  readonly maxAnswerBytes: number
  readonly progressMode: FlowTextProgressMode
  readonly onError?: (error: Error) => void
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])

class ProgressQueue implements AsyncIterable<string> {
  private readonly values: string[] = []
  private readonly seen = new Set<string>()
  private readonly waiters: Array<() => void> = []
  private closed = false

  push(value: string | undefined): void {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim()
    if (!normalized || this.closed || this.seen.has(normalized)) return
    this.seen.add(normalized)
    this.values.push(`${normalized}\n`)
    this.waiters.shift()?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const wake of this.waiters.splice(0)) wake()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const value = this.values.shift()
      if (value !== undefined) {
        yield value
        continue
      }
      if (this.closed) return
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function promptText(blocks: readonly ContentBlock[]): string {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type !== 'text') throw new Error('dsh-flowtext: only text prompt blocks are supported')
    if (block.text.trim()) texts.push(block.text)
  }
  const result = texts.join('\n\n').trim()
  if (!result) throw new Error('dsh-flowtext: prompt must contain non-empty text')
  return result
}

function safeDiagnostic(error: unknown): string {
  const message = error instanceof FlowTextClientError
    ? `${error.code}: ${error.message}`
    : (error instanceof Error ? error.message : String(error))
  const clean = message.replace(/\s+/g, ' ').trim()
  const bytes = new TextEncoder().encode(clean)
  if (bytes.byteLength <= 4096) return clean
  return new TextDecoder().decode(bytes.slice(0, 4093)) + '...'
}

function reportError(spec: FlowTextRunSpec, error: Error): void {
  try {
    spec.onError?.(error)
  } catch {
    // A diagnostic sink is observational and cannot change run settlement.
  }
}

function isInteractionCancellation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'FLOWTEXT_INTERACTION_CANCELLED'
}

function taskStopReason(task: FlowTextTaskSnapshot): FlowTextStopReason {
  switch (task.status) {
    case 'completed': return 'completed'
    case 'cancelled': return 'aborted'
    case 'failed':
    case 'timed_out':
    case 'interrupted': return 'error'
    default: return 'error'
  }
}

function failedResult(stopReason: FlowTextStopReason, diagnostic: string, output: ContentBlock[] = []): FlowTextRunResult {
  return { output, stopReason, diagnostic }
}

function taskResult(task: FlowTextTaskSnapshot, maxAnswerBytes: number): FlowTextRunResult {
  const reason = taskStopReason(task)
  const answer = String(task.result?.answer ?? '')
  if (utf8Bytes(answer) > maxAnswerBytes) {
    return failedResult('error', 'FLOWTEXT_ANSWER_TOO_LARGE: FlowText answer exceeds maxAnswerBytes')
  }
  const output: ContentBlock[] = answer ? [{ type: 'text', text: answer }] : []
  if (reason === 'completed' && task.result?.success === true) return { output, stopReason: 'completed' }
  const detail = task.error ? `${task.error.code}: ${task.error.message}` : `FlowText task ended with status ${task.status}`
  return failedResult(reason === 'completed' ? 'error' : reason, safeDiagnostic(detail), output)
}

async function waitForTerminal(
  task: FlowTextTaskSnapshot,
  spec: FlowTextRunSpec,
  signal: AbortSignal,
  progress: ProgressQueue,
  interactions?: FlowTextInteractionBridge,
): Promise<FlowTextTaskSnapshot> {
  let snapshot = task
  // Task startup can emit several UI updates before POST /tasks returns. In
  // summary mode replay the bounded task event buffer from seq 0 so those
  // early phases are visible instead of silently becoming a black box.
  let after = spec.progressMode === 'summary' ? 0 : task.lastSeq
  while (!TERMINAL_STATUSES.has(snapshot.status)) {
    if (snapshot.status === 'waiting_input' && interactions !== undefined) {
      const interaction = snapshot.pendingInteraction
      if (interaction === undefined) throw new Error('FLOWTEXT_INVALID_INTERACTION: task is waiting without question details')
      progress.push('FlowText 请求补充信息')
      const answers = await interactions.ask(interaction, signal)
      await spec.client.answerInteraction(snapshot.taskId, interaction.requestId, answers, signal)
      progress.push('已将回答发送给 FlowText，继续执行')
      const resumedEvents = await spec.client.waitForEvents(snapshot.taskId, after, signal)
      if (spec.progressMode === 'summary') {
        for (const event of resumedEvents.events) progress.push(summarizeFlowTextEvent(event))
      }
      after = Math.max(after, resumedEvents.lastSeq)
      snapshot = await spec.client.getTask(snapshot.taskId, signal)
      continue
    }
    if (snapshot.status === 'waiting_approval') {
      const approval = snapshot.pendingApproval
      if (approval === undefined) throw new Error('FLOWTEXT_INVALID_APPROVAL: task is waiting without approval details')
      if (interactions !== undefined) {
        progress.push('FlowText 请求批准危险操作')
        const decision = await interactions.approve(approval, signal)
        await spec.client.resolveApproval(snapshot.taskId, approval.requestId, decision, signal)
        progress.push(decision === 'once' ? '危险操作已允许一次' : '危险操作已拒绝')
        const resumedEvents = await spec.client.waitForEvents(snapshot.taskId, after, signal)
        if (spec.progressMode === 'summary') {
          for (const event of resumedEvents.events) progress.push(summarizeFlowTextEvent(event))
        }
        after = Math.max(after, resumedEvents.lastSeq)
        snapshot = await spec.client.getTask(snapshot.taskId, signal)
        continue
      }
    }
    const events = await spec.client.waitForEvents(snapshot.taskId, after, signal)
    if (spec.progressMode === 'summary') {
      for (const event of events.events) progress.push(summarizeFlowTextEvent(event))
    }
    after = Math.max(after, events.lastSeq)
    snapshot = await spec.client.getTask(snapshot.taskId, signal)
  }
  return snapshot
}

/**
 * Publish one remote FlowText task and own it until terminal settlement.
 * @param request - the latest DSH user task.
 * @param spec - client, authority, and response bounds.
 * @returns an owned FlowText run whose disposal cancels and awaits the task.
 */
export async function startFlowTextRun(
  request: FlowTextRunRequest,
  spec: FlowTextRunSpec,
  context: {
    readonly conversationId?: string
    readonly vaultId?: string
    readonly interactions?: FlowTextInteractionBridge
  } = {},
): Promise<FlowTextRun> {
  if (request.signal.aborted) throw new Error('dsh-flowtext: request was aborted before task creation')
  const goal = promptText(request.prompt)
  if (utf8Bytes(goal) > spec.maxPromptBytes) throw new Error('dsh-flowtext: prompt exceeds maxPromptBytes')
  const requestId = randomUUID()
  const conversationId = String(context.conversationId || requestId)
  const initial = await spec.client.createTask({
    clientId: spec.clientId,
    requestId,
    ...(context.vaultId === undefined ? {} : { vaultId: context.vaultId }),
    conversationId,
    presentation: 'agent_view',
    interactionMode: context.interactions === undefined ? 'flowtext_ui' : 'gateway_client',
    goal,
    ...(spec.modelId === undefined ? {} : { modelId: spec.modelId }),
    context: {
      ...(spec.activePath === undefined ? {} : { activePath: spec.activePath }),
      ...(spec.contextPaths.length === 0 ? {} : { paths: spec.contextPaths }),
    },
    policy: spec.policy,
    runOptions: { ...spec.runOptions, fullAgentExecution: true },
  }, request.signal)

  const progress = new ProgressQueue()
  if (spec.progressMode === 'summary') progress.push('FlowText Agent 已接管任务')

  const controller = new AbortController()
  let cancelPromise: Promise<void> | undefined
  const cancel = (): Promise<void> => {
    controller.abort()
    cancelPromise ??= spec.client.cancelTask(initial.taskId).catch((error: unknown) => {
      reportError(spec, error instanceof Error ? error : new Error(String(error)))
    })
    return cancelPromise
  }
  const onRequestAbort = (): void => { void cancel() }
  request.signal.addEventListener('abort', onRequestAbort, { once: true })
  if (request.signal.aborted) void cancel()

  let settled = false
  const result = waitForTerminal(initial, spec, controller.signal, progress, context.interactions)
    .then(task => {
      if (spec.progressMode === 'summary') progress.push(summarizeTerminalTask(task))
      return taskResult(task, spec.maxAnswerBytes)
    })
    .catch(async (error: unknown): Promise<FlowTextRunResult> => {
      if (controller.signal.aborted || request.signal.aborted || isInteractionCancellation(error)) {
        await cancel()
        return failedResult('aborted', isInteractionCancellation(error)
          ? 'FlowText interaction was cancelled in DeepSeek Harness'
          : 'FlowText task was cancelled')
      }
      const normalized = error instanceof Error ? error : new Error(String(error))
      reportError(spec, normalized)
      await cancel()
      return failedResult('error', safeDiagnostic(normalized))
    })
    .finally(() => {
      settled = true
      request.signal.removeEventListener('abort', onRequestAbort)
      progress.close()
    })

  let disposePromise: Promise<void> | undefined
  return {
    id: initial.taskId,
    progress,
    result,
    dispose() {
      disposePromise ??= (async () => {
        if (!settled) await cancel()
        await result
      })()
      return disposePromise
    },
  }
}
