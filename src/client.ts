import type {
  FlowTextCreateTaskRequest,
  FlowTextEventsResponse,
  FlowTextTaskEvent,
  FlowTextTaskSnapshot,
} from './protocol.js'
import type { FlowTextCredentialStore } from './credentials.js'

/** HTTP client configuration after plugin defaults are resolved. */
export interface FlowTextClientOptions {
  readonly baseUrl: string
  readonly token?: string
  readonly autoPair?: boolean
  readonly clientId?: string
  readonly clientName?: string
  readonly expectedVaultId?: string
  readonly credentialStore?: FlowTextCredentialStore
  readonly requestTimeoutMs: number
  readonly longPollMs: number
  readonly maxResponseBytes: number
}

/** A safe HTTP failure that never includes credentials or raw response bodies. */
export class FlowTextClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'FlowTextClientError'
  }
}

const TASK_STATUSES = new Set([
  'queued',
  'starting',
  'running',
  'waiting_input',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
])

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FlowTextClientError(`${label} is not an object`, 'INVALID_RESPONSE')
  }
}

function assertTask(value: unknown): FlowTextTaskSnapshot {
  assertRecord(value, 'FlowText task')
  if (
    typeof value.taskId !== 'string'
    || value.taskId.length === 0
    || typeof value.status !== 'string'
    || !TASK_STATUSES.has(value.status)
    || !Number.isSafeInteger(value.lastSeq)
    || Number(value.lastSeq) < 0
  ) {
    throw new FlowTextClientError('FlowText task is missing required fields', 'INVALID_RESPONSE')
  }
  if (value.result !== undefined) {
    assertRecord(value.result, 'FlowText task result')
    if (typeof value.result.success !== 'boolean' || typeof value.result.answer !== 'string') {
      throw new FlowTextClientError('FlowText task result is invalid', 'INVALID_RESPONSE')
    }
  }
  if (value.error !== undefined) {
    assertRecord(value.error, 'FlowText task error')
    if (typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
      throw new FlowTextClientError('FlowText task error is invalid', 'INVALID_RESPONSE')
    }
  }
  if (value.pendingApproval !== undefined) {
    assertRecord(value.pendingApproval, 'FlowText pending approval')
    if (
      typeof value.pendingApproval.requestId !== 'string'
      || value.pendingApproval.requestId.length === 0
      || (value.pendingApproval.kind !== 'dangerous_cli' && value.pendingApproval.kind !== 'external_action')
      || typeof value.pendingApproval.command !== 'string'
    ) {
      throw new FlowTextClientError('FlowText pending approval is invalid', 'INVALID_RESPONSE')
    }
  }
  return value as unknown as FlowTextTaskSnapshot
}

function assertLoopbackBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('dsh-flowtext: baseUrl must be an absolute URL')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.search || url.hash) {
    throw new Error('dsh-flowtext: baseUrl must be a credential-free loopback http URL')
  }
  return url.toString().replace(/\/$/, '')
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) {
    throw new FlowTextClientError('FlowText response exceeds maxResponseBytes', 'RESPONSE_TOO_LARGE', response.status)
  }
  if (response.body === null) throw new FlowTextClientError('FlowText returned an empty response', 'INVALID_RESPONSE', response.status)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    total += item.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new FlowTextClientError('FlowText response exceeds maxResponseBytes', 'RESPONSE_TOO_LARGE', response.status)
    }
    chunks.push(item.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new FlowTextClientError('FlowText returned invalid JSON', 'INVALID_RESPONSE', response.status)
  }
}

function boundedMessage(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 512)
}

/** Minimal authenticated client for FlowText Agent Gateway v1. */
export class FlowTextClient {
  readonly baseUrl: string
  private token: string | undefined
  private resolvingToken: Promise<string> | undefined

  constructor(private readonly options: FlowTextClientOptions) {
    this.baseUrl = assertLoopbackBaseUrl(options.baseUrl)
    if (options.token !== undefined && options.token.length < 24) {
      throw new Error('dsh-flowtext: token must contain at least 24 characters')
    }
    this.token = options.token
  }

  /** Verify that a discovered loopback endpoint still belongs to the selected vault. */
  async verifyVault(vaultId: string, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([signal, timeout]),
      })
    } catch (error: unknown) {
      if (signal.aborted) throw new FlowTextClientError('FlowText vault verification was aborted', 'ABORTED')
      if (timeout.aborted) throw new FlowTextClientError('FlowText vault verification timed out', 'REQUEST_TIMEOUT')
      throw new FlowTextClientError('The selected FlowText vault is offline', 'VAULT_OFFLINE')
    }
    const payload = await readJson(response, this.options.maxResponseBytes)
    if (!response.ok) throw new FlowTextClientError(`FlowText health check returned HTTP ${response.status}`, 'VAULT_OFFLINE', response.status)
    assertRecord(payload, 'FlowText health response')
    if (payload.protocol !== 'flowtext-agent/v1' || payload.vaultId !== vaultId) {
      throw new FlowTextClientError('The selected FlowText endpoint belongs to a different vault', 'VAULT_MISMATCH')
    }
  }

  private async acquireToken(signal: AbortSignal): Promise<string> {
    if (this.token !== undefined) return this.token
    this.resolvingToken ??= (async () => {
      const stored = await this.options.credentialStore?.load(this.baseUrl)
      if (stored !== undefined) {
        this.token = stored
        return stored
      }
      if (this.options.autoPair === false) {
        throw new FlowTextClientError('FlowText token is not configured and automatic pairing is disabled', 'PAIRING_DISABLED')
      }
      const paired = await this.pair(signal)
      this.token = paired
      await this.options.credentialStore?.save(this.baseUrl, paired)
      return paired
    })().finally(() => { this.resolvingToken = undefined })
    return this.resolvingToken
  }

  private async pair(signal: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/pair`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: this.options.clientId ?? 'deepseek-harness',
          clientName: this.options.clientName ?? 'DeepSeek Harness',
          ...(this.options.expectedVaultId === undefined ? {} : { vaultId: this.options.expectedVaultId }),
        }),
        signal: AbortSignal.any([signal, timeout]),
      })
    } catch (error: unknown) {
      if (signal.aborted) throw new FlowTextClientError('FlowText pairing was aborted', 'ABORTED')
      if (timeout.aborted) throw new FlowTextClientError('FlowText pairing timed out while waiting for approval', 'PAIRING_TIMEOUT')
      const message = error instanceof Error ? boundedMessage(error.message) : 'network failure'
      throw new FlowTextClientError(`FlowText pairing failed: ${message}`, 'PAIRING_NETWORK_ERROR')
    }
    const payload = await readJson(response, this.options.maxResponseBytes)
    if (!response.ok) {
      const detail = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).error
        : undefined
      const record = detail !== null && typeof detail === 'object' && !Array.isArray(detail)
        ? detail as Record<string, unknown>
        : undefined
      const code = typeof record?.code === 'string' ? boundedMessage(record.code) : 'PAIRING_FAILED'
      const message = typeof record?.message === 'string' ? boundedMessage(record.message) : `FlowText pairing returned HTTP ${response.status}`
      throw new FlowTextClientError(message, code, response.status)
    }
    assertRecord(payload, 'FlowText pairing response')
    if (typeof payload.token !== 'string' || payload.token.length < 24 || payload.token.length > 4096) {
      throw new FlowTextClientError('FlowText pairing response has no valid token', 'INVALID_PAIRING_RESPONSE')
    }
    return payload.token
  }

  /** Create or recover an idempotent task. */
  async createTask(input: FlowTextCreateTaskRequest, signal: AbortSignal): Promise<FlowTextTaskSnapshot> {
    const body = await this.request('POST', '/tasks', input, signal)
    assertRecord(body, 'FlowText create response')
    return assertTask(body.task)
  }

  /** Read one current task snapshot. */
  async getTask(taskId: string, signal: AbortSignal): Promise<FlowTextTaskSnapshot> {
    const body = await this.request('GET', `/tasks/${encodeURIComponent(taskId)}`, undefined, signal)
    assertRecord(body, 'FlowText task response')
    return assertTask(body.task)
  }

  /** Wait for task events newer than `after`. */
  async waitForEvents(taskId: string, after: number, signal: AbortSignal): Promise<FlowTextEventsResponse> {
    const query = new URLSearchParams({ after: String(after), waitMs: String(this.options.longPollMs) })
    const body = await this.request('GET', `/tasks/${encodeURIComponent(taskId)}/events?${query}`, undefined, signal, this.options.longPollMs + this.options.requestTimeoutMs)
    assertRecord(body, 'FlowText events response')
    if (!Array.isArray(body.events) || typeof body.lastSeq !== 'number' || typeof body.taskId !== 'string') {
      throw new FlowTextClientError('FlowText events response is missing required fields', 'INVALID_RESPONSE')
    }
    let previousSeq = after
    const events = body.events.filter((event): event is FlowTextTaskEvent => {
      if (event === null || typeof event !== 'object') return false
      const candidate = event as Record<string, unknown>
      const valid = candidate.taskId === taskId
        && Number.isSafeInteger(candidate.seq)
        && Number(candidate.seq) > previousSeq
        && typeof candidate.type === 'string'
        && Number.isFinite(candidate.timestamp)
      if (valid) previousSeq = Number(candidate.seq)
      return valid
    })
    if (events.length !== body.events.length) throw new FlowTextClientError('FlowText returned an invalid task event', 'INVALID_RESPONSE')
    if (body.taskId !== taskId || !Number.isSafeInteger(body.lastSeq) || Number(body.lastSeq) < previousSeq) {
      throw new FlowTextClientError('FlowText events cursor is invalid', 'INVALID_RESPONSE')
    }
    return { taskId: body.taskId, events, lastSeq: body.lastSeq }
  }

  /** Request cancellation with an operation-owned timeout. */
  async cancelTask(taskId: string): Promise<void> {
    await this.request('POST', `/tasks/${encodeURIComponent(taskId)}/cancel`, {}, AbortSignal.timeout(this.options.requestTimeoutMs))
  }

  /** Resolve a pending FlowText approval. */
  async resolveApproval(taskId: string, requestId: string, decision: 'once' | 'session' | 'deny', signal: AbortSignal): Promise<void> {
    await this.request('POST', `/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(requestId)}/resolve`, { decision }, signal)
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<unknown> {
    const token = await this.acquireToken(signal)
    const first = await this.requestWithToken(method, path, body, signal, timeoutMs, token)
    if (first.response.status !== 401 || this.options.token !== undefined || this.options.autoPair === false) {
      return this.unwrap(first.response, first.payload)
    }
    this.token = undefined
    await this.options.credentialStore?.clear(this.baseUrl)
    const repaired = await this.acquireToken(signal)
    const second = await this.requestWithToken(method, path, body, signal, timeoutMs, repaired)
    return this.unwrap(second.response, second.payload)
  }

  private async requestWithToken(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal,
    timeoutMs: number,
    token: string,
  ): Promise<{ response: Response; payload: unknown }> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw new FlowTextClientError('FlowText request was aborted', 'ABORTED')
      if (timeout.aborted) throw new FlowTextClientError('FlowText request timed out', 'REQUEST_TIMEOUT')
      const message = error instanceof Error ? boundedMessage(error.message) : 'network failure'
      throw new FlowTextClientError(`FlowText request failed: ${message}`, 'NETWORK_ERROR')
    }
    const payload = await readJson(response, this.options.maxResponseBytes)
    return { response, payload }
  }

  private unwrap(response: Response, payload: unknown): unknown {
    if (!response.ok) {
      let code = 'HTTP_ERROR'
      let message = `FlowText returned HTTP ${response.status}`
      if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
        const error = (payload as Record<string, unknown>).error
        if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
          const detail = error as Record<string, unknown>
          if (typeof detail.code === 'string') code = boundedMessage(detail.code) || code
          if (typeof detail.message === 'string') message = boundedMessage(detail.message) || message
        }
      }
      throw new FlowTextClientError(message, code, response.status)
    }
    return payload
  }
}
