# Design

## 1. The problem

A working environment accumulates in one program's container. Not just
configuration — the instructions, the skills, the hooks, the command
allow-list, and years of session history. When access to that program becomes
uncertain, the configuration is a day's work to rebuild and the history is
gone.

On the machine this was designed against, the Codex container holds:

| Surface | Size |
|---|---|
| `sessions/` (5,138 rollouts) | 38 GB |
| `archived_sessions/` (395 rollouts) | 394 MB |
| `skills/` (91 skills) | 30 MB |
| `config.toml` (25 MCP servers, hundreds of project trust entries) | 129 KB |
| `AGENTS.md` | 49 KB |
| `prompts/`, `agents/`, `hooks.json`, `rules/` | small but load-bearing |

The DeepSeek Harness stores the same kinds of things in an open format, in a
directory the user owns. This project moves the environment and makes the
history reachable.

## 2. The insight

Two properties of the harness make this tractable, and one makes it harder than
it first appears.

**The format is documented by its own code and publicly exported.** DSH's
session packages are MIT-licensed and publish the encoder, the header
validator, and the whole-artifact validator. A third party can produce a
loadable artifact without forking anything.

**Storage identity is a pure function of the header.** A session lives at
`<root>/<projectKey(cwd)>/<encodeSegment(id)>/session.v3.jsonl.zstd`, and the
harness recomputes that path from the artifact's own header on load. There is
no registry to update and no index to invalidate. Drop a correctly-formed file
in the right place and the session appears.

**The harder part: the format's migration chain cannot be extended.** DSH ships
`v0→v1→v2→v3` and generates its catalog statically. `defineSessionFormatMigration`
rejects any non-adjacent edge. A foreign format has no integer predecessor in
that lineage, so a Codex rollout cannot be registered as a generation. The only
route is to synthesize a current-generation artifact directly.

That reframing is the whole design. Import is not a migration; it is
construction, followed by validation against the harness's own validators.

## 3. Scope

Four layers, three implemented.

| Layer | What it is | Status |
|---|---|---|
| **L1 environment** | Inventory and map `AGENTS.md`, `config.toml`, skills, prompts, agents, hooks, rules | Implemented as inventory |
| **L3 history index** | A searchable index over Codex rollouts, plus a DSH plugin exposing it | Implemented |
| **L4 session management** | List, search, trash, restore, export, import, diagnose over DSH sessions | Implemented |
| **L2 session conversion** | Codex rollout → DSH v3 artifact | Implemented as a library, covered by tests, **not exposed for writing to a real home** |

### Why L2 does not write

The conversion works. The `convert` subcommand runs it against the synthetic
fixture and reports all nine structural checks passing. What is absent is a
command that walks a real `~/.codex` and writes into a real `~/.dsh`, and that
absence is deliberate for this phase.

The reason is not technical difficulty. It is that a 38 GB import into a
harness home is a one-way operation whose failure modes are quiet: a session
that loads but renders wrong, a working directory rewritten into a group that
never existed, a store that grows past what the sidebar can present. Those are
worth measuring on a hundred sessions before committing to five thousand. The
library and its tests exist so that gate is cheap to open later.

### Why L1 stops at inventory

Several Codex surfaces have direct harness equivalents, and one is already
bridged by the harness itself:

- `hooks.json` → `@deepseek-ai/dsh-hooks-codex` already runs a Codex hook
  configuration on the harness's interception seams. There is nothing to write.
- `skills/` → the harness discovers `~/.agents/skills` and `~/.dsh/skills`.
  Measured overlap between the Codex skill set (91) and `~/.agents/skills` (46)
  is 6 names, so most of the Codex set would need copying or symlinking.
- `config.toml` → the harness uses `~/.dsh/settings.yaml` and per-profile
  directories. The MCP server block and the project trust list have no direct
  analogue and need a mapping decision per key.

Each of those is a merge into a file the user already maintains, not a file
write. A tool that overwrites `~/.dsh/AGENTS.md` would be worse than no tool.
The inventory reports what exists and what it maps to; the merge is left
explicit.

## 4. Architecture

```
packages/
  codex-rollout/          Codex rollout JSONL -> one normalized entry union.
                          Also builds the searchable history index.
  dsh-session-artifact/   Storage-path derivation, artifact construction,
                          structural validation. Holds the invariants.
  dsh-session-store/      Discovery, listing, search, trash, bundles, diagnose.
                          Reads a harness home without booting the harness.
apps/
  cli/                    codex-to-dsh <env|mapping|list|search|index|export|
                            bundle|trash|convert|doctor>
plugins/
  dsh-plugin-codex-history/   Three read-only agent tools.
```

### The dependency direction is deliberate

`codex-rollout` knows nothing about the harness. It is the read side, and the
same intermediate representation feeds both the history index and the
converter. This is what makes the index cheap to build and the converter
testable in isolation.

`dsh-session-artifact` owns every fact about the harness's storage format. No
other package computes a session path.

`dsh-session-store` reads a harness home using only `node:fs` and `node:zlib`.
It does not load the harness, which is what lets it run as a CLI against a home
that is not currently booted, and as a plugin inside one that is.

## 5. Engineering contracts

### 5.1 The builder owns the sequence

`SessionBuilder` owns `seq` and the message constructors always emit a surface
marker and a message id. Three of the five structural invariants therefore
cannot be violated by a caller. The remaining two — the assistant settlement
shape and the `ignorable` flag — are enforced where they are emitted.

This is the difference between a mapping document and a mapping that holds.

### 5.2 Round-trip validation before persistence

`verifyArtifact` re-parses what was written and checks all nine invariants,
including that the derived storage path matches. `convert` refuses to report
success without it. The reason is that the harness's rejection happens on load,
which may be hours later and in a different process; failing at write time is
strictly better.

### 5.3 Bounded reads

An index needs the header and the opening user message. Both sit in the first
few kilobytes. `parseRolloutHead` stops at a byte or line ceiling, so the cost
per rollout is independent of its size.

This was not a premature optimization. A full parse of the machine's 38 GB home
did not complete within 60 seconds. The bounded read indexes 5,536 rollouts
covering 37.97 GB in **20.8 seconds**, and a rescan of an unchanged home takes
**0.1 seconds** because entries are cached against `(path, size, mtimeMs)`.

### 5.4 Writing is off by default

Every command that could touch data has a dry-run path, and `trash empty` — the
only destructive operation — requires `--yes` and prints what it is about to
delete. Trash is a move into a sibling directory with a manifest, not a
deletion, and not the operating system trash, so restore is exact and does not
depend on platform behaviour.

Bundles carry a SHA-256 per artifact and refuse to import when one fails. A
bundle exists to move history between machines, and a silently truncated
artifact surfaces much later as an unreadable session.

### 5.5 Engineered against real data, not against fixtures

The test suite reads the real harness home when one exists. Those tests are
read-only and skip cleanly otherwise, and they have already paid for
themselves:

- Every real session on the machine verified against a path re-derived from
  its own header.
- The generation distribution `v0:4 v3:39` discovered, along with the fact that
  generation 0 headers carry no `isSeeded`.
- The compression-versus-generation conflation found: four sessions were being
  silently dropped because the reader inferred "plaintext" from `version === 0`.
- Assistant titles found to be Codex-injected context rather than prompts,
  which made the first version of the search index useless.

None of the four were visible from the fixtures.

## 6. Prior art and reuse

Two open-source applications manage Codex environments and history. Both were
assessed; neither is a code source for this project.

**`jlcodes99/cockpit-tools`** declares `CC-BY-NC-SA-4.0` in `Cargo.toml` and
its README, and **has no LICENSE file at the repository root** — GitHub reports
no licence at all. Non-commercial plus ShareAlike is incompatible with
MIT in both directions: the non-commercial term would make the combined
work non-free, and ShareAlike would demand relicensing. It also does not
contain what this project needs: its `export_sessions` produces a Codex-to-Codex
zip bundle, and it has no zstd session support. Used here as a design reference
only — its `codex_config_format.rs` is the best available description of how to
edit `config.toml` without destroying unknown keys, and its
`codex_session_manager.rs` documents the two rollout layouts and the
`session_index.jsonl` and SQLite reconciliation problem.

**`farion1231/cc-switch`** is MIT, so reuse would be lawful. Its Rust modules
are coupled to its own Tauri application state and to an eighteen-step SQLite
schema ladder, which makes porting more expensive than reimplementing. Used as
a specification source: its `session_manager/providers/codex.rs` documents the
rollout filename grammar and the subagent filtering rule, and
`codex_history_migration.rs` is the template for the idempotent migration
ledger discipline — a completion marker written only on success, and a
per-migration backup directory.

**The harness itself** is the largest source, and the only one whose code is
used. The encoder and both validators are imported directly. The path helpers
reproduce `projectKey` and `encodeSegment` from
`@deepseek-ai/dsh-session-persistence-jsonl`, and the reproduction is verified
against real directories rather than trusted.

## 7. The plugin

The plugin registers three read-only tools at the host plane:
`codex_history_search`, `codex_history_locate`, and `dsh_session_list`. It
never writes to either home.

It declares the harness API surface it uses locally, in
`src/dsh-types.ts`, rather than depending on the harness packages. The harness
packages are not resolvable from the public registry — a peer dependency on
them fails the install with a 404 on an internal transitive package — and a
local declaration keeps the repository buildable without a harness checkout.
Every shape in that file was read from a shipping installed harness, and each
carries a comment saying where.

Two facts about the plugin API are worth recording because they contradict the
obvious guess:

- The tool parameter schema is the harness's own JSON-value DSL, **not**
  schemastery. Requiredness is a per-property `required: true`. Schemastery is
  used only for the plugin's own `Config`.
- `output: { schema, render }` is mandatory. Registration throws without it,
  and `execute` returns the canonical value rather than content blocks.

## 8. Limits

- **Read-only index.** The index stores identity, workspace, timestamps, a
  title, and counts. It does not index message bodies. A body index over 38 GB
  is a different project, and the title plus workspace is what makes history
  findable.
- **No resumability claim.** An imported session is intended to be readable
  history. Whether the harness can continue a conversation from a synthesized
  artifact has not been tested and is not promised. `inheritedEventCount` and
  the seed semantics differ between the two programs, and that is the highest-
  risk unknown in L2.
- **One machine's numbers.** Every measurement above was taken on a single
  macOS machine. They are evidence about this problem, not benchmarks.
- **Version coupling.** Two harness installations were present during
  development (`0.1.0-rc.7` and `0.1.5-rc.1`) and their validators differ in
  strictness. The repository does not pin a harness version, and the format is
  a release candidate. Re-run `convert` against the fixture after upgrading.

## 9. Positioning: withdrawn

**The exporter positioning stated here on 2026-09-15 was withdrawn the same day.**

It rested on a real measurement — of the 3,632 entries in the curated DSH plugin
catalogue, exactly one describes itself as reading `~/.codex`. That measurement
answers *"how many DSH plugins read a Codex home"*. The positioning needed the
answer to *"is Codex session export occupied"*, and that answer is no:

| Stars | Project | What it does |
|---|---|---|
| 201 | `Red-noblue/Codex_Relay` | Cross-device export/import plus a local session vault, zipped, for `codex resume` continuity |
| 104 | `Aiyawoc/CodexSessionManager` | Auditing, backing up, importing, and cleaning Codex sessions, GUI and CLI |
| 103 | `WangPeterXF/session-harbor` | A verified filesystem vault for Codex rollouts; zero-dependency Node CLI, external drive or NAS |
| 98 | `xhluca/session-migrate` | Migrate sessions among 18 harnesses; MIT, PyPI, active |
| 97 | `heyroute-ai/codex-threadkeeper` | Sync session metadata and SQLite state |
| 58 | `pangkk18/codex-history-sync` | Dependency-free Python CLI |

Every element the positioning claimed — portable archive, verification, audit,
cross-harness migration, boot-free CLI — has a mature implementation with three
figures of stars. `session-harbor` is the closest: local-first, verified, vault
on removable media, Node CLI. Two of these carry restrictive or absent licences
(`session-harbor` is PolyForm Noncommercial, `Codex_Relay` has no licence at
all), and `session-migrate` is MIT, published, and was updated four days before
this note.

`session-migrate` does not support DSH among its 18 harnesses. That is a pull
request, not a product.

### What survives

The repository's format work is not invalidated; its product framing is. Three
findings here are not in any of the projects above:

1. **DSH's structural invariants, written as a specification.** `docs/mapping.md`
   C1–C5. At least three independent authors rediscovered parts of this by
   hitting the validator — `session-rdb` ships a repair pass that backfills
   `stream: []` and adds missing `surfaceOp` markers, which are C3 and C1 here.
   Nobody has written them down.
2. **`ignorable` is unreachable from the public write path but reachable when
   hand-encoding.** Two plugin authors met this wall from opposite sides. It
   determines whether a plugin that emits custom events produces loadable
   sessions.
3. **`session.vN.jsonl.zstd` generation handling.** `dsh-chat-import` matches
   only `session.jsonl(.zstd)` and so cannot read current-generation logs.

The honest form of these is contributions — to `session-migrate`'s format
documentation, and to `dsh-chat-import` as a bug report — not a competing
product.

### The user-facing consequence

For the original goal, installing `dsh-chat-import` solves it today. It has 163
stars, 18,714 monthly downloads, covers 21 agents including Codex, writes real
DSH v3 sessions through the host API, and ships 73 test files. Building a
competitor would be the wrong use of the format work.
