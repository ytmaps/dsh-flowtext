import type { FlowTextTaskEvent, FlowTextTaskSnapshot } from './protocol.js'

export type FlowTextProgressMode = 'off' | 'summary'

const PHASE_LABELS: Readonly<Record<string, string>> = {
  classifying: '正在分析任务',
  planning: '正在制定执行计划',
  acting: '正在执行任务',
  observing: '正在检查执行结果',
  verifying: '正在验证修改',
  finalizing: '正在整理最终结果',
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  read: '读取',
  read_file: '读取',
  list: '列出',
  list_files: '列出',
  search: '查找',
  search_files: '查找',
  grep: '查找',
  write: '写入',
  write_file: '写入',
  edit: '编辑',
  edit_file: '编辑',
  create: '创建',
  create_file: '创建',
  delete: '删除',
  delete_file: '删除',
  move: '移动',
  rename: '重命名',
  web_search: '联网查找',
  cli: '执行命令',
  run_command: '执行命令',
  ask_user: '请求用户补充信息',
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedText(value: unknown, maximum = 400): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`
}

function safePath(action: Record<string, unknown>): string {
  for (const key of ['path', 'filePath', 'sourcePath', 'targetPath', 'directory']) {
    const value = boundedText(action[key], 240)
    if (value) return value
  }
  return ''
}

function actionSummary(value: unknown): string | undefined {
  const action = record(value)
  if (action === undefined) return undefined
  const type = boundedText(action.type, 80).toLowerCase()
  if (!type) return undefined
  const label = ACTION_LABELS[type] ?? '执行工具'
  const path = safePath(action)
  return path ? `${label}：${path}` : label
}

/** Convert an opaque FlowText event into a bounded, non-executable DSH status line. */
export function summarizeFlowTextEvent(event: FlowTextTaskEvent): string | undefined {
  const data = record(event.data)
  if (event.type === 'task.status') {
    switch (data?.status) {
      case 'starting': return 'FlowText Agent 正在启动'
      case 'running': return 'FlowText Agent 已接管任务'
      case 'waiting_input': return 'FlowText 请求补充信息'
      case 'waiting_approval': return 'FlowText 请求批准危险操作'
      default: return undefined
    }
  }
  if (event.type === 'approval.requested') return 'FlowText 请求批准危险操作'
  if (event.type === 'interaction.requested') return 'FlowText 请求补充信息'
  if (event.type !== 'agent.update' || data === undefined) return undefined
  switch (data.type) {
    case 'phase': return PHASE_LABELS[boundedText(data.phase, 80).toLowerCase()]
    case 'thinking': return '正在分析与规划'
    case 'plan_summary': {
      const content = boundedText(data.content)
      return content ? `计划：${content}` : undefined
    }
    case 'action': return actionSummary(data.action)
    case 'action_batch_start': return '正在并行执行多个工具'
    case 'context_compress': return '正在整理上下文'
    default: return undefined
  }
}

export function summarizeTerminalTask(task: FlowTextTaskSnapshot): string {
  switch (task.status) {
    case 'completed': return 'FlowText Agent 执行完成'
    case 'cancelled': return 'FlowText Agent 任务已取消'
    case 'timed_out': return 'FlowText Agent 任务超时'
    case 'failed':
    case 'interrupted': return 'FlowText Agent 执行失败'
    default: return ''
  }
}
