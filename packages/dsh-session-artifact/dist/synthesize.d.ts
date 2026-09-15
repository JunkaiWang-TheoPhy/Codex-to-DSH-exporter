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
import { type SessionRow } from './events.ts';
import type { RolloutSummary } from '@codex-to-dsh/codex-rollout';
/** How one Codex concept is carried into DSH. */
export type Treatment = 
/** Translated into the named DSH event type. */
{
    readonly kind: 'translate';
    readonly into: string;
}
/** Kept as an `ignorable` event, preserving data DSH has no concept for. */
 | {
    readonly kind: 'preserve';
    readonly as: string;
}
/** Intentionally not carried. `reason` is required. */
 | {
    readonly kind: 'drop';
    readonly reason: string;
};
/**
 * The frozen mapping table. Changing a row is a fidelity change and belongs in
 * the changelog, because a session imported under an older table is not
 * byte-identical to one imported under a newer one.
 */
export declare const DEFAULT_MAPPING: Readonly<Record<string, Treatment>>;
/** Options controlling synthesis. */
export interface SynthesizeOptions {
    /** DSH session id. Defaults to a deterministic id derived from the rollout id. */
    readonly sessionId?: string;
    /** Provider name recorded in `request/context`. */
    readonly provider?: string;
    /** Model name recorded in `request/context`. */
    readonly model?: string;
    /**
     * Rewrite the session's working directory. Codex rollouts are portable
     * across machines, so a recorded `cwd` frequently does not exist locally.
     */
    readonly cwdRewrite?: (cwd: string) => string;
    /** Preserve reasoning text as `ignorable` events. */
    readonly keepReasoning?: boolean;
    /** Preserve token accounting as `ignorable` events. */
    readonly keepTelemetry?: boolean;
    /** Maximum characters of an unknown payload to preserve. */
    readonly unknownPayloadLimit?: number;
}
/** Result of a synthesis run, including the accounting a caller needs to judge it. */
export interface SynthesizeResult {
    readonly sessionId: string;
    readonly cwd: string | undefined;
    readonly rowCount: number;
    readonly jsonl: string;
    readonly rows: readonly SessionRow[];
    /** Events emitted per DSH type. */
    readonly emitted: Readonly<Record<string, number>>;
    /** Codex types that were preserved as `ignorable` rather than translated. */
    readonly preserved: readonly string[];
    /** Codex types that were dropped, with the reason. */
    readonly dropped: readonly string[];
    /** Tool outputs whose matching call was absent and had to be synthesized. */
    readonly orphanResults: readonly string[];
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
export declare function synthesizeSession(summary: RolloutSummary, options?: SynthesizeOptions): SynthesizeResult;
//# sourceMappingURL=synthesize.d.ts.map