/**
 * DSH session artifact construction and validation.
 *
 * The package answers two questions the rest of the project depends on:
 *
 * 1. **Where does a session file go?** {@link sessionArtifactPath} reproduces
 *    DSH's own derivation. Writing anywhere else yields a file the persistence
 *    backend refuses to load, because it recomputes the expected path from the
 *    artifact's header and compares.
 * 2. **Is this artifact loadable?** {@link verifyArtifact} checks the
 *    invariants that `.d.ts` types do not express and that only surface when
 *    DSH actually reads the file.
 *
 * The invariants were established by running DSH's real validators rather than
 * by reading types. See `docs/mapping.md`.
 *
 * @module
 */
export { SURFACE_ELIGIBLE_TYPES, SessionBuilder, } from "./events.js";
export { SESSION_FORMAT_VERSION, encodeSegment, generationLogFilename, parseGenerationLogFilename, projectDir, projectKey, sessionArtifactPath, sessionDir, } from "./paths.js";
export { DEFAULT_MAPPING, synthesizeSession, } from "./synthesize.js";
export { parseArtifact, verifyArtifact, } from "./verify.js";
//# sourceMappingURL=index.js.map