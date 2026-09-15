/**
 * Synthesis of a DSH session artifact from a normalized Codex rollout.
 *
 * This is the L2 write path. It is implemented, typed, and tested against
 * synthetic fixtures, but the CLI exposes no way to run it against a real
 * `~/.codex` tree: the project's current phase is design, not migration.
 *
 * The mapping is deliberately asymmetric — Codex has richer and poorer
 * vocabulary than DSH in different places — so every decision below is a
 * choice rather than a translation. {@link DEFAULT_MAPPING} records them.
 *
 * @module
 */
import { SessionBuilder, } from "./events.js";
/**
 * The frozen mapping table. Changing a row is a fidelity change and belongs in
 * the changelog, because a session imported under an older table is not
 * byte-identical to one imported under a newer one.
 */
export const DEFAULT_MAPPING = {
    'session_meta/-': { kind: 'translate', into: 'session header' },
    'turn_context/-': { kind: 'translate', into: 'request/context' },
    'event_msg/task_started': { kind: 'translate', into: 'turn/start' },
    'event_msg/task_complete': { kind: 'translate', into: 'turn/end' },
    'event_msg/turn_aborted': { kind: 'translate', into: 'turn/end (aborted)' },
    'event_msg/item_completed': { kind: 'translate', into: 'step/end' },
    'response_item/message': { kind: 'translate', into: 'user|assistant|system message' },
    'response_item/function_call': { kind: 'translate', into: 'tool/call' },
    'response_item/function_call_output': { kind: 'translate', into: 'tool/result' },
    'response_item/custom_tool_call': { kind: 'translate', into: 'tool/call' },
    'response_item/custom_tool_call_output': { kind: 'translate', into: 'tool/result' },
    'response_item/web_search_call': { kind: 'translate', into: 'tool/call' },
    'event_msg/web_search_end': { kind: 'translate', into: 'tool/result' },
    'response_item/tool_search_call': { kind: 'translate', into: 'tool/call' },
    'response_item/tool_search_output': { kind: 'translate', into: 'tool/result' },
    'response_item/patch_apply_end': { kind: 'translate', into: 'tool/result' },
    'response_item/reasoning': { kind: 'preserve', as: 'codex/reasoning' },
    'event_msg/agent_reasoning': { kind: 'preserve', as: 'codex/reasoning' },
    'event_msg/token_count': { kind: 'preserve', as: 'codex/token-count' },
    'event_msg/context_compacted': { kind: 'preserve', as: 'codex/compaction' },
    'compacted/-': { kind: 'preserve', as: 'codex/compaction' },
    'response_item/ghost_snapshot': {
        kind: 'drop',
        reason: 'editor snapshot with no conversational content',
    },
    'event_msg/user_message': {
        kind: 'drop',
        reason: 'duplicate of response_item/message on the second channel; removed by dedupe',
    },
    'event_msg/agent_message': {
        kind: 'drop',
        reason: 'duplicate of response_item/message on the second channel; removed by dedupe',
    },
};
/** Time source for an entry, falling back to a synthetic monotonic clock. */
function entryTime(entry, fallback) {
    const raw = entry.origin.timestamp;
    if (raw === undefined)
        return fallback;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}
/** Derive a stable DSH session id from the rollout identity. */
function deriveSessionId(summary) {
    const id = summary.meta?.id;
    if (id !== undefined && id.length > 0)
        return `session-codex-${id}`;
    const created = summary.meta?.timestamp ?? 'unknown';
    return `session-codex-${created.replace(/[^0-9A-Za-z]/g, '')}`;
}
/**
 * Convert a parsed rollout into a DSH session artifact.
 *
 * The builder owns sequence numbers and enforces the message invariants, so
 * this function's job is ordering and pairing: it tracks which tool calls have
 * been announced, and synthesizes a `tool/call` for any result whose call is
 * missing. DSH pairs calls with results, so an orphan result would otherwise
 * be a repair case at load time.
 * @param summary - a parsed rollout.
 * @param options - synthesis options.
 * @returns the artifact text plus accounting.
 */
export function synthesizeSession(summary, options = {}) {
    const sessionId = options.sessionId ?? deriveSessionId(summary);
    const rawCwd = summary.meta?.cwd;
    const cwd = rawCwd === undefined
        ? undefined
        : (options.cwdRewrite?.(rawCwd) ?? rawCwd);
    const createdAt = Date.parse(summary.meta?.timestamp ?? '') || Date.now();
    const builder = new SessionBuilder({
        id: sessionId,
        createdAt,
        ...(cwd !== undefined ? { cwd } : {}),
    });
    const emitted = {};
    const preserved = new Set();
    const dropped = new Set();
    const orphanResults = [];
    const announcedCalls = new Map();
    const unknownLimit = options.unknownPayloadLimit ?? 2000;
    let turn = 0;
    let step = 1;
    let stepOpen = false;
    let turnOpen = false;
    let fallback = createdAt;
    let messageSeq = 0;
    let contextEmitted = false;
    const settle = () => ({ turn, step });
    const record = (type) => {
        emitted[type] = (emitted[type] ?? 0) + 1;
    };
    const nextId = (prefix) => {
        messageSeq += 1;
        return `${prefix}-${messageSeq.toString().padStart(6, '0')}`;
    };
    const closeStep = (time) => {
        if (!stepOpen)
            return;
        builder.stepEnd(time, settle());
        record('step/end');
        stepOpen = false;
    };
    /**
     * Open a turn, closing the previous one if the rollout never did.
     *
     * Codex normally pairs `task_started` with `task_complete`, but a truncated
     * or aborted rollout can close a turn it never opened. Opening lazily keeps
     * every `turn/end` matched by a `turn/start`; without it the artifact
     * carries closers with no opener, which is exactly the shape DSH's turn
     * repair exists to fix. Measured on the synthetic fixture before this guard:
     * one `turn/start` against three `turn/end`.
     */
    const openTurn = (time) => {
        if (turnOpen)
            return;
        turn += 1;
        step = 1;
        builder.turnStart(time, turn);
        record('turn/start');
        builder.stepStart(time, settle());
        record('step/start');
        stepOpen = true;
        turnOpen = true;
    };
    /** Close the open turn, if any. */
    const closeTurn = (time, kind) => {
        if (!turnOpen)
            return;
        closeStep(time);
        builder.turnEnd(time, turn, kind);
        record('turn/end');
        turnOpen = false;
    };
    for (const entry of summary.entries) {
        fallback += 1000;
        const time = entryTime(entry, fallback);
        switch (entry.kind) {
            case 'session-meta':
            case 'turn-context': {
                if (entry.kind === 'turn-context' && !contextEmitted && entry.context.model !== undefined) {
                    builder.requestContext(time, options.provider ?? summary.meta?.modelProvider ?? 'openai', options.model ?? entry.context.model);
                    record('request/context');
                    contextEmitted = true;
                }
                break;
            }
            case 'boundary': {
                if (entry.phase === 'turn-start') {
                    closeTurn(time, 'completed');
                    openTurn(time);
                }
                else if (entry.phase === 'step-end') {
                    if (stepOpen) {
                        closeStep(time);
                        step += 1;
                        builder.stepStart(time, settle());
                        record('step/start');
                        stepOpen = true;
                    }
                }
                else {
                    openTurn(time);
                    closeTurn(time, entry.phase === 'turn-aborted' ? 'aborted' : 'completed');
                }
                break;
            }
            case 'message': {
                if (entry.text.length === 0)
                    break;
                const blocks = [{ type: 'text', text: entry.text }];
                if (entry.role === 'assistant') {
                    builder.assistantMessage(time, settle(), nextId('codex-a'), blocks, {
                        kind: 'model',
                        provider: options.provider ?? summary.meta?.modelProvider ?? 'openai',
                        model: options.model ?? 'unknown',
                    });
                    record('assistant/message');
                }
                else if (entry.role === 'user') {
                    builder.userMessage(time, nextId('codex-u'), blocks);
                    record('user/message');
                }
                else if (entry.role === 'developer' || entry.role === 'system') {
                    builder.systemMessage(time, settle(), nextId('codex-s'), blocks);
                    record('system/message');
                }
                break;
            }
            case 'tool-call': {
                if (entry.callId.length === 0)
                    break;
                announcedCalls.set(entry.callId, { name: entry.name, args: entry.arguments });
                builder.toolCall(time, settle(), entry.callId, entry.name, entry.arguments);
                record('tool/call');
                break;
            }
            case 'tool-output': {
                if (entry.callId.length === 0)
                    break;
                if (!announcedCalls.has(entry.callId)) {
                    orphanResults.push(entry.callId);
                    builder.toolCall(time, settle(), entry.callId, 'unknown-tool', '{}');
                    record('tool/call');
                    announcedCalls.set(entry.callId, { name: 'unknown-tool', args: '{}' });
                }
                builder.toolResult(time, settle(), nextId('codex-r'), entry.callId, entry.output);
                record('tool/result');
                break;
            }
            case 'reasoning': {
                const key = `response_item/reasoning`;
                preserved.add(key);
                if ((options.keepReasoning ?? true) && entry.text.length > 0) {
                    builder.ignorable(time, 'codex/reasoning', {
                        text: entry.text.slice(0, unknownLimit),
                        encrypted: entry.encrypted,
                    });
                    record('codex/reasoning');
                }
                break;
            }
            case 'telemetry': {
                preserved.add('event_msg/token_count');
                if (options.keepTelemetry ?? false) {
                    builder.ignorable(time, 'codex/token-count', entry.metrics);
                    record('codex/token-count');
                }
                break;
            }
            case 'compaction': {
                preserved.add('codex/compaction');
                builder.ignorable(time, 'codex/compaction', {
                    ...(entry.replacementText !== undefined
                        ? { replacement: entry.replacementText.slice(0, unknownLimit) }
                        : {}),
                });
                record('codex/compaction');
                break;
            }
            case 'unknown': {
                const label = entry.origin.payloadType ?? 'untyped';
                preserved.add(`${entry.origin.channel}/${label}`);
                builder.ignorable(time, `codex/unknown`, {
                    source: `${entry.origin.channel}/${label}`,
                    payload: JSON.stringify(entry.payload).slice(0, unknownLimit),
                });
                record('codex/unknown');
                break;
            }
        }
    }
    closeTurn(fallback + 1000, 'completed');
    const title = firstUserText(summary);
    if (title !== undefined) {
        builder.title(fallback + 1000, title);
        record('session/title');
    }
    for (const entry of summary.entries) {
        if (entry.kind === 'unknown')
            continue;
        const key = `${entry.origin.channel}/${entry.origin.payloadType ?? '-'}`;
        const treatment = DEFAULT_MAPPING[key];
        if (treatment?.kind === 'drop')
            dropped.add(key);
    }
    const rows = builder.rows;
    return {
        sessionId,
        cwd,
        rowCount: rows.length + 1,
        jsonl: builder.toJsonl(),
        rows,
        emitted,
        preserved: [...preserved].sort(),
        dropped: [...dropped].sort(),
        orphanResults,
    };
}
/** Use the first user message as the session title, truncated. */
function firstUserText(summary) {
    for (const entry of summary.entries) {
        if (entry.kind === 'message' && entry.role === 'user' && entry.text.trim().length > 0) {
            const text = entry.text.trim().replace(/\s+/g, ' ');
            return text.length > 120 ? `${text.slice(0, 117)}...` : text;
        }
    }
    return undefined;
}
//# sourceMappingURL=synthesize.js.map