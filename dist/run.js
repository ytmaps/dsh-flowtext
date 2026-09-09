import { randomUUID } from 'node:crypto';
import { FlowTextClient, FlowTextClientError } from './client.js';
import { summarizeFlowTextEvent, summarizeTerminalTask, } from './progress.js';
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
class ProgressQueue {
    values = [];
    seen = new Set();
    waiters = [];
    closed = false;
    push(value) {
        const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
        if (!normalized || this.closed || this.seen.has(normalized))
            return;
        this.seen.add(normalized);
        this.values.push(`${normalized}\n`);
        this.waiters.shift()?.();
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const wake of this.waiters.splice(0))
            wake();
    }
    async *[Symbol.asyncIterator]() {
        while (true) {
            const value = this.values.shift();
            if (value !== undefined) {
                yield value;
                continue;
            }
            if (this.closed)
                return;
            await new Promise(resolve => this.waiters.push(resolve));
        }
    }
}
function utf8Bytes(value) {
    return new TextEncoder().encode(value).byteLength;
}
function promptText(blocks) {
    const texts = [];
    for (const block of blocks) {
        if (block.type !== 'text')
            throw new Error('dsh-flowtext: only text prompt blocks are supported');
        if (block.text.trim())
            texts.push(block.text);
    }
    const result = texts.join('\n\n').trim();
    if (!result)
        throw new Error('dsh-flowtext: prompt must contain non-empty text');
    return result;
}
function safeDiagnostic(error) {
    const message = error instanceof FlowTextClientError
        ? `${error.code}: ${error.message}`
        : (error instanceof Error ? error.message : String(error));
    const clean = message.replace(/\s+/g, ' ').trim();
    const bytes = new TextEncoder().encode(clean);
    if (bytes.byteLength <= 4096)
        return clean;
    return new TextDecoder().decode(bytes.slice(0, 4093)) + '...';
}
function reportError(spec, error) {
    try {
        spec.onError?.(error);
    }
    catch {
        // A diagnostic sink is observational and cannot change run settlement.
    }
}
function taskStopReason(task) {
    switch (task.status) {
        case 'completed': return 'completed';
        case 'cancelled': return 'aborted';
        case 'failed':
        case 'timed_out':
        case 'interrupted': return 'error';
        default: return 'error';
    }
}
function failedResult(stopReason, diagnostic, output = []) {
    return { output, stopReason, diagnostic };
}
function taskResult(task, maxAnswerBytes) {
    const reason = taskStopReason(task);
    const answer = String(task.result?.answer ?? '');
    if (utf8Bytes(answer) > maxAnswerBytes) {
        return failedResult('error', 'FLOWTEXT_ANSWER_TOO_LARGE: FlowText answer exceeds maxAnswerBytes');
    }
    const output = answer ? [{ type: 'text', text: answer }] : [];
    if (reason === 'completed' && task.result?.success === true)
        return { output, stopReason: 'completed' };
    const detail = task.error ? `${task.error.code}: ${task.error.message}` : `FlowText task ended with status ${task.status}`;
    return failedResult(reason === 'completed' ? 'error' : reason, safeDiagnostic(detail), output);
}
async function waitForTerminal(task, spec, signal, progress) {
    let snapshot = task;
    // Task startup can emit several UI updates before POST /tasks returns. In
    // summary mode replay the bounded task event buffer from seq 0 so those
    // early phases are visible instead of silently becoming a black box.
    let after = spec.progressMode === 'summary' ? 0 : task.lastSeq;
    while (!TERMINAL_STATUSES.has(snapshot.status)) {
        if (snapshot.status === 'waiting_approval') {
            const approval = snapshot.pendingApproval;
            if (approval === undefined)
                throw new Error('FLOWTEXT_INVALID_APPROVAL: task is waiting without approval details');
        }
        const events = await spec.client.waitForEvents(snapshot.taskId, after, signal);
        if (spec.progressMode === 'summary') {
            for (const event of events.events)
                progress.push(summarizeFlowTextEvent(event));
        }
        after = Math.max(after, events.lastSeq);
        snapshot = await spec.client.getTask(snapshot.taskId, signal);
    }
    return snapshot;
}
/**
 * Publish one remote FlowText task and own it until terminal settlement.
 * @param request - the latest DSH user task.
 * @param spec - client, authority, and response bounds.
 * @returns an owned FlowText run whose disposal cancels and awaits the task.
 */
export async function startFlowTextRun(request, spec, context = {}) {
    if (request.signal.aborted)
        throw new Error('dsh-flowtext: request was aborted before task creation');
    const goal = promptText(request.prompt);
    if (utf8Bytes(goal) > spec.maxPromptBytes)
        throw new Error('dsh-flowtext: prompt exceeds maxPromptBytes');
    const requestId = randomUUID();
    const conversationId = String(context.conversationId || requestId);
    const initial = await spec.client.createTask({
        clientId: spec.clientId,
        requestId,
        ...(context.vaultId === undefined ? {} : { vaultId: context.vaultId }),
        conversationId,
        presentation: 'agent_view',
        goal,
        ...(spec.modelId === undefined ? {} : { modelId: spec.modelId }),
        context: {
            ...(spec.activePath === undefined ? {} : { activePath: spec.activePath }),
            ...(spec.contextPaths.length === 0 ? {} : { paths: spec.contextPaths }),
        },
        policy: spec.policy,
        runOptions: { ...spec.runOptions, fullAgentExecution: true },
    }, request.signal);
    const progress = new ProgressQueue();
    if (spec.progressMode === 'summary')
        progress.push('FlowText Agent 已接管任务');
    const controller = new AbortController();
    let cancelPromise;
    const cancel = () => {
        controller.abort();
        cancelPromise ??= spec.client.cancelTask(initial.taskId).catch((error) => {
            reportError(spec, error instanceof Error ? error : new Error(String(error)));
        });
        return cancelPromise;
    };
    const onRequestAbort = () => { void cancel(); };
    request.signal.addEventListener('abort', onRequestAbort, { once: true });
    if (request.signal.aborted)
        void cancel();
    let settled = false;
    const result = waitForTerminal(initial, spec, controller.signal, progress)
        .then(task => {
        if (spec.progressMode === 'summary')
            progress.push(summarizeTerminalTask(task));
        return taskResult(task, spec.maxAnswerBytes);
    })
        .catch(async (error) => {
        if (controller.signal.aborted || request.signal.aborted) {
            await cancel();
            return failedResult('aborted', 'FlowText task was cancelled');
        }
        const normalized = error instanceof Error ? error : new Error(String(error));
        reportError(spec, normalized);
        await cancel();
        return failedResult('error', safeDiagnostic(normalized));
    })
        .finally(() => {
        settled = true;
        request.signal.removeEventListener('abort', onRequestAbort);
        progress.close();
    });
    let disposePromise;
    return {
        id: initial.taskId,
        progress,
        result,
        dispose() {
            disposePromise ??= (async () => {
                if (!settled)
                    await cancel();
                await result;
            })();
            return disposePromise;
        },
    };
}
//# sourceMappingURL=run.js.map