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
export const SURFACE_ELIGIBLE_TYPES: ReadonlySet<string> = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
  'system/message',
]);

/** A DSH message content block. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly type: 'tool-result'; readonly toolCallId: string; readonly content: readonly ContentBlock[] };

/** Where a message came from, in DSH's vocabulary. */
export type MessageSource =
  | { readonly kind: 'user' }
  | { readonly kind: 'model'; readonly provider: string; readonly model: string }
  | { readonly kind: 'plugin'; readonly plugin: string }
  | { readonly kind: 'tool'; readonly callId: string };

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

function assertSettlementFields(settlement: Settlement, subject: string): void {
  for (const [field, value] of [['turn', settlement.turn], ['step', settlement.step]] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new Error(`${subject} requires a non-negative safe integer ${field}, got ${String(value)}`);
    }
  }
}

/**
 * Accumulates events in sequence order and encodes the final artifact.
 *
 * The builder owns `seq`, so C4 cannot be violated by a caller that emits
 * events in the order it means them. `time` is monotonically non-decreasing
 * for the same reason: DSH orders by sequence, but a non-monotonic clock makes
 * the trajectory view unreadable.
 */
export class SessionBuilder {
  readonly #header: SessionHeader;
  readonly #rows: SessionRow[] = [];
  #nextSeq = 0;
  #lastTime: number;

  constructor(options: SessionBuilderOptions) {
    if (options.id.length === 0) throw new Error('a session id must not be empty');
    this.#header = {
      type: 'session',
      version: 3,
      id: options.id,
      createdAt: options.createdAt,
      isSeeded: options.isSeeded ?? false,
      delegationDepth: options.delegationDepth ?? 0,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.agentPreset !== undefined ? { agentPreset: options.agentPreset } : {}),
    };
    this.#lastTime = options.createdAt;
  }

  /** The header this builder will write. */
  get header(): SessionHeader {
    return this.#header;
  }

  /** Events emitted so far, without the header. */
  get rows(): readonly SessionRow[] {
    return this.#rows;
  }

  /** The next sequence number that will be assigned. */
  get nextSeq(): number {
    return this.#nextSeq;
  }

  #push(row: Omit<SessionRow, 'seq'>): void {
    const time = Math.max(row.time, this.#lastTime);
    this.#lastTime = time;
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    this.#rows.push({ ...row, seq, time });
  }

  /** Emit a turn boundary. */
  turnStart(time: number, turn: number): void {
    this.#push({ type: 'turn/start', time, data: { turn } });
  }

  /** Emit a turn end. */
  turnEnd(time: number, turn: number, kind: 'completed' | 'aborted' | 'failed' = 'completed'): void {
    this.#push({ type: 'turn/end', time, data: { turn, reason: { kind } } });
  }

  /** Emit a step boundary. */
  stepStart(time: number, settlement: Settlement): void {
    assertSettlementFields(settlement, 'step/start');
    this.#push({ type: 'step/start', time, data: { turn: settlement.turn, step: settlement.step } });
  }

  /** Emit a step end. */
  stepEnd(time: number, settlement: Settlement): void {
    assertSettlementFields(settlement, 'step/end');
    this.#push({ type: 'step/end', time, data: { turn: settlement.turn, step: settlement.step } });
  }

  /** Emit a user message. Carries C1 and C2 mechanically. */
  userMessage(time: number, statementId: string, blocks: readonly ContentBlock[], source: MessageSource = { kind: 'user' }): void {
    if (statementId.length === 0) throw new Error('user/message requires a non-empty id (C2)');
    this.#push({
      type: 'user/message',
      time,
      surfaceOp: 'append',
      data: { role: 'user', id: statementId, source, content: blocks },
    });
  }

  /**
   * Emit a settled assistant message.
   *
   * `stream` is emitted as an empty array (C3). The field exists to carry
   * incremental streaming records, but `message.content` already holds the
   * settled blocks, so an importer with no stream data has nothing to put
   * there. Measured against the real validator: an empty array passes, and
   * nothing downstream replays it for content.
   */
  assistantMessage(
    time: number,
    settlement: Settlement,
    messageId: string,
    blocks: readonly ContentBlock[],
    source: MessageSource,
  ): void {
    assertSettlementFields(settlement, 'assistant/message');
    if (messageId.length === 0) throw new Error('assistant/message requires a non-empty id (C2)');
    this.#push({
      type: 'assistant/message',
      time,
      surfaceOp: 'append',
      data: {
        turn: settlement.turn,
        step: settlement.step,
        stream: [],
        message: { role: 'assistant', id: messageId, source, content: blocks },
      },
    });
  }

  /** Emit a system message. Carries C1 and C2 mechanically. */
  systemMessage(
    time: number,
    settlement: Settlement,
    messageId: string,
    blocks: readonly ContentBlock[],
    source: MessageSource = { kind: 'plugin', plugin: 'codex-to-dsh' },
  ): void {
    assertSettlementFields(settlement, 'system/message');
    if (messageId.length === 0) throw new Error('system/message requires a non-empty id (C2)');
    this.#push({
      type: 'system/message',
      time,
      surfaceOp: 'append',
      data: {
        turn: settlement.turn,
        step: settlement.step,
        message: { role: 'system', id: messageId, source, content: blocks },
      },
    });
  }

  /**
   * Emit a tool result.
   *
   * The call it answers is named by `source.callId` and repeated on the
   * `tool-result` block. DSH pairs the two, so an importer must not emit a
   * result for a call it never emitted.
   */
  toolResult(
    time: number,
    settlement: Settlement,
    messageId: string,
    callId: string,
    text: string,
  ): void {
    assertSettlementFields(settlement, 'tool/result');
    if (messageId.length === 0) throw new Error('tool/result requires a non-empty id (C2)');
    if (callId.length === 0) throw new Error('tool/result requires a non-empty callId');
    this.#push({
      type: 'tool/result',
      time,
      surfaceOp: 'append',
      data: {
        turn: settlement.turn,
        step: settlement.step,
        message: {
          role: 'user',
          id: messageId,
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
        },
      },
    });
  }

  /** Emit a tool call. Not surface-eligible, so it carries no marker. */
  toolCall(time: number, settlement: Settlement, callId: string, name: string, args: string): void {
    assertSettlementFields(settlement, 'tool/call');
    if (callId.length === 0) throw new Error('tool/call requires a non-empty callId');
    this.#push({
      type: 'tool/call',
      time,
      data: { turn: settlement.turn, step: settlement.step, callId, name, arguments: args },
    });
  }

  /** Emit the model and provider that served a turn. */
  requestContext(time: number, provider: string, model: string, contextWindow?: number): void {
    this.#push({
      type: 'request/context',
      time,
      data: {
        provider,
        model,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        systemPromptUpdate: 'in-history',
      },
    });
  }

  /**
   * Emit an event type DSH does not know, retained for fidelity (C5).
   *
   * `ignorable: true` is what lets the surface fold step over it. Without the
   * flag an unrecognized type is a fold error, which is why a naive
   * "preserve everything" import fails.
   */
  ignorable(time: number, type: string, data: Readonly<Record<string, unknown>>): void {
    this.#push({ type, time, data, ignorable: true });
  }

  /** Emit a session title. */
  title(time: number, title: string): void {
    this.#push({ type: 'session/title', time, data: { title } });
  }

  /** Close the seed region so later turns inherit the imported history. */
  endSeed(time: number): void {
    this.#push({ type: 'session/end-seed', time, data: { inherited: true } });
  }

  /**
   * Serialize the artifact as JSONL text.
   *
   * The first line is the header and must be independently decodable: DSH's
   * zstd reader asserts the first frame contains exactly the header line.
   * @returns the artifact text, newline-terminated.
   */
  toJsonl(): string {
    const header: Record<string, unknown> = { ...this.#header };
    const lines = [JSON.stringify(header)];
    for (const row of this.#rows) lines.push(JSON.stringify(row));
    return `${lines.join('\n')}\n`;
  }
}
