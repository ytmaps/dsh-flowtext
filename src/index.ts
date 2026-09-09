/** DeepSeek Harness direct FlowText Agent adapter. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import { FlowTextClient } from './client.js'
import { FileCredentialStore } from './credentials.js'
import {
  FLOWTEXT_DIRECT_MODEL,
  FLOWTEXT_DIRECT_PROVIDER,
  FlowTextDirectAdapter,
} from './direct-adapter.js'
import type { FlowTextProgressMode } from './progress.js'
import { FLOWTEXT_VAULT_MODEL_PREFIX, FlowTextGatewayDiscovery } from './registry.js'
import type { FlowTextRunSpec } from './run.js'
import { createFlowTextInteractionResolver } from './interactions.js'

export const name = 'flowtext-direct'
export const inject = ['llm', 'agents', 'userQuestions', 'approval']

const DEFAULT_BASE_URL = 'http://127.0.0.1:27124/flowtext-agent/v1'

export interface Config {
  baseUrl?: string
  registryDir?: string
  token?: string
  autoPair?: boolean
  credentialPath?: string
  clientName?: string
  clientId?: string
  modelId?: string
  activePath?: string
  contextPaths?: string[]
  runOptions?: Record<string, unknown>
  requestTimeoutMs?: number
  longPollMs?: number
  maxResponseBytes?: number
  maxPromptBytes?: number
  maxAnswerBytes?: number
  progressMode?: FlowTextProgressMode
}

export const Config: z<Config> = z.object({
  baseUrl: z.string(),
  registryDir: z.string(),
  token: z.string().min(24),
  autoPair: z.boolean().default(true),
  credentialPath: z.string(),
  clientName: z.string().min(1).default('DeepSeek Harness'),
  clientId: z.string().min(1).default('deepseek-harness'),
  modelId: z.string(),
  activePath: z.string(),
  contextPaths: z.array(z.string()).default([]),
  runOptions: z.dict(z.any()).default({}),
  requestTimeoutMs: z.number().default(30_000),
  longPollMs: z.number().default(25_000),
  maxResponseBytes: z.number().default(2 * 1024 * 1024),
  maxPromptBytes: z.number().default(1024 * 1024),
  maxAnswerBytes: z.number().default(1024 * 1024),
  progressMode: z.union(['off', 'summary'] as const).default('summary'),
})

type ResolvedConfig = Required<Omit<Config, 'baseUrl' | 'registryDir' | 'token' | 'credentialPath' | 'modelId' | 'activePath'>> & {
  baseUrl: string | undefined
  registryDir: string | undefined
  token: string | undefined
  credentialPath: string | undefined
  modelId: string | undefined
  activePath: string | undefined
}

function assertPositiveInteger(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`dsh-flowtext: ${name} must be a positive safe integer no greater than ${maximum}`)
  }
}

/** Register the only execution route: FlowText Agent direct mode. */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    baseUrl: config.baseUrl,
    registryDir: config.registryDir,
    token: config.token,
    autoPair: config.autoPair ?? true,
    credentialPath: config.credentialPath,
    clientName: config.clientName ?? 'DeepSeek Harness',
    clientId: config.clientId ?? 'deepseek-harness',
    modelId: config.modelId,
    activePath: config.activePath,
    contextPaths: config.contextPaths ?? [],
    runOptions: config.runOptions ?? {},
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
    longPollMs: config.longPollMs ?? 25_000,
    maxResponseBytes: config.maxResponseBytes ?? 2 * 1024 * 1024,
    maxPromptBytes: config.maxPromptBytes ?? 1024 * 1024,
    maxAnswerBytes: config.maxAnswerBytes ?? 1024 * 1024,
    progressMode: config.progressMode ?? 'summary',
  }
  assertPositiveInteger('requestTimeoutMs', resolved.requestTimeoutMs, 10 * 60 * 1000)
  assertPositiveInteger('longPollMs', resolved.longPollMs, 30_000)
  assertPositiveInteger('maxResponseBytes', resolved.maxResponseBytes, 16 * 1024 * 1024)
  assertPositiveInteger('maxPromptBytes', resolved.maxPromptBytes, 16 * 1024 * 1024)
  assertPositiveInteger('maxAnswerBytes', resolved.maxAnswerBytes, 16 * 1024 * 1024)
  if (resolved.token !== undefined && resolved.baseUrl === undefined) {
    throw new Error('dsh-flowtext: token requires an explicit baseUrl; auto-discovered vaults pair independently')
  }

  const createClient = (baseUrl: string, vaultId?: string): FlowTextClient => new FlowTextClient({
    baseUrl,
    autoPair: resolved.autoPair,
    clientId: resolved.clientId,
    clientName: resolved.clientName,
    ...(vaultId === undefined ? {} : { expectedVaultId: vaultId }),
    credentialStore: new FileCredentialStore(resolved.credentialPath, vaultId),
    ...(resolved.token === undefined ? {} : { token: resolved.token }),
    requestTimeoutMs: resolved.requestTimeoutMs,
    longPollMs: resolved.longPollMs,
    maxResponseBytes: resolved.maxResponseBytes,
  })
  const client = createClient(resolved.baseUrl ?? DEFAULT_BASE_URL)
  const spec: FlowTextRunSpec = {
    client,
    clientId: resolved.clientId,
    ...(resolved.modelId === undefined ? {} : { modelId: resolved.modelId }),
    ...(resolved.activePath === undefined ? {} : { activePath: resolved.activePath }),
    contextPaths: resolved.contextPaths,
    policy: {},
    runOptions: resolved.runOptions,
    maxPromptBytes: resolved.maxPromptBytes,
    maxAnswerBytes: resolved.maxAnswerBytes,
    progressMode: resolved.progressMode,
    onError: error => ctx.logger.warn(`flowtext-direct: ${error.message}`),
  }
  const discovery = resolved.baseUrl === undefined ? new FlowTextGatewayDiscovery(resolved.registryDir) : undefined
  const clients = new Map<string, { baseUrl: string; client: FlowTextClient }>()
  const targets = discovery === undefined ? undefined : {
    list: () => discovery.list(),
    resolve: async (modelId: string) => {
      const target = await discovery.resolve(modelId)
      let cached = clients.get(target.vaultId)
      if (cached === undefined || cached.baseUrl !== target.baseUrl) {
        cached = { baseUrl: target.baseUrl, client: createClient(target.baseUrl, target.vaultId) }
        clients.set(target.vaultId, cached)
      }
      return { target, client: cached.client }
    },
  }
  ctx.llm.registerAdapter(
    [FLOWTEXT_DIRECT_PROVIDER],
    new FlowTextDirectAdapter(
      FLOWTEXT_DIRECT_PROVIDER,
      FLOWTEXT_DIRECT_MODEL,
      spec,
      targets,
      createFlowTextInteractionResolver(ctx),
    ),
  )

  ctx.on('agent/request', async (_payload, next) => {
    const current = await next()
    const { reasoningEffort: _reasoningEffort, ...withoutReasoningEffort } = current
    const selectedFlowTextModel = current.provider === FLOWTEXT_DIRECT_PROVIDER
      && (current.model === FLOWTEXT_DIRECT_MODEL || current.model.startsWith(FLOWTEXT_VAULT_MODEL_PREFIX))
      ? current.model
      : FLOWTEXT_DIRECT_MODEL
    return {
      ...withoutReasoningEffort,
      provider: FLOWTEXT_DIRECT_PROVIDER,
      model: selectedFlowTextModel,
    }
  })
}

export type { FlowTextRunSpec } from './run.js'
export type { FlowTextProgressMode } from './progress.js'
export type { FlowTextRunPolicy } from './protocol.js'
export type { FlowTextCredentialStore } from './credentials.js'
export { FLOWTEXT_DIRECT_MODEL, FLOWTEXT_DIRECT_PROVIDER, FlowTextDirectAdapter } from './direct-adapter.js'
export { createFlowTextInteractionBridge, FlowTextInteractionCancelledError } from './interactions.js'
