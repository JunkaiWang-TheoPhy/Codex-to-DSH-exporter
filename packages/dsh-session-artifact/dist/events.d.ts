/**
 * Construction of DSH Session events that satisfy the current format's
 * structural invariants.
 *
 * DSH's migration catalog is a *build-static first-party* artifact: its own
 * source notes that the direct imports "make historical readability
 * independent of mounted plugins", and `defineSessionFormatMigration` rejects
 * any edge that is not adjacent (`must declare adjacent v{from}->v{from+1}`).
 * A third party cannot register a foreign format as a predecessor generation.
 * Import therefore has to *synthesize* a current-generation artifact.
 *
 * `.d.ts` type checking is not enough for that. The installed `Session`
 * validator enforces five further invariants that no type expresses, each
 * found by running the real validator:
 *
 * | # | Invariant | Rejection when violated |
 * | - | --------- | ----------------------- |
 * | C1 | Message-bearing events carry `surfaceOp` | `requires a surfaceOp marker` |
 * | C2 | Message envelopes carry a non-empty `id` | `lacks an identified message` |
 * | C3 | `assistant/message` carries `turn`, `step`, and a `stream` array | `has invalid settlement fields` |
 * | C4 | `seq` is contiguous from 0 | `has seq gap (expected N, got M)` |
 * | C5 | Unknown event types carry `ignorable: true` | surfaced through fold |
 *
 * {@link SessionBuilder} enforces C1, C2 and C4 mechanically: the sequence
 * number is owned by the builder, and the message constructors always emit a
 * marker and an id. C3 and C5 are enforced at the emit sites.
 *
 * @module
 */
/** Event types that must carry a `surfaceOp` marker (C1). */
export declare const SURFACE_ELIGIBLE_TYPES: ReadonlySet<string>;
/** A DSH message content block. */
export type ContentBlock = {
    readonly type: 'text';
    readonly text: string;
} | {
    readonly type: 'tool-call';
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
} | {
    readonly type: 'tool-result';
    readonly toolCallId: string;
    readonly content: readonly ContentBlock[];
};
/** Where a message came from, in DSH's vocabulary. */
export type MessageSource = {
    readonly kind: 'user';
} | {
    readonly kind: 'model';
    readonly provider: string;
    readonly model: string;
} | {
    readonly kind: 'plugin';
    readonly plugin: string;
} | {
    readonly kind: 'tool';
    readonly callId: string;
};
/** The turn and step a settled event belongs to. */
export interface Settlement {
    readonly turn: number;
    readonly step: number;
}
/** One physical DSH session row. */
export interface SessionRow {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data: Readonly<Record<string, unknown>>;
    readonly surfaceOp?: 'append';
    readonly ignorable?: boolean;
}
/** The physical header row of a DSH session artifact. */
export interface SessionHeader {
    readonly type: 'session';
    /**
     * The stored generation, which is not necessarily the current one.
     *
     * A session directory keeps whatever generation it was written at until the
     * harness reads and rewrites it. Measured on this machine: four sessions sit
     * at generation 0 next to thirty-nine at generation 3. Any path comparison
     * must use this value rather than {@link SESSION_FORMAT_VERSION}.
     */
    readonly version: number;
    readonly id: string;
    readonly createdAt: number;
    readonly cwd?: string;
    readonly parentSession?: string;
    /**
     * Whether the session inherited a prefix. Required from generation 1 onward;
     * generation 0 headers do not carry it at all, which is why this is optional
     * rather than `boolean`.
     */
    readonly isSeeded?: boolean;
    readonly delegationDepth: number;
    readonly agentPreset?: string;
}
/** Options for {@link SessionBuilder}. */
export interface SessionBuilderOptions {
    readonly id: string;
    readonly createdAt: number;
    readonly cwd?: string;
    readonly isSeeded?: boolean;
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
}
/**
 * Accumulates events in sequence order and encodes the final artifact.
 *
 * The builder owns `seq`, so C4 cannot be violated by a caller that emits
 * events in the order it means them. `time` is monotonically non-decreasing
 * for the same reason: DSH orders by sequence, but a non-monotonic clock makes
 * the trajectory view unreadable.
 */
export declare class SessionBuilder {
    #private;
    constructor(options: SessionBuilderOptions);
    /** The header this builder will write. */
    get header(): SessionHeader;
    /** Events emitted so far, without the header. */
    get rows(): readonly SessionRow[];
    /** The next sequence number that will be assigned. */
    get nextSeq(): number;
    /** Emit a turn boundary. */
    turnStart(time: number, turn: number): void;
    /** Emit a turn end. */
    turnEnd(time: number, turn: number, kind?: 'completed' | 'aborted' | 'failed'): void;
    /** Emit a step boundary. */
    stepStart(time: number, settlement: Settlement): void;
    /** Emit a step end. */
    stepEnd(time: number, settlement: Settlement): void;
    /** Emit a user message. Carries C1 and C2 mechanically. */
    userMessage(time: number, statementId: string, blocks: readonly ContentBlock[], source?: MessageSource): void;
    /**
     * Emit a settled assistant message.
     *
     * `stream` is emitted as an empty array (C3). The field exists to carry
     * incremental streaming records, but `message.content` already holds the
     * settled blocks, so an importer with no stream data has nothing to put
     * there. Measured against the real validator: an empty array passes, and
     * nothing downstream replays it for content.
     */
    assistantMessage(time: number, settlement: Settlement, messageId: string, blocks: readonly ContentBlock[], source: MessageSource): void;
    /** Emit a system message. Carries C1 and C2 mechanically. */
    systemMessage(time: number, settlement: Settlement, messageId: string, blocks: readonly ContentBlock[], source?: MessageSource): void;
    /**
     * Emit a tool result.
     *
     * The call it answers is named by `source.callId` and repeated on the
     * `tool-result` block. DSH pairs the two, so an importer must not emit a
     * result for a call it never emitted.
     */
    toolResult(time: number, settlement: Settlement, messageId: string, callId: string, text: string): void;
    /** Emit a tool call. Not surface-eligible, so it carries no marker. */
    toolCall(time: number, settlement: Settlement, callId: string, name: string, args: string): void;
    /** Emit the model and provider that served a turn. */
    requestContext(time: number, provider: string, model: string, contextWindow?: number): void;
    /**
     * Emit an event type DSH does not know, retained for fidelity (C5).
     *
     * `ignorable: true` is what lets the surface fold step over it. Without the
     * flag an unrecognized type is a fold error, which is why a naive
     * "preserve everything" import fails.
     */
    ignorable(time: number, type: string, data: Readonly<Record<string, unknown>>): void;
    /** Emit a session title. */
    title(time: number, title: string): void;
    /** Close the seed region so later turns inherit the imported history. */
    endSeed(time: number): void;
    /**
     * Serialize the artifact as JSONL text.
     *
     * The first line is the header and must be independently decodable: DSH's
     * zstd reader asserts the first frame contains exactly the header line.
     * @returns the artifact text, newline-terminated.
     */
    toJsonl(): string;
}
//# sourceMappingURL=events.d.ts.map