import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type {
  FlowTextInteractionAnswer,
  FlowTextPendingApproval,
  FlowTextPendingInteraction,
  FlowTextPendingInteractionQuestion,
} from './protocol.js'
import type { FlowTextInteractionResolver } from './direct-adapter.js'
import type { FlowTextInteractionBridge } from './run.js'

/** Cancellation initiated from the DSH interaction surface. */
export class FlowTextInteractionCancelledError extends Error {
  readonly code = 'FLOWTEXT_INTERACTION_CANCELLED'

  constructor(message: string) {
    super(message)
    this.name = 'FlowTextInteractionCancelledError'
  }
}

interface PresentedQuestion {
  readonly item: AskUserQuestionItem
  readonly optionIds: ReadonlyMap<string, string>
  readonly source: FlowTextPendingInteractionQuestion
}

function presentedQuestions(
  interaction: FlowTextPendingInteraction,
  feedback?: string,
): readonly PresentedQuestion[] {
  return interaction.questions.map((question, questionIndex) => {
    const used = new Set<string>()
    const optionIds = new Map<string, string>()
    const options = question.options.map((option, optionIndex) => {
      const recommendation = option.recommended === true ? '（推荐）' : ''
      const base = `${option.label}${recommendation}`
      let label = base
      if (used.has(label)) label = `${base} [${String(optionIndex + 1)}]`
      while (used.has(label)) label += '+'
      used.add(label)
      optionIds.set(label, option.id)
      return {
        label,
        ...(option.description === undefined ? {} : { description: option.description }),
      }
    })
    const detail = [question.detail, questionIndex === 0 ? feedback : undefined]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .join('\n\n')
    return {
      source: question,
      optionIds,
      item: {
        id: question.id,
        question: question.question,
        ...(question.header === undefined || question.header === '' ? {} : { header: question.header }),
        ...(detail === '' ? {} : { detail }),
        ...(options.length === 0 ? {} : { options }),
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      },
    }
  })
}

function translateAnswer(
  presented: readonly PresentedQuestion[],
  response: AskUserQuestionAnswer,
): readonly FlowTextInteractionAnswer[] {
  const supplied = new Map(response.answers.map(answer => [answer.id, answer]))
  return presented.map(({ source, optionIds }) => {
    const answer = supplied.get(source.id)
    const selectedOptionIds = [...new Set((answer?.selected ?? []).map(label => optionIds.get(label)).filter(
      (value): value is string => value !== undefined,
    ))]
    if (source.multiSelect !== true && selectedOptionIds.length > 1) selectedOptionIds.splice(1)
    const customText = String(answer?.custom ?? '').trim()
    if (source.allowFreeText === false && customText !== '') {
      throw new Error(`“${source.header || source.question}”不接受自定义回答。`)
    }
    if (source.required !== false && selectedOptionIds.length === 0 && customText === '') {
      throw new Error(`请先回答“${source.header || source.question}”。`)
    }
    return {
      questionId: source.id,
      selectedOptionIds,
      ...(customText === '' ? {} : { customText }),
    }
  })
}

function cancellation(error: unknown): FlowTextInteractionCancelledError | undefined {
  if (error instanceof FlowTextInteractionCancelledError) return error
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return (error as { code?: unknown }).code === 'ASK_CANCELLED'
    ? new FlowTextInteractionCancelledError('用户在 DeepSeek Harness 中取消了 FlowText 追问')
    : undefined
}

/** Build a DSH-native interaction bridge for one exact live root Agent. */
export function createFlowTextInteractionBridge(ctx: Context, agent: Agent): FlowTextInteractionBridge {
  return {
    async ask(interaction, signal) {
      let feedback: string | undefined
      while (true) {
        signal.throwIfAborted()
        const presented = presentedQuestions(interaction, feedback)
        let response: AskUserQuestionAnswer
        try {
          response = await ctx.userQuestions.ask({
            agent,
            signal,
            questions: presented.map(value => value.item),
          })
        } catch (error: unknown) {
          throw cancellation(error) ?? error
        }
        try {
          return translateAnswer(presented, response)
        } catch (error: unknown) {
          feedback = error instanceof Error ? error.message : String(error)
        }
      }
    },
    async approve(approval: FlowTextPendingApproval, signal: AbortSignal) {
      const outcome = await ctx.approval.request({
        agent,
        signal,
        toolName: approval.kind === 'dangerous_cli' ? 'FlowText CLI' : 'FlowText external action',
        reason: approval.command || 'FlowText 请求执行危险操作',
      })
      if (outcome === 'cancelled') {
        throw new FlowTextInteractionCancelledError('用户取消了 FlowText 危险操作审批')
      }
      return outcome === 'allowed-once' ? 'once' : 'deny'
    },
  }
}

/** Resolve DSH interactions by the exact Session/Agent identity carried by the model request. */
export function createFlowTextInteractionResolver(ctx: Context): FlowTextInteractionResolver {
  return {
    resolve(sessionId: string): FlowTextInteractionBridge {
      const agent = ctx.agents.get(sessionId as Parameters<typeof ctx.agents.get>[0])
      if (agent === undefined) {
        throw new Error(`flowtext-direct: DSH session ${sessionId} has no live Agent for user interaction`)
      }
      return createFlowTextInteractionBridge(ctx, agent)
    },
  }
}
