import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { FlowTextClient, FlowTextClientError } from '../dist/client.js'
import { FileCredentialStore } from '../dist/credentials.js'
import {
  FLOWTEXT_DIRECT_MODEL,
  FLOWTEXT_DIRECT_PROVIDER,
  FlowTextDirectAdapter,
  apply,
} from '../dist/index.js'
import { startFlowTextRun } from '../dist/run.js'
import {
  FlowTextGatewayDiscovery,
  flowTextVaultModelId,
  listFlowTextGatewayTargets,
} from '../dist/registry.js'

const TOKEN = 'test-token-'.padEnd(64, 'x')
const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  })))
})

async function gateway(handler) {
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== '/flowtext-agent/v1/health') {
        assert.equal(request.headers.authorization, `Bearer ${TOKEN}`)
      }
      await handler(request, response)
    } catch (error) {
      response.statusCode = 500
      response.end(JSON.stringify({ error: { code: 'TEST_ERROR', message: error.message } }))
    }
  })
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return `http://127.0.0.1:${address.port}/flowtext-agent/v1`
}

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

function client(baseUrl, overrides = {}) {
  return new FlowTextClient({
    baseUrl,
    token: TOKEN,
    requestTimeoutMs: 500,
    longPollMs: 10,
    maxResponseBytes: 64 * 1024,
    ...overrides,
  })
}

function runSpec(flowtextClient, overrides = {}) {
  return {
    client: flowtextClient,
    clientId: 'test-harness',
    contextPaths: [],
    policy: { allowCli: false },
    runOptions: {},
    maxPromptBytes: 4096,
    maxAnswerBytes: 4096,
    progressMode: 'summary',
    ...overrides,
  }
}

function request(signal = new AbortController().signal) {
  return {
    prompt: [{ type: 'text', text: 'Summarize A.md' }],
    signal,
    descriptor: {},
    parent: {},
  }
}

test('client rejects a non-loopback endpoint before sending the token', () => {
  assert.throws(() => client('https://example.com/flowtext-agent/v1'), /loopback http URL/)
})

test('Cordis plugin registers only the fixed FlowText direct adapter', () => {
  let adapter
  let requestListener
  apply({
    llm: { registerAdapter(routes, value) { assert.deepEqual(routes, [FLOWTEXT_DIRECT_PROVIDER]); adapter = value; return () => undefined } },
    on(event, listener) { assert.equal(event, 'agent/request'); requestListener = listener; return () => undefined },
    logger: { warn() {} },
  }, {})
  assert.ok(adapter instanceof FlowTextDirectAdapter)
  assert.equal(typeof requestListener, 'function')
})

test('plugin always forces the FlowText route and removes inherited reasoning effort', async () => {
  let requestListener
  apply({
    llm: { registerAdapter() { return () => undefined } },
    on(_event, listener) { requestListener = listener; return () => undefined },
    logger: { warn() {} },
  }, {})
  const routed = await requestListener({}, async () => ({
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
    temperature: 0.2,
  }))
  assert.deepEqual(routed, {
    provider: FLOWTEXT_DIRECT_PROVIDER,
    model: FLOWTEXT_DIRECT_MODEL,
    temperature: 0.2,
  })
})

test('plugin preserves an explicitly selected FlowText vault model', async () => {
  let requestListener
  apply({
    llm: { registerAdapter() { return () => undefined } },
    on(_event, listener) { requestListener = listener; return () => undefined },
    logger: { warn() {} },
  }, {})
  const model = flowTextVaultModelId('vault-selected-1234')
  const routed = await requestListener({}, async () => ({
    provider: FLOWTEXT_DIRECT_PROVIDER,
    model,
    reasoningEffort: 'high',
  }))
  assert.deepEqual(routed, { provider: FLOWTEXT_DIRECT_PROVIDER, model })
})

test('client pairs once, persists the credential, and reuses it for requests', async () => {
  let pairCount = 0
  let saved
  const store = {
    async load() { return saved },
    async save(_baseUrl, token) { saved = token },
    async clear() { saved = undefined },
  }
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/flowtext-agent/v1/pair') {
      pairCount += 1
      assert.equal(req.headers.authorization, undefined)
      assert.equal(req.headers['content-type'], 'application/json')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
        clientId: 'test-harness',
        clientName: 'DeepSeek Harness',
        vaultId: 'vault-pair-1234',
      })
      json(res, 200, { token: TOKEN, tokenType: 'Bearer' })
      return
    }
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`)
    json(res, 200, { task: { taskId: 'paired', clientId: 'test-harness', status: 'running', lastSeq: 1 } })
  })
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}/flowtext-agent/v1`
  const paired = new FlowTextClient({
    baseUrl,
    autoPair: true,
    clientId: 'test-harness',
    clientName: 'DeepSeek Harness',
    expectedVaultId: 'vault-pair-1234',
    credentialStore: store,
    requestTimeoutMs: 500,
    longPollMs: 10,
    maxResponseBytes: 64 * 1024,
  })
  assert.equal((await paired.getTask('paired', new AbortController().signal)).taskId, 'paired')
  assert.equal((await paired.getTask('paired', new AbortController().signal)).taskId, 'paired')
  assert.equal(pairCount, 1)
  assert.equal(saved, TOKEN)
})

test('file credential store persists only the matching endpoint with owner-only permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flowtext-credential-'))
  try {
    const path = join(directory, 'nested', 'credential.json')
    const store = new FileCredentialStore(path)
    const baseUrl = 'http://127.0.0.1:27124/flowtext-agent/v1'
    await store.save(baseUrl, TOKEN)
    assert.equal(await store.load(baseUrl), TOKEN)
    assert.equal(await store.load('http://127.0.0.1:27125/flowtext-agent/v1'), undefined)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    await store.clear(baseUrl)
    assert.equal(await store.load(baseUrl), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('vault-scoped credentials survive a dynamic port change and stay isolated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flowtext-credential-scoped-'))
  try {
    const path = join(directory, 'credential.json')
    const vaultA = new FileCredentialStore(path, 'vault-a-1234')
    const vaultB = new FileCredentialStore(path, 'vault-b-1234')
    await vaultA.save('http://127.0.0.1:27124/flowtext-agent/v1', TOKEN)
    assert.equal(await vaultA.load('http://127.0.0.1:39111/flowtext-agent/v1'), TOKEN)
    assert.equal(await vaultB.load('http://127.0.0.1:27124/flowtext-agent/v1'), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('registry discovery lists live owner-only vaults and requires selection when multiple are open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flowtext-registry-'))
  try {
    const records = [
      { vaultId: 'vault-alpha-1234', vaultName: '笔记库', vaultPath: '/vault/alpha', port: 27124 },
      { vaultId: 'vault-beta-1234', vaultName: '工作库', vaultPath: '/vault/beta', port: 39111 },
    ]
    for (const record of records) {
      const path = join(directory, `${record.vaultId}.json`)
      await writeFile(path, JSON.stringify({
        version: 1,
        ...record,
        pid: process.pid,
        instanceId: `instance-${record.vaultId}`,
        protocol: 'flowtext-agent/v1',
        updatedAt: Date.now(),
      }))
      await chmod(path, 0o600)
    }
    const targets = await listFlowTextGatewayTargets(directory)
    assert.deepEqual(targets.map(item => [item.vaultId, item.port]), [
      ['vault-beta-1234', 39111],
      ['vault-alpha-1234', 27124],
    ])
    const discovery = new FlowTextGatewayDiscovery(directory)
    await assert.rejects(discovery.resolve(FLOWTEXT_DIRECT_MODEL), /多个 FlowText 仓库/)
    assert.equal((await discovery.resolve(flowTextVaultModelId('vault-beta-1234'))).vaultPath, '/vault/beta')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('direct run returns the terminal FlowText answer and sends an idempotency key', async () => {
  let createdBody
  const baseUrl = await gateway(async (req, res) => {
    if (req.method === 'POST' && req.url === '/flowtext-agent/v1/tasks') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      createdBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      json(res, 202, { task: { taskId: 'flow-1', clientId: 'test-harness', status: 'running', lastSeq: 2 } })
      return
    }
    if (req.url.startsWith('/flowtext-agent/v1/tasks/flow-1/events')) {
      json(res, 200, { taskId: 'flow-1', events: [{ taskId: 'flow-1', seq: 3, type: 'task.completed', timestamp: 1 }], lastSeq: 3 })
      return
    }
    if (req.url === '/flowtext-agent/v1/tasks/flow-1') {
      json(res, 200, { task: { taskId: 'flow-1', clientId: 'test-harness', status: 'completed', lastSeq: 3, result: { success: true, answer: 'Summary complete' } } })
      return
    }
    throw new Error(`unexpected route ${req.method} ${req.url}`)
  })
  const run = await startFlowTextRun(request(), runSpec(client(baseUrl)))
  const result = await run.result
  assert.equal(run.id, 'flow-1')
  assert.deepEqual(result, { output: [{ type: 'text', text: 'Summary complete' }], stopReason: 'completed' })
  assert.equal(createdBody.clientId, 'test-harness')
  assert.match(createdBody.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(createdBody.goal, 'Summarize A.md')
  await run.dispose()
})

test('direct adapter sends only the latest real user task and returns the FlowText answer', async () => {
  let createdBody
  const baseUrl = await gateway(async (req, res) => {
    if (req.method === 'POST' && req.url === '/flowtext-agent/v1/tasks') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      createdBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      json(res, 202, { task: { taskId: 'flow-direct', clientId: 'test-harness', status: 'running', lastSeq: 1 } })
      return
    }
    if (req.url.startsWith('/flowtext-agent/v1/tasks/flow-direct/events')) {
      json(res, 200, {
        taskId: 'flow-direct',
        events: [
          { taskId: 'flow-direct', seq: 2, type: 'agent.update', timestamp: 1, data: { type: 'plan_summary', content: 'Read and update the note' } },
          { taskId: 'flow-direct', seq: 3, type: 'agent.update', timestamp: 2, data: { type: 'action', action: { type: 'edit', path: 'Notes/A.md', replacement: 'must stay private' } } },
        ],
        lastSeq: 3,
      })
      return
    }
    if (req.url === '/flowtext-agent/v1/tasks/flow-direct') {
      json(res, 200, { task: { taskId: 'flow-direct', clientId: 'test-harness', status: 'completed', lastSeq: 4, result: { success: true, answer: 'FlowText finished everything' } } })
      return
    }
    throw new Error(`unexpected route ${req.method} ${req.url}`)
  })
  const adapter = new FlowTextDirectAdapter(
    FLOWTEXT_DIRECT_PROVIDER,
    FLOWTEXT_DIRECT_MODEL,
    runSpec(client(baseUrl)),
  )
  assert.deepEqual(adapter.providerRetryPolicy(FLOWTEXT_DIRECT_PROVIDER), {
    mode: 'normal',
    maxRetries: 0,
    retryableCodes: [],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0,
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: FLOWTEXT_DIRECT_PROVIDER,
    model: FLOWTEXT_DIRECT_MODEL,
    system: 'DSH system prompt that must not be forwarded',
    tools: [{ name: 'read_file', description: 'must not run in DSH', parameters: {} }],
    sessionId: 'dsh-session-42',
    messages: [
      { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'old task' }] },
      { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'chat' }, content: [{ type: 'text', text: 'old answer' }] },
      { id: 'p1', role: 'user', source: { kind: 'plugin', plugin: 'context' }, content: [{ type: 'text', text: 'plugin context' }] },
      { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the complete new task' }] },
    ],
  })) chunks.push(chunk)
  assert.equal(createdBody.goal, 'do the complete new task')
  assert.equal(createdBody.conversationId, 'dsh-session-42')
  assert.equal(createdBody.presentation, 'agent_view')
  assert.equal(createdBody.runOptions.fullAgentExecution, true)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'FlowText Agent 已接管任务\n' },
    { type: 'reasoning-delta', index: 0, text: '计划：Read and update the note\n' },
    { type: 'reasoning-delta', index: 0, text: '编辑：Notes/A.md\n' },
    { type: 'reasoning-delta', index: 0, text: 'FlowText Agent 执行完成\n' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'FlowText Agent 已接管任务\n计划：Read and update the note\n编辑：Notes/A.md\nFlowText Agent 执行完成\n' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'FlowText finished everything' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'FlowText finished everything' } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  assert.equal(JSON.stringify(chunks).includes('must stay private'), false)
})

test('direct adapter verifies and routes a task to the selected vault', async () => {
  const vaultId = 'vault-route-1234'
  let createdBody
  const baseUrl = await gateway(async (req, res) => {
    if (req.method === 'GET' && req.url === '/flowtext-agent/v1/health') {
      assert.equal(req.headers.authorization, undefined)
      json(res, 200, { status: 'ok', protocol: 'flowtext-agent/v1', vaultId, vaultName: '目标库' })
      return
    }
    if (req.method === 'POST' && req.url === '/flowtext-agent/v1/tasks') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      createdBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      json(res, 202, { task: { taskId: 'flow-vault', clientId: 'test-harness', status: 'running', lastSeq: 1 } })
      return
    }
    if (req.url.startsWith('/flowtext-agent/v1/tasks/flow-vault/events')) {
      json(res, 200, { taskId: 'flow-vault', events: [], lastSeq: 1 })
      return
    }
    if (req.url === '/flowtext-agent/v1/tasks/flow-vault') {
      json(res, 200, { task: { taskId: 'flow-vault', clientId: 'test-harness', status: 'completed', lastSeq: 2, result: { success: true, answer: '目标库已完成' } } })
      return
    }
    throw new Error(`unexpected route ${req.method} ${req.url}`)
  })
  const selectedClient = client(baseUrl)
  const target = {
    vaultId,
    vaultName: '目标库',
    vaultPath: '/vault/target',
    port: Number(new URL(baseUrl).port),
    baseUrl,
    modelId: flowTextVaultModelId(vaultId),
  }
  const adapter = new FlowTextDirectAdapter(
    FLOWTEXT_DIRECT_PROVIDER,
    FLOWTEXT_DIRECT_MODEL,
    runSpec(selectedClient),
    {
      async list() { return [target] },
      async resolve(modelId) {
        assert.equal(modelId, target.modelId)
        return { target, client: selectedClient }
      },
    },
  )
  assert.equal((await adapter.listModels(FLOWTEXT_DIRECT_PROVIDER))[0].id, target.modelId)
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: FLOWTEXT_DIRECT_PROVIDER,
    model: target.modelId,
    messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '在目标库执行' }] }],
  })) chunks.push(chunk)
  assert.equal(createdBody.vaultId, vaultId)
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === '目标库已完成'), true)
})

test('direct run waits for FlowText UI clarification instead of cancelling it', async () => {
  let status = 'waiting_input'
  let cancelled = false
  const baseUrl = await gateway(async (req, res) => {
    if (req.method === 'POST' && req.url === '/flowtext-agent/v1/tasks') {
      json(res, 202, { task: { taskId: 'flow-ui-input', clientId: 'test-harness', status, lastSeq: 3, pendingInteraction: { requestId: 'ask-ui-1' } } })
      return
    }
    if (req.url.includes('/events?')) {
      status = 'completed'
      json(res, 200, { taskId: 'flow-ui-input', events: [{ taskId: 'flow-ui-input', seq: 4, type: 'interaction.answered', timestamp: 1 }], lastSeq: 4 })
      return
    }
    if (req.url === '/flowtext-agent/v1/tasks/flow-ui-input') {
      json(res, 200, { task: { taskId: 'flow-ui-input', clientId: 'test-harness', status, lastSeq: 5, result: { success: true, answer: 'continued in FlowText UI' } } })
      return
    }
    if (req.method === 'POST' && req.url.endsWith('/cancel')) {
      cancelled = true
      json(res, 200, { task: { taskId: 'flow-ui-input', status: 'cancelled', lastSeq: 6 } })
      return
    }
    throw new Error(`unexpected route ${req.method} ${req.url}`)
  })
  const run = await startFlowTextRun(
    request(),
    runSpec(client(baseUrl)),
    { conversationId: 'dsh-session-ui' },
  )
  assert.deepEqual(await run.result, {
    output: [{ type: 'text', text: 'continued in FlowText UI' }],
    stopReason: 'completed',
  })
  assert.equal(cancelled, false)
})

test('request cancellation cancels the remote task and dispose reaches settlement', async () => {
  const owner = new AbortController()
  let cancelled = false
  const baseUrl = await gateway(async (req, res) => {
    if (req.method === 'POST' && req.url === '/flowtext-agent/v1/tasks') {
      json(res, 202, { task: { taskId: 'flow-cancel', clientId: 'test-harness', status: 'running', lastSeq: 2 } })
      return
    }
    if (req.method === 'POST' && req.url.endsWith('/cancel')) {
      cancelled = true
      json(res, 200, { task: { taskId: 'flow-cancel', status: 'cancelled', lastSeq: 3 } })
      return
    }
    if (req.url.includes('/events?')) {
      setTimeout(() => {
        if (!res.writableEnded) json(res, 200, { taskId: 'flow-cancel', events: [], lastSeq: 2 })
      }, 50)
      return
    }
    throw new Error(`unexpected route ${req.method} ${req.url}`)
  })
  const run = await startFlowTextRun(request(owner.signal), runSpec(client(baseUrl)))
  owner.abort()
  const result = await run.result
  assert.equal(result.stopReason, 'aborted')
  await run.dispose()
  assert.equal(cancelled, true)
})

test('client rejects an oversized response without retaining its payload', async () => {
  const baseUrl = await gateway(async (_req, res) => {
    json(res, 200, { task: { taskId: 'x'.repeat(2048), status: 'running', lastSeq: 1 } })
  })
  await assert.rejects(
    client(baseUrl, { maxResponseBytes: 128 }).getTask('x', new AbortController().signal),
    error => error instanceof FlowTextClientError && error.code === 'RESPONSE_TOO_LARGE',
  )
})

test('client rejects non-monotonic event cursors at the Gateway trust boundary', async () => {
  const baseUrl = await gateway(async (_req, res) => {
    json(res, 200, {
      taskId: 'flow-events',
      events: [
        { taskId: 'flow-events', seq: 3, type: 'task.running', timestamp: 1 },
        { taskId: 'flow-events', seq: 2, type: 'task.started', timestamp: 2 },
      ],
      lastSeq: 3,
    })
  })
  await assert.rejects(
    client(baseUrl).waitForEvents('flow-events', 1, new AbortController().signal),
    error => error instanceof FlowTextClientError && error.code === 'INVALID_RESPONSE',
  )
})
