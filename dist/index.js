/** DeepSeek Harness direct FlowText Agent adapter. */
import z from '@deepseek-ai/schemastery';
import { FlowTextClient } from './client.js';
import { FileCredentialStore } from './credentials.js';
import { FLOWTEXT_DIRECT_MODEL, FLOWTEXT_DIRECT_PROVIDER, FlowTextDirectAdapter, } from './direct-adapter.js';
import { FLOWTEXT_VAULT_MODEL_PREFIX, FlowTextGatewayDiscovery } from './registry.js';
import { createFlowTextInteractionResolver } from './interactions.js';
export const name = 'flowtext-direct';
export const inject = ['llm', 'agents', 'userQuestions', 'approval'];
const DEFAULT_BASE_URL = 'http://127.0.0.1:27124/flowtext-agent/v1';
export const Config = z.object({
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
    progressMode: z.union(['off', 'summary']).default('summary'),
});
function assertPositiveInteger(name, value, maximum) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new Error(`dsh-flowtext: ${name} must be a positive safe integer no greater than ${maximum}`);
    }
}
/** Register the only execution route: FlowText Agent direct mode. */
export function apply(ctx, config) {
    const resolved = {
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
    };
    assertPositiveInteger('requestTimeoutMs', resolved.requestTimeoutMs, 10 * 60 * 1000);
    assertPositiveInteger('longPollMs', resolved.longPollMs, 30_000);
    assertPositiveInteger('maxResponseBytes', resolved.maxResponseBytes, 16 * 1024 * 1024);
    assertPositiveInteger('maxPromptBytes', resolved.maxPromptBytes, 16 * 1024 * 1024);
    assertPositiveInteger('maxAnswerBytes', resolved.maxAnswerBytes, 16 * 1024 * 1024);
    if (resolved.token !== undefined && resolved.baseUrl === undefined) {
        throw new Error('dsh-flowtext: token requires an explicit baseUrl; auto-discovered vaults pair independently');
    }
    const createClient = (baseUrl, vaultId) => new FlowTextClient({
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
    });
    const client = createClient(resolved.baseUrl ?? DEFAULT_BASE_URL);
    const spec = {
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
    };
    const discovery = resolved.baseUrl === undefined ? new FlowTextGatewayDiscovery(resolved.registryDir) : undefined;
    const clients = new Map();
    const targets = discovery === undefined ? undefined : {
        list: () => discovery.list(),
        resolve: async (modelId) => {
            const target = await discovery.resolve(modelId);
            let cached = clients.get(target.vaultId);
            if (cached === undefined || cached.baseUrl !== target.baseUrl) {
                cached = { baseUrl: target.baseUrl, client: createClient(target.baseUrl, target.vaultId) };
                clients.set(target.vaultId, cached);
            }
            return { target, client: cached.client };
        },
    };
    ctx.llm.registerAdapter([FLOWTEXT_DIRECT_PROVIDER], new FlowTextDirectAdapter(FLOWTEXT_DIRECT_PROVIDER, FLOWTEXT_DIRECT_MODEL, spec, targets, createFlowTextInteractionResolver(ctx)));
    ctx.on('agent/request', async (_payload, next) => {
        const current = await next();
        const { reasoningEffort: _reasoningEffort, ...withoutReasoningEffort } = current;
        const selectedFlowTextModel = current.provider === FLOWTEXT_DIRECT_PROVIDER
            && (current.model === FLOWTEXT_DIRECT_MODEL || current.model.startsWith(FLOWTEXT_VAULT_MODEL_PREFIX))
            ? current.model
            : FLOWTEXT_DIRECT_MODEL;
        return {
            ...withoutReasoningEffort,
            provider: FLOWTEXT_DIRECT_PROVIDER,
            model: selectedFlowTextModel,
        };
    });
}
export { FLOWTEXT_DIRECT_MODEL, FLOWTEXT_DIRECT_PROVIDER, FlowTextDirectAdapter } from './direct-adapter.js';
export { createFlowTextInteractionBridge, FlowTextInteractionCancelledError } from './interactions.js';
//# sourceMappingURL=index.js.map