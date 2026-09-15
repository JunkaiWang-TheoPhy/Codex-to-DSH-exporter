# 1:1 replication: what it means and how to build it

Goal: reproduce a Codex working environment and its session history inside DSH,
with nothing dropped that can be dropped.

This document separates what 1:1 can mean per surface, because one answer for
all of them would be a false promise. It then gives the architecture and the
exact target for each surface.

## 1. The fidelity contract, surface by surface

| Surface | What 1:1 means | Achievable |
|---|---|---|
| `hooks.json` | Codex runs these hooks on its interception seams | **Already done.** DSH ships `@deepseek-ai/dsh-hooks-codex`, which runs a Codex `hooks.json` on the harness's own seams. Zero work. |
| `skills/` | Every skill directory present at a path DSH discovers | **Yes.** Verbatim directory copy. |
| `agents/*.toml` | Each agent becomes a preset whose instructions are byte-identical | **Yes.** `developer_instructions` → the persona config `text`, verbatim. |
| `prompts/*.md` | Each prompt reachable | **Yes**, once a destination is chosen (see §4). |
| `[mcp_servers.*]` | Each server configured and connectable | **Yes.** Mechanical: `command`/`args` → stdio, `url` → streamable-http. |
| `AGENTS.md` | Content preserved and in force | **Yes, but the target is occupied.** Needs a merge policy (§4). |
| `rules/default.rules` | Command allow-list preserved | **Partial.** DSH's permission model is presets, not prefix rules. Needs a translation decision. |
| `config.toml` model providers | Same models reachable | **Partial.** DSH routes by provider profile; Codex routes by `model_provider`. |
| `sessions/` | Every record Codex wrote is present and recoverable | **Information-preserving yes; renderable no** (§2). |

Two claims in that table are the whole reason this is worth doing carefully.

## 2. Why sessions cannot be 1:1 in the literal sense

Three facts, each measured or read from source.

**Some Codex data has no reader anywhere.** `response_item/reasoning` carries
`encrypted_content`, which is **84.1%** of a reasoning record's bytes on this
machine. It is opaque outside OpenAI's own systems. Carrying it is possible;
using it is not. Excluding it loses nothing that anyone can read.

**DSH assigns its own sequence numbers.** `seq` must be contiguous from 0, and
the writer owns the counter. Codex's line order is preserved, but its numbering
is not. This is re-indexing, not loss.

**DSH has no vocabulary for several Codex record types.** Measured shares of a
uniform random sample of 200 rollouts: `event_msg/item_completed` 11.9% of
bytes, `event_msg/token_count` 2.8%, `compacted` replacement text 13.2%.

The first two are droppable. The third is content.

### The mechanism that makes preservation possible

DSH documents its own answer, in the generated vocabulary file of
`@deepseek-ai/dsh-session`:

> Downstream (out-of-repo) plugin events are outside this list by construction.
> **The persisted `SessionEvent.ignorable` marker is the compatibility
> mechanism**; event-name registration was rejected because it does not classify
> omission safety and would make reads composition-dependent. The rationale is
> in `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`.

The read path accepts an unknown type when the envelope carries
`ignorable: true`; the validator returns early for it; the migration chain's
`default:` branch returns the event unchanged; and the session model records
that "unknown ignorable records retain opaque metadata and never change the
surface".

So the contract for sessions is: **every record Codex wrote is present in the
DSH log, either translated into DSH vocabulary or carried verbatim as an
`ignorable` event.** DSH renders what it understands and retains the rest
without interpreting it. That is the strongest fidelity the destination admits,
and it is stronger than what any existing importer achieves — `dsh-chat-import`
drops Codex reasoning and the whole `event_msg` channel.

### The consequence: the importer must hand-encode

`ignorable` is unreachable from the public write path. `Session.append` threads
only `sourceEventSeqs` and `surfaceOp`. An importer that writes through the host
API — the convenient route — therefore **cannot** preserve unknown records, and
it also cannot set the marker on its own custom events. That is why
`dsh-omni-router` ships sessions the current build refuses to load, and why
`dsh-chat-import`'s dropped records are a constraint of its architecture rather
than a choice.

Hand-encoding costs one thing: the storage path must be reproduced rather than
derived by the host. That is `projectKey` and `encodeSegment`, which this
repository already reproduces byte-for-byte and verifies against every real
session directory on the machine.

**Hand-encoding is the load-bearing decision of this design.**

## 3. Architecture

```
~/.codex ──[ exporter, read-only ]──> archive/ ──[ importer ]──> ~/.dsh
```

Two programs, one archive format, no shared process. The split is not ceremony:

- The exporter runs where the data is, before DSH is installed, and holds the
  read-only guarantee that makes it safe to run on an account you are worried
  about.
- The archive is the checkpoint. Inspect it, verify it, move it on a disk, keep
  it for a year. The destination format is a release candidate; the archive is
  not.
- The importer is the only half that has to track DSH, and it can be rewritten
  when DSH's format moves without re-reading the Codex home.

## 4. Exact targets

### Skills → `~/.agents/skills/`

DSH discovers project `.dsh/skills`, project `.agents/skills`, `~/.dsh/skills`,
and `~/.agents/skills`. The last is shared with other agents and is where the
machine already keeps 46 skills. Codex has 91, of which 6 collide by name.

**Decision needed:** collide-skip, collide-overwrite, or namespace Codex skills
under a prefix. Skipping is the safe default; overwriting `~/.agents/skills`
silently is not.

### Agents → a preset per agent

Codex `agents/<name>.toml`:

```toml
name = "planner"
description = "Task sequencing, execution plans, risk flags"
model = "gpt-5.4"
model_reasoning_effort = "medium"
developer_instructions = """
<identity>…</identity>
"""
```

DSH preset, two files under `~/.dsh/profiles/<profile>/`:

```yaml
# preset.yml
name: planner
description: Task sequencing, execution plans, risk flags
order: 10
```

```yaml
# agent.cordis.yml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      <identity>…</identity>
    complete: true
```

`developer_instructions` goes in verbatim. `model` and
`model_reasoning_effort` have no preset-level equivalent and are recorded in the
manifest as unmapped rather than silently dropped.

### MCP servers → the MCP client config

Codex is implicit about transport; DSH is explicit. The mapping is mechanical:

| Codex | DSH |
|---|---|
| `command` + `args` | `{ transport: 'stdio', command, args }` |
| `url` | `{ transport: 'streamable-http', url, headers }` |
| `startup_timeout_sec` | mapped if the DSH config admits it, else recorded unmapped |
| `enabled = false` | imported disabled, not skipped |
| `oauth_resource` | no DSH equivalent — recorded unmapped |

**Risk to handle explicitly:** a Codex `config.toml` can carry credentials in
`http_headers` or environment blocks. The exporter must scan and report every
credential-shaped value it finds and refuse to write them into the archive by
default. The existing `config.toml` on this machine has 25 servers; the scan is
not hypothetical.

### Prompts → a decision, not a mapping

Codex `prompts/*.md` (20 files here) are user-invoked prompt templates. DSH has
no direct equivalent: the nearest destinations are a skill, a slash command
registered by a plugin, or a preset. None is 1:1.

**Decision needed.** The honest default is to carry them in the archive and
install nothing, rather than to guess a destination that changes their
behaviour.

### `AGENTS.md` → a merge, not a copy

Codex's global instructions file is 49 KB here. `~/.dsh/AGENTS.md` exists and is
30 KB, and DSH treats it as the machine-level behavioural contract.

Overwriting it would destroy the user's DSH configuration. Appending would
produce a file that contradicts itself. The only defensible 1:1 is: **write the
Codex content to a distinct file, and emit a patch that the user reviews and
applies.** A tool that silently rewrites a file the user maintains is worse than
no tool.

## 5. Verification

Each surface gets a check that would fail if the replication silently degraded:

- **Skills**: every archived skill directory exists at the target with matching
  digests; collision decisions match the manifest.
- **Agents**: each `developer_instructions` string appears verbatim in the
  resulting preset.
- **MCP**: each imported server is present in the composed config, and the
  `dsh --dump-config` output contains the expected rows.
- **Sessions**: for every imported session, re-read the artifact and assert that
  (a) it passes `restoreReleasedV3Artifact`, (b) the derived path equals the
  written path, (c) the count of `ignorable` events equals the count the importer
  recorded, and (d) every source `call_id` with an output still pairs.
- **Read-only**: the Codex home is byte-identical before and after an export.

The third session check is the one that catches a silent fidelity regression: an
importer that quietly stops emitting `ignorable` events would otherwise look
successful.

## 6. Milestones

| # | Deliverable | Gate |
|---|---|---|
| M0 | `docs/replication.md` frozen: the table in §1 and every unmapped field named | A reviewer can point at any Codex field and find its disposition |
| M1 | Exporter: environment half. Read-only, manifest, digests, credential scan | Export a real `~/.codex`, verify, and confirm the source tree is unchanged |
| M2 | Importer: environment half. Skills, agents, MCP, patch for `AGENTS.md` | A fresh DSH profile sees the imported skills and MCP servers |
| M3 | Exporter: sessions. Streaming, resumable, ledger | 5,536 rollouts exported; ledger re-run reads 0 |
| M4 | Importer: sessions, hand-encoded, `ignorable` preserved | Re-read every artifact; all four checks pass on 100 real sessions |
| M5 | Full run on the real corpus | — |

M4 is the gate that matters. M1–M3 are mechanical; M4 is where the format work
either holds or does not.

## 7. What this design does not promise

- **Rendered fidelity.** DSH will not display imported reasoning, telemetry, or
  compaction records. They will be in the log and recoverable, not on screen.
- **Resumability.** Whether DSH can continue a conversation from a synthesized
  artifact is untested. `inheritedEventCount` and the seed semantics differ
  between the two programs. This is the highest-risk unknown and it is not
  claimed.
- **Model equivalence.** A Codex session recorded against `gpt-5.4` will run
  under whatever model the DSH profile selects.
- **Durability of the destination format.** DSH's session format is a release
  candidate. The archive is the stable artifact; the imported sessions are not.
