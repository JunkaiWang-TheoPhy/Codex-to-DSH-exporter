/**
 * DSH session artifact construction and validation.
 *
 * The package answers four questions the rest of the project depends on:
 *
 * 1. **How is a Codex rollout read?** {@link parseRolloutText} normalizes the
 *    rollout's two interleaved channels into one entry union, dropping the
 *    duplicated messages and keeping unmodelled records visible.
 * 2. **How does a rollout become a session?** {@link synthesizeSession} maps
 *    that union onto a DSH artifact of the current generation.
 * 3. **Where does a session file go?** {@link sessionArtifactPath} reproduces
 *    DSH's own derivation. Writing anywhere else yields a file the persistence
 *    backend refuses to load, because it recomputes the expected path from the
 *    artifact's header and compares.
 * 4. **Is this artifact loadable?** {@link verifyArtifact} checks the
 *    invariants that `.d.ts` types do not express and that only surface when
 *    DSH actually reads the file.
 *
 * The invariants were established by running DSH's real validators rather than
 * by reading types. See `docs/mapping.md`.
 *
 * @module
 */

export {
  codexCustomToolArguments,
  jsObjectLiteralToJson,
  type CodexToolArguments,
} from './arguments.ts';

export {
  classifyRecord,
  dedupeEventChannel,
  parseRolloutText,
  summarize,
  textFromContent,
  type BoundaryEntry,
  type CodexContentBlock,
  type CodexRole,
  type CodexSessionMeta,
  type CodexTurnContext,
  type CompactionEntry,
  type EntryOrigin,
  type MessageEntry,
  type NormalizeOptions,
  type ReasoningEntry,
  type RolloutEntry,
  type RolloutSummary,
  type SessionMetaEntry,
  type TelemetryEntry,
  type ToolCallEntry,
  type ToolCallFlavor,
  type ToolOutputEntry,
  type TurnContextEntry,
  type UnknownEntry,
} from './rollout.ts';

export {
  synthesizeSession,
  type SynthesizeOptions,
  type SynthesizeResult,
} from './synthesize.ts';

export {
  SURFACE_ELIGIBLE_TYPES,
  SessionBuilder,
  type ContentBlock,
  type MessageSource,
  type SessionBuilderOptions,
  type SessionHeader,
  type SessionRow,
  type Settlement,
} from './events.ts';

export {
  SESSION_FORMAT_VERSION,
  encodeSegment,
  generationLogFilename,
  parseGenerationLogFilename,
  projectDir,
  projectKey,
  sessionArtifactPath,
  sessionDir,
  type Compression,
} from './paths.ts';

export {
  parseArtifact,
  verifyArtifact,
  type VerificationReport,
  type Violation,
} from './verify.ts';
