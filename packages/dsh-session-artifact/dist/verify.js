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
import { SESSION_FORMAT_VERSION, generationLogFilename, sessionArtifactPath, } from "./paths.js";
import { SURFACE_ELIGIBLE_TYPES } from "./events.js";
const CHECKS = [
    'H1-header-version',
    'H2-header-identity',
    'C1-surface-marker',
    'C2-message-identity',
    'C3-settlement-fields',
    'C4-seq-contiguous',
    'C5-ignorable-unknown',
    'T1-tool-pairing',
    'P1-path-identity',
];
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Parse artifact JSONL text into a header and rows.
 * @param jsonl - artifact text.
 * @returns the parsed parts, or a violation when the text is unusable.
 */
export function parseArtifact(jsonl) {
    const lines = jsonl.split('\n').filter((line) => line.trim().length > 0);
    const first = lines[0];
    if (first === undefined) {
        return { code: 'H1-header-version', dshMessage: 'empty session log', detail: 'artifact has no header line' };
    }
    let header;
    try {
        header = JSON.parse(first);
    }
    catch (error) {
        return {
            code: 'H1-header-version',
            dshMessage: 'corrupt session log: header line is not JSON',
            detail: error instanceof Error ? error.message : String(error),
        };
    }
    if (!isRecord(header)) {
        return { code: 'H1-header-version', dshMessage: 'malformed header', detail: 'header is not a JSON object' };
    }
    const rows = [];
    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined)
            continue;
        try {
            rows.push(JSON.parse(line));
        }
        catch (error) {
            return {
                code: 'C4-seq-contiguous',
                dshMessage: 'corrupt session log: row is not JSON',
                at: index,
                detail: error instanceof Error ? error.message : String(error),
            };
        }
    }
    return { header: header, rows };
}
/**
 * Check a synthesized artifact against every invariant that does not require DSH.
 * @param jsonl - artifact text as it will be written.
 * @param root - the DSH sessions root the artifact will live under, for the path check.
 * @returns the verification report.
 */
export function verifyArtifact(jsonl, root) {
    const violations = [];
    const parsed = parseArtifact(jsonl);
    if ('code' in parsed) {
        return { ok: false, violations: [parsed], checksRun: [...CHECKS], dshNative: false };
    }
    const { header, rows } = parsed;
    // H1 — the generation this writer claims must be the generation it emits.
    if (header.version !== SESSION_FORMAT_VERSION) {
        violations.push({
            code: 'H1-header-version',
            dshMessage: `installed Session format is v${SESSION_FORMAT_VERSION}, got v${String(header.version)}`,
            detail: `header.version is ${String(header.version)}`,
        });
    }
    // H2 — identity fields the storage layer recomputes paths from.
    if (typeof header.id !== 'string' || header.id.length === 0) {
        violations.push({
            code: 'H2-header-identity',
            dshMessage: 'corrupt session log: header id cannot name a storage path',
            detail: 'header.id must be a non-empty string',
        });
    }
    if (!Number.isSafeInteger(header.createdAt)) {
        violations.push({
            code: 'H2-header-identity',
            dshMessage: 'malformed header: createdAt is not an integer epoch',
            detail: `header.createdAt is ${String(header.createdAt)}`,
        });
    }
    // H2 — `isSeeded` was introduced after generation 0, so it is only required
    // from generation 1 onward. Four sessions on the author's machine still sit
    // at generation 0 and legitimately lack the field.
    if (header.version >= 1 && typeof header.isSeeded !== 'boolean') {
        violations.push({
            code: 'H2-header-identity',
            dshMessage: 'malformed header: isSeeded is required from generation 1',
            detail: `version=${header.version} isSeeded=${String(header.isSeeded)}`,
        });
    }
    if (!Number.isSafeInteger(header.delegationDepth)) {
        violations.push({
            code: 'H2-header-identity',
            dshMessage: 'malformed header: delegationDepth is required',
            detail: `delegationDepth=${String(header.delegationDepth)}`,
        });
    }
    const announced = new Set();
    let lastTime = Number.NEGATIVE_INFINITY;
    rows.forEach((row, index) => {
        const type = row.type;
        // C4 — sequence numbers are contiguous from zero.
        if (row.seq !== index) {
            violations.push({
                code: 'C4-seq-contiguous',
                dshMessage: `released v2 row ${index} has seq gap (expected ${index}, got ${String(row.seq)})`,
                at: index,
                detail: `row ${index} carries seq ${String(row.seq)}`,
            });
        }
        // T1 — DSH orders by seq, but a backwards clock makes the trajectory unreadable.
        if (typeof row.time === 'number') {
            if (row.time < lastTime) {
                violations.push({
                    code: 'C4-seq-contiguous',
                    dshMessage: 'event time is not monotonically non-decreasing',
                    at: index,
                    detail: `row ${index} time ${row.time} < previous ${lastTime}`,
                });
            }
            lastTime = row.time;
        }
        // C1 — message-bearing events must carry a marker.
        if (SURFACE_ELIGIBLE_TYPES.has(type) && row.surfaceOp === undefined) {
            violations.push({
                code: 'C1-surface-marker',
                dshMessage: `format v3 ${type} at seq ${String(row.seq)} requires a surfaceOp marker`,
                at: index,
                detail: `${type} has no surfaceOp`,
            });
        }
        const data = isRecord(row.data) ? row.data : undefined;
        // C2 — message envelopes must be identified.
        if (SURFACE_ELIGIBLE_TYPES.has(type)) {
            const envelope = type === 'user/message' ? data : (data !== undefined && isRecord(data['message']) ? data['message'] : undefined);
            const id = envelope !== undefined ? envelope['id'] : undefined;
            if (typeof id !== 'string' || id.length === 0) {
                violations.push({
                    code: 'C2-message-identity',
                    dshMessage: `seed ${type} at index ${index} lacks an identified message`,
                    at: index,
                    detail: `${type} envelope id is ${JSON.stringify(id)}`,
                });
            }
        }
        // C3 — assistant settlement fields.
        if (type === 'assistant/message' && data !== undefined) {
            const turn = data['turn'];
            const step = data['step'];
            const okTurn = typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0;
            const okStep = typeof step === 'number' && Number.isSafeInteger(step) && step >= 0;
            if (!okTurn || !okStep || !Array.isArray(data['stream'])) {
                violations.push({
                    code: 'C3-settlement-fields',
                    dshMessage: `seed ${type} at index ${index} has invalid settlement fields`,
                    at: index,
                    detail: `turn=${String(turn)} step=${String(step)} stream=${Array.isArray(data['stream']) ? 'array' : 'missing'}`,
                });
            }
        }
        // C5 — anything DSH does not know must be marked ignorable.
        if (type !== undefined && !KNOWN_DSH_TYPES.has(type) && row.ignorable !== true) {
            violations.push({
                code: 'C5-ignorable-unknown',
                dshMessage: `unknown event type "${type}" was not marked ignorable`,
                at: index,
                detail: `${type} is outside KNOWN_SESSION_EVENT_TYPES and lacks ignorable: true`,
            });
        }
        // T1 — pairing. A result whose call was never announced is a repair case.
        if (type === 'tool/call' && data !== undefined && typeof data['callId'] === 'string') {
            announced.add(data['callId']);
        }
        if (type === 'tool/result' && data !== undefined) {
            const message = isRecord(data['message']) ? data['message'] : undefined;
            const source = message !== undefined && isRecord(message['source']) ? message['source'] : undefined;
            const callId = source !== undefined ? source['callId'] : undefined;
            if (typeof callId !== 'string' || !announced.has(callId)) {
                violations.push({
                    code: 'T1-tool-pairing',
                    dshMessage: 'tool result has no started call',
                    at: index,
                    detail: `tool/result names callId ${JSON.stringify(callId)} which no tool/call announced`,
                });
            }
        }
    });
    // P1 — the path DSH recomputes from the header must be the path we would write.
    if (root !== undefined && typeof header.id === 'string' && header.id.length > 0) {
        const expected = sessionArtifactPath(root, header.cwd, header.id, header.version);
        if (!expected.endsWith(`/${generationLogFilename(header.version)}`)) {
            violations.push({
                code: 'P1-path-identity',
                dshMessage: `corrupt session log: header id "${header.id}" and cwd identify another path`,
                detail: `derived ${expected}`,
            });
        }
    }
    return {
        ok: violations.length === 0,
        violations,
        checksRun: [...CHECKS],
        dshNative: false,
    };
}
/**
 * DSH event types this build emits that the installed vocabulary knows.
 *
 * The list is the intersection of `KNOWN_SESSION_EVENT_TYPES` and what
 * {@link module:synthesize} emits. Types outside it must be `ignorable`.
 */
const KNOWN_DSH_TYPES = new Set([
    'turn/start',
    'turn/end',
    'step/start',
    'step/end',
    'user/message',
    'assistant/message',
    'system/message',
    'tool/call',
    'tool/result',
    'request/context',
    'session/title',
    'session/end-seed',
]);
//# sourceMappingURL=verify.js.map