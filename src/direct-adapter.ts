import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { startFlowTextRun, type FlowTextRunResult, type FlowTextRunSpec } from './run.js'
import type { FlowTextClient } from './client.js'
import type { FlowTextGatewayTarget } from './registry.js'

/** Stable DSH route used when FlowText owns the whole task loop. */
export const FLOWTEXT_DIRECT_PROVIDER = 'flowtext-direct'
/** Display-only model id for the remote FlowText agent. */
export const FLOWTEXT_DIRECT_MODEL = 'flowtext-agent'

export interface FlowTextDirectTargetResolver {
  list(): Promise<readonly FlowTextGatewayTarget[]>
  resolve(modelId: string, signal: AbortSignal): Promise<{ readonly target: FlowTextGatewayTarget; readonly client: FlowTextClient }>
}

function latestUserTask(options: GenerateOptions): string {
  const message = options.messages.findLast(item => item.role === 'user' && item.source.kind === 'user')
  if (message === undefined) throw new Error('flowtext-direct: no user task was found in the DSH request')
  const text: string[] = []
  for (const block of message.content) {
    if (block.type !== 'text') {
      throw new Error('flowtext-direct: the latest user task contains unsupported non-text content')
    }
    if (block.text.trim()) text.push(block.text)
  }
  const goal = text.join('\n\n').trim()
  if (!goal) throw new Error('flowtext-direct: the latest user task is empty')
  return goal
}

function failure(result: FlowTextRunResult): { message: string; code: string } {
  const message = result.diagnostic?.trim() || `FlowText task ended with ${result.stopReason}`
  return {
    message,
    code: result.stopReason === 'aborted' ? 'ABORTED' : 'FLOWTEXT_DIRECT_FAILED',
  }
}

/**
 * DSH model adapter that delegates one complete user task to FlowText.
 * DSH system prompts, tools, assistant history, and tool results are intentionally not forwarded.
 */
export class FlowTextDirectAdapter extends LlmAdapter {
  constructor(
    private readonly provider: string,
    private readonly model: string,
    private readonly spec: FlowTextRunSpec,
    private readonly targets?: FlowTextDirectTargetResolver,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'FlowText Direct' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return {
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: [],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.targets !== undefined) {
      const targets = await this.targets.list()
      if (targets.length > 0) {
        const nameCounts = new Map<string, number>()
        for (const target of targets) nameCounts.set(target.vaultName, (nameCounts.get(target.vaultName) ?? 0) + 1)
        return targets.map(target => ({
          provider,
          id: target.modelId,
          name: `FlowText Agent · ${target.vaultName}`,
          description: (nameCounts.get(target.vaultName) ?? 0) > 1 && target.vaultPath
            ? `FlowText 仓库：${target.vaultPath}`
            : `FlowText 仓库：${target.vaultName}`,
          inputModalities: ['text'],
        }))
      }
    }
    return [{
      provider,
      id: this.model,
      name: 'FlowText Agent',
      description: 'FlowText owns the complete agent loop; DSH receives only the final result.',
      inputModalities: ['text'],
    }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== this.provider) {
      throw new Error(`flowtext-direct: unexpected provider route ${options.provider}`)
    }
    if (this.targets === undefined && options.model !== this.model) {
      throw new Error(`flowtext-direct: unsupported model ${options.model}`)
    }
    const signal = options.signal ?? new AbortController().signal
    const resolvedTarget = this.targets === undefined
      ? undefined
      : await this.targets.resolve(options.model, signal)
    if (resolvedTarget !== undefined) await resolvedTarget.client.verifyVault(resolvedTarget.target.vaultId, signal)
    const runSpec = resolvedTarget === undefined ? this.spec : { ...this.spec, client: resolvedTarget.client }
    const request = {
      prompt: [{ type: 'text' as const, text: latestUserTask(options) }],
      signal,
    }
    const run = await startFlowTextRun(request, runSpec, {
      ...(options.sessionId === undefined ? {} : { conversationId: String(options.sessionId) }),
      ...(resolvedTarget === undefined ? {} : { vaultId: resolvedTarget.target.vaultId }),
    })
    try {
      let progressText = ''
      for await (const update of run.progress) {
        if (!progressText) yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        progressText += update
        yield { type: 'reasoning-delta', index: 0, text: update }
      }
      if (progressText) {
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: progressText } }
      }
      const result = await run.result
      if (result.stopReason !== 'completed') {
        yield {
          type: 'finish',
          reason: result.stopReason === 'aborted'
            ? { kind: 'aborted', failure: failure(result) }
            : { kind: 'error', failure: failure(result) },
        }
        return
      }
      const answer = result.output
        .filter((block): block is Extract<(typeof result.output)[number], { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n\n')
      if (answer) {
        const index = progressText ? 1 : 0
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: answer }
        yield { type: 'block-end', index, block: { type: 'text', text: answer } }
      }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      await run.dispose()
    }
  }
}
