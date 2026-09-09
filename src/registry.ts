import { lstat, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const FLOWTEXT_VAULT_MODEL_PREFIX = 'flowtext-vault:'
const MAX_RECORD_AGE_MS = 60_000

export interface FlowTextGatewayTarget {
  readonly vaultId: string
  readonly vaultName: string
  readonly vaultPath: string
  readonly port: number
  readonly baseUrl: string
  readonly modelId: string
}

interface RegistryRecord {
  readonly version: 1
  readonly vaultId: string
  readonly vaultName: string
  readonly vaultPath: string
  readonly port: number
  readonly pid: number
  readonly protocol: 'flowtext-agent/v1'
  readonly updatedAt: number
}

function defaultRegistryDirectory(): string {
  return join(homedir(), '.flowtext', 'agent-gateways')
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/[\r\n\0]/g, '').trim().slice(0, maximum) : ''
}

function parseRecord(value: unknown, now: number): RegistryRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const vaultId = boundedText(item.vaultId, 128)
  const vaultName = boundedText(item.vaultName, 256)
  const vaultPath = boundedText(item.vaultPath, 4096)
  const port = Number(item.port)
  const pid = Number(item.pid)
  const updatedAt = Number(item.updatedAt)
  if (
    item.version !== 1
    || item.protocol !== 'flowtext-agent/v1'
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(vaultId)
    || !vaultName
    || !Number.isSafeInteger(port) || port < 1024 || port > 65535
    || !Number.isSafeInteger(pid) || pid <= 0
    || !Number.isFinite(updatedAt) || updatedAt > now + 10_000 || now - updatedAt > MAX_RECORD_AGE_MS
  ) return undefined
  return { version: 1, vaultId, vaultName, vaultPath, port, pid, protocol: 'flowtext-agent/v1', updatedAt }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function flowTextVaultModelId(vaultId: string): string {
  return `${FLOWTEXT_VAULT_MODEL_PREFIX}${vaultId}`
}

/** Read live owner-only records written by FlowText vault instances. */
export async function listFlowTextGatewayTargets(
  directory = process.env.FLOWTEXT_GATEWAY_REGISTRY_DIR?.trim() || defaultRegistryDirectory(),
  now = Date.now(),
): Promise<FlowTextGatewayTarget[]> {
  let names: string[]
  try {
    names = await readdir(resolve(directory))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const targets: FlowTextGatewayTarget[] = []
  for (const name of names.filter(item => item.endsWith('.json'))) {
    const path = join(resolve(directory), name)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) continue
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) continue
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) continue
      const record = parseRecord(JSON.parse(await readFile(path, 'utf8')) as unknown, now)
      if (record === undefined || !processIsAlive(record.pid)) continue
      targets.push({
        vaultId: record.vaultId,
        vaultName: record.vaultName,
        vaultPath: record.vaultPath,
        port: record.port,
        baseUrl: `http://127.0.0.1:${record.port}/flowtext-agent/v1`,
        modelId: flowTextVaultModelId(record.vaultId),
      })
    } catch {
      // A partially replaced, stale, or malformed record is not a live target.
    }
  }
  return targets.sort((left, right) => (
    left.vaultName.localeCompare(right.vaultName)
    || left.vaultPath.localeCompare(right.vaultPath)
    || left.vaultId.localeCompare(right.vaultId)
  ))
}

export class FlowTextGatewayDiscovery {
  constructor(private readonly directory?: string) {}

  list(): Promise<FlowTextGatewayTarget[]> {
    return listFlowTextGatewayTargets(this.directory)
  }

  async resolve(modelId: string): Promise<FlowTextGatewayTarget> {
    const targets = await this.list()
    if (modelId === 'flowtext-agent') {
      if (targets.length === 1) return targets[0]!
      if (targets.length === 0) {
        throw new Error('未发现已启用 Gateway 的 FlowText 仓库；请打开 Obsidian 仓库并启用 FlowText Agent Gateway')
      }
      throw new Error('已发现多个 FlowText 仓库；请在 DSH 模型选择器中明确选择目标仓库')
    }
    if (!modelId.startsWith(FLOWTEXT_VAULT_MODEL_PREFIX)) {
      throw new Error(`flowtext-direct: unsupported model ${modelId}`)
    }
    const target = targets.find(item => item.modelId === modelId)
    if (target === undefined) throw new Error('目标 FlowText 仓库当前未打开或 Gateway 已离线')
    return target
  }
}
