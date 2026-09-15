/**
 * DSH session storage path derivation.
 *
 * DSH does not keep a central session index. It discovers sessions by scanning
 * `<root>/` for project directories and reading the generation-named artifact
 * inside each session directory. That makes the path a *correctness* concern
 * rather than a convention: on load, the persistence backend recomputes the
 * expected path from the artifact's own header and rejects the file when it
 * disagrees.
 *
 * ```text
 * corrupt session log "<path>": header id "<id>" and cwd identify "<expected>"
 * ```
 *
 * A second invariant compounds this: `findLog` searches every project
 * directory, and two sessions sharing an id in different projects is a hard
 * error. So project placement must be a pure function of the header, which is
 * what this module provides.
 *
 * The algorithms here are byte-for-byte reproductions of
 * `projectKey()` and `encodeSegment()` in `@deepseek-ai/dsh-session-persistence-jsonl`,
 * verified against three real project directories on disk.
 *
 * @module
 */
/** The Session format generation this build emits. */
export const SESSION_FORMAT_VERSION = 3;
/**
 * Encode one path segment with the shared `~XXXX` escape.
 *
 * `.` and `..` are escaped rather than admitted, so an encoded segment is
 * never a traversal.
 * @param raw - the segment to encode.
 * @returns a filesystem-safe segment.
 */
export function encodeSegment(raw) {
    if (raw.length === 0)
        throw new Error('cannot encode an empty path segment');
    if (raw === '.')
        return '~002E';
    if (raw === '..')
        return '~002E~002E';
    let out = '';
    for (let index = 0; index < raw.length; index += 1) {
        const code = raw.charCodeAt(index);
        const ch = String.fromCharCode(code);
        if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch))
            out += ch;
        else
            out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
    }
    return out;
}
/**
 * Build the human-navigable project directory name for a working directory.
 *
 * Separators collapse into a single `-`, everything outside `[A-Za-z0-9._-]`
 * becomes `~XXXX`, and the result is wrapped in `--` and truncated to 251
 * characters. The transformation is intentionally lossy: two long paths
 * sharing a 251-character prefix collide, and separators are not recoverable.
 *
 * That lossiness is why {@link sessionDir} must be the only way a caller
 * builds a path. Deriving it independently is how a reader ends up rejecting
 * its own files.
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
export function projectKey(cwd) {
    if (cwd.length === 0)
        throw new Error('cannot encode an empty project path');
    let readable = '';
    let separatorRun = false;
    for (let index = 0; index < cwd.length; index += 1) {
        const code = cwd.charCodeAt(index);
        const ch = String.fromCharCode(code);
        if (ch === '/' || ch === '\\' || ch === ':') {
            if (!separatorRun)
                readable += '-';
            separatorRun = true;
        }
        else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
            readable += ch;
            separatorRun = false;
        }
        else {
            readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
            separatorRun = false;
        }
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
/**
 * The generation-addressed artifact basename.
 *
 * Version 0 keeps the original `session.jsonl`; every later generation inserts
 * a lowercase numeric component. Compression is a separate suffix.
 * @param version - Session format generation.
 * @param compression - physical encoding.
 * @returns the artifact basename.
 */
export function generationLogFilename(version, compression = 'zstd') {
    if (!Number.isSafeInteger(version) || version < 0) {
        throw new Error(`session format version must be a non-negative safe integer, got ${version}`);
    }
    const base = version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`;
    return compression === 'zstd' ? `${base}.zstd` : base;
}
/**
 * Read the generation named by one artifact basename.
 * @param filename - one basename from a session directory.
 * @param compression - physical encoding to accept.
 * @returns the generation, or `undefined` when the name is not canonical.
 */
export function parseGenerationLogFilename(filename, compression = 'zstd') {
    const suffix = compression === 'zstd' ? '.jsonl.zstd' : '.jsonl';
    if (!filename.endsWith(suffix))
        return undefined;
    const stem = filename.slice(0, -suffix.length);
    if (stem === 'session')
        return 0;
    const match = /^session\.v([0-9]+)$/.exec(stem);
    if (match === null)
        return undefined;
    const digits = match[1];
    // Leading zeros are not canonical, so `session.v03.jsonl` is not generation 3.
    if (digits === undefined || digits.length > 1 && digits.startsWith('0'))
        return undefined;
    return Number(digits);
}
/** A project's directory below the storage root. */
export function projectDir(root, cwd) {
    return cwd === undefined ? joinPath(root, '_no-cwd') : joinPath(root, projectKey(cwd));
}
/** The directory owned by one session. */
export function sessionDir(root, cwd, id) {
    return joinPath(projectDir(root, cwd), encodeSegment(id));
}
/**
 * The exact path DSH will recompute from an artifact's own header.
 *
 * Writing anywhere else produces a file the persistence backend refuses to
 * load, so every write in this repository routes through this function.
 * @param root - the storage root, normally `$DSH_HOME/sessions`.
 * @param cwd - the header's `cwd`; `undefined` selects `_no-cwd`.
 * @param id - the header's `id`.
 * @param version - Session format generation.
 * @param compression - physical encoding.
 * @returns the absolute artifact path.
 */
export function sessionArtifactPath(root, cwd, id, version = SESSION_FORMAT_VERSION, compression = 'zstd') {
    return joinPath(sessionDir(root, cwd, id), generationLogFilename(version, compression));
}
/** Minimal POSIX path join, keeping this package free of `node:path`. */
function joinPath(...parts) {
    return parts
        .map((part, index) => (index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
        .filter((part, index) => part.length > 0 || index === 0)
        .join('/');
}
//# sourceMappingURL=paths.js.map