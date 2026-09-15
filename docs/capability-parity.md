# Capability coverage

The session manager in `cockpit-tools` presents a specific set of operations
for Codex sessions. This document maps each one to its counterpart here, states
whether it is implemented, and names the module that owns it.

The point of the matrix is honesty about gaps. A feature listed as *designed*
has types, an interface, and tests against fixtures but no command that runs it
against real data. A feature listed as *absent* is not in the repository.

**Correction (2026-09-15).** 31 rows here were labelled *Implemented* against
four modules that were never written: `dsh-session-store`, `codex-rollout`,
`apps/cli` and `dsh-plugin-codex-history`. By this document's own definition those
features are *absent*, and they have been relabelled. What remains *Implemented*
is owned by `dsh-session-artifact`, which exists and has a suite. The `Counterpart
here` column still names the planned API, because the plan is what these rows were
written from; the `Owner` column now reads `—` where nothing owns it.

**Licence note.** `cockpit-tools` declares `CC-BY-NC-SA-4.0` and has no LICENSE
file at its repository root. Nothing in this repository is derived from its
code. The feature list below was read from its user interface and from the
public method names in `src-tauri/src/modules/codex_session_manager.rs`; every
implementation here is written from scratch against DSH's own storage format.

## 1. Session list

| Capability | Counterpart here | Status | Owner |
|---|---|---|---|
| List sessions grouped by workspace | `SessionStore.workspaces()` | **Absent** | — |
| Relative timestamps per group and session | `ago()` in the CLI | **Absent** | — |
| Per-session size | `SessionRecord.bytes` | **Absent** | — |
| Filter by conversation type | Not applicable: DSH stores one session kind | Absent | — |
| Refresh | `SessionStore.refresh()` | **Absent** | — |
| Cached listing without rescanning | Index keyed by `(path, size, mtimeMs)` | **Absent** | — |

Two differences are structural rather than missing work.

**Grouping key.** Cockpit groups by Codex's recorded `cwd`. DSH groups by
`projectKey(cwd)` — the same working directory, but folded into one filesystem
component with the lossy escaping DSH uses. The CLI prints the original path
alongside the label, so the group is unambiguous even when two long paths
collide after truncation.

**Generation drift.** DSH session directories can hold artifacts at more than
one format generation. Measured on the author's machine: four sessions at
generation 0 and thirty-nine at generation 3. Discovery selects the highest
generation per session and reports the distribution, which is a concern Codex
does not have.

## 2. Selection and bulk operations

| Capability | Counterpart here | Status | Owner |
|---|---|---|---|
| Multi-select | Command arguments: `codex-to-dsh trash <id> <id> …` | **Absent** | — |
| Select all | Omitting arguments selects every session | **Absent** | — |
| Copy to instance | `exportBundle` + `importBundle` into another harness home | **Absent** | — |
| Move to trash | `SessionStore.trash(ids)` | **Absent** | — |
| Restore from trash | `SessionStore.restore(ids)` | **Absent** | — |
| Empty trash | `SessionStore.emptyTrash()`, gated behind `--yes` | **Absent** | — |
| Trash listing | `SessionStore.listTrash()` | **Absent** | — |

**Trash design differs on purpose.** Cockpit uses the operating system trash.
This project moves the session directory into `<home>/session-trash/` alongside
a `manifest.json`. The whole directory moves, so every generation travels
together and a restore is exact rather than best-effort. It also means the
operation behaves the same on every platform, and that a restore does not
depend on a platform API being available.

## 3. Search

| Capability | Counterpart here | Status | Owner |
|---|---|---|---|
| Search by title | `SessionStore.search({ text })` | **Absent** | — |
| Search Codex history by prompt | `buildRolloutIndex` + `searchIndex` | **Absent** | — |
| Search by workspace | `search({ cwd })` and substring matching on the path | **Absent** | — |
| Search by session id | Substring matching on the id | **Absent** | — |
| Time-range filter | `search({ since, until })` | **Absent** | — |
| Full-text search over message bodies | Not implemented — see below | Absent | — |

**Titles need a real source.** DSH stores a session title as a `session/title`
event, which requires reading the artifact. The index carries the field and
`setTitle` populates it; the CLI currently populates it for Codex history
(where the title is the opening prompt) and leaves DSH titles unset until a
reader extracts them. Searching DSH sessions by workspace and id works today.

**Message bodies are not indexed.** A body index over this machine's 38 GB of
Codex rollouts would be a different project with a different cost profile, and
the prompt plus workspace is what makes history findable in practice. The
bounded head read that makes indexing 5,536 rollouts take 20.8 seconds exists
precisely because it does not read bodies.

## 4. Import and export

| Capability | Counterpart here | Status | Owner |
|---|---|---|---|
| Preview an export | `exportBundle` writes a manifest; the CLI prints each entry and digest | **Absent** | — |
| Export sessions | `exportBundle(store, ids, outDir)` | **Absent** | — |
| Preview an import | `importBundle(..., { apply: false })` | **Absent** | — |
| Import sessions | `importBundle(..., { apply: true })` | **Absent** | — |
| Integrity verification | SHA-256 per artifact, enforced before an apply | **Absent** | — |
| Verify a bundle without importing | `codex-to-dsh bundle <dir>` | **Absent** | — |
| Cross-machine path correction | Import re-derives the destination path from each artifact's header | **Absent** | — |

**Bundle format.** A directory holding `manifest.json` and
`files/<NNNN>-<sessionId>/<artifact>`. Artifacts are copied byte-for-byte, never
re-encoded, so a bundle round trip cannot lose anything the format does not
model. This differs from cockpit's bundle, which is Codex-specific; the manifest
format identifier is `codex-to-dsh/session-bundle`.

**Path correction is the interesting part.** A bundle built on one machine
records paths that may not exist on another. Import ignores the recorded
project directory and re-derives it from each artifact's own header, which is
the same rule DSH itself applies on load. Import is additive: a session already
present is skipped, never overwritten.

## 5. Repair and diagnostics

| Capability | Counterpart here | Status | Owner |
|---|---|---|---|
| Repair visibility | `SessionStore.diagnose()` reports drift; `refresh()` reconciles it | **Absent** | — |
| Report missing and extra entries | `{ missingArtifact, staleIndex }` | **Absent** | — |
| Report generation drift | `codex-to-dsh doctor` | **Absent** | — |
| Report unreadable artifacts | `refresh()` returns `unreadable[]` | **Absent** | — |

**The problem is smaller here, and that is worth stating.** Cockpit's "repair
visibility" exists because Codex keeps three sources of truth that drift apart:
the date-partitioned `sessions/` tree, `session_index.jsonl`, and a
`threads.rollout_path` column in `state_5.sqlite`. DSH keeps one — the
directory tree — and derives everything else. Its projection cache is
regenerable.

So this project has no equivalent of "rewrite the SQLite row". What it has
instead is detection: a session in the index with no file, a file with no index
entry, and an artifact the reader could not parse. The last of those is not
theoretical: it is how the compression-versus-generation bug was found, where
four generation-0 sessions were being dropped silently.

## 6. Codex-side capabilities

These belong to L2 and are the ones the current phase deliberately does not
run.

| Capability | Counterpart here | Status | Owner |
|---|---|---|---|
| Read a Codex rollout | `parseRolloutText` | Implemented (library) | `dsh-session-artifact` |
| Convert to a DSH artifact | `synthesizeSession` | Implemented (library) | `dsh-session-artifact` |
| Validate a converted artifact | `verifyArtifact`, 9 checks | Implemented | `dsh-session-artifact` |
| Preview a conversion | `codex-to-dsh convert <rollout>` | **Absent** | — |
| Batch conversion into a real home | — | **Absent by design** | — |
| Rewrite a recorded working directory | `cwdRewrite` option | Implemented (library) | `dsh-session-artifact` |
| Cross-instance copy | Replaced by bundles between harness homes | **Absent** | — |

The batch path is the gate described in `docs/design.md` §3. The library and its
tests exist, so opening the gate later is a small change rather than a new project.
There is no preview command; the three rows above that name one are absent.

## 7. What this project adds that cockpit does not have

Not a parity claim — a list of problems that only appear once the target is DSH.

- **Structural validation against the harness's own validators.** Five
  invariants that no type expresses, each documented with the real rejection
  message. See `docs/mapping.md` §3.
- **Storage-identity derivation.** `projectKey` reproduced from the harness's
  own implementation and verified against every real session directory on the
  author's machine.
- **Generation-aware paths.** Discovering that compression and generation are
  independent axes, and that a version-blind path helper drops real sessions.
- **Ordering repair.** Synthesizing a `tool/call` for an orphan result and
  opening a turn that only ever closes, so the artifact contains no repair
  cases for the harness to find later.
- **Injected-context filtering.** Codex writes environment and plugin context
  as `role: "user"` messages ahead of the real prompt; taking the first user
  message verbatim produces titles like `<recommended_plugins> Here is a list…`.
