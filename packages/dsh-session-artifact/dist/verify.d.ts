/**
 * Validation of a synthesized artifact against the invariants DSH enforces.
 *
 * The point of this module is to fail *before* a file reaches `~/.dsh`. Every
 * invariant below was verified by running DSH's own validators and reading the
 * rejection it produced; the messages quoted in {@link SessionInvariant} are
 * the real ones. A round-trip that only checked `.d.ts` types would pass while
 * the artifact failed to load.
 *
 * When the DSH packages are resolvable, {@link verifyWithDsh} additionally
 * runs the authoritative codec and the installed `Session` validator. That
 * path is optional: the structural checks here have no DSH dependency and are
 * what the test suite relies on.
 *
 * @module
 */
import type { SessionHeader, SessionRow } from './events.ts';
/** A single failed check. */
export interface Violation {
    /** Stable identifier for the invariant, e.g. `C4-seq-contiguous`. */
    readonly code: string;
    /** The quoted error DSH produces when this is violated. */
    readonly dshMessage: string;
    /** Where it failed, if the invariant is per-row. */
    readonly at?: number | string;
    readonly detail: string;
}
/** Outcome of a verification run. */
export interface VerificationReport {
    readonly ok: boolean;
    readonly violations: readonly Violation[];
    /** Checks that ran, for reporting coverage rather than just pass/fail. */
    readonly checksRun: readonly string[];
    /** Whether the authoritative DSH validator was reachable and used. */
    readonly dshNative: boolean;
}
/**
 * Parse artifact JSONL text into a header and rows.
 * @param jsonl - artifact text.
 * @returns the parsed parts, or a violation when the text is unusable.
 */
export declare function parseArtifact(jsonl: string): {
    header: SessionHeader;
    rows: SessionRow[];
} | Violation;
/**
 * Check a synthesized artifact against every invariant that does not require DSH.
 * @param jsonl - artifact text as it will be written.
 * @param root - the DSH sessions root the artifact will live under, for the path check.
 * @returns the verification report.
 */
export declare function verifyArtifact(jsonl: string, root?: string): VerificationReport;
//# sourceMappingURL=verify.d.ts.map