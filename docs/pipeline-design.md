# Pipeline design

The program is three stages. This document is M0: it fixes the contract each
stage honours, the disposition of every source field, and the two constraints
that were verified against the harness rather than assumed.

## 1. The contract

| Stage | Rule |
|---|---|
| **export** | Take everything, verbatim. No filtering, no judgement, no rewriting. |
| **classify** | Propose what is portable. Produce reasons. Write nothing. |
| **load** | Apply only what classify approved. Record every exclusion. |

The asymmetry is deliberate. Judgement is concentrated in one stage, and that
stage is the only one whose output a person has to read.

One exception to "everything" in export: **credentials are never written**. A
Codex home can carry tokens in `config.toml`'s `http_headers`, in environment
blocks, and in `auth.json`. The exporter scans for credential-shaped values,
refuses to write them, and records what it refused in the manifest. This is the
only place export makes a decision, and it makes it in one direction.

## 2. Disposition vocabulary

Every source field ends in exactly one of four states, recorded in the manifest.
The vocabulary is the contract; it is not per-field policy.

| Disposition | Meaning |
|---|---|
| `translated` | Carried into a destination concept, possibly renamed |
| `preserved` | Carried verbatim in an `ignorable` event; the destination does not interpret it |
| `unmapped` | No destination exists. The value is recorded with a reason and not written. |
| `dropped` | Deliberately excluded, with a reason. |

`unmapped` and `dropped` differ in intent: `unmapped` means the destination has
nowhere to put it, `dropped` means it was decided not to carry it. Both are
recorded; neither is silent.

## 3. Stage 1 — export

Read-only on the Codex home, byte-identical guarantee, asserted by the suite.

Produces the archive specified in `docs/archive-format.md`. Nothing in this
stage needs a decision except credential refusal.

| Surface | Handling |
|---|---|
| `sessions/**/rollout-*.jsonl`, `archived_sessions/*.jsonl` | byte-exact copy, zstd, per-file digest of the original bytes |
| `AGENTS.md`, `config.toml`, `hooks.json`, `rules/` | byte-exact copy |
| `skills/`, `prompts/`, `agents/` | byte-exact directory copies |
| `auth.json`, `*.sqlite`, `logs/` | **not copied**; recorded in `notCaptured` with a reason |

## 4. Stage 2 — classify

The only stage that makes semantic judgements, and the only one that uses a
model.

### Why a model rather than rules

Rule matching finds a Codex reference; it cannot tell whether the reference
matters. A skill that mentions `~/.codex` in a troubleshooting paragraph is
portable. One that shells out to `codex exec` is not. Measured on the author's
home: a keyword rule sorts 33 of 85 skills as Codex-bound, and the boundary is
not that clean in either direction.

### What it emits

A proposal, never a change:

```json
{
  "surface": "skill",
  "id": "deep-interview",
  "portable": false,
  "confidence": "high",
  "evidence": "SKILL.md step 3 invokes `codex exec --sandbox read-only`; the flow has no DSH equivalent",
  "suggestedDisposition": "unmapped"
}
```

Three properties are mandatory:

1. **A reason, quoting the evidence.** A verdict without a quotable line is not
   reviewable.
2. **A confidence.** Low-confidence verdicts are surfaced first.
3. **No side effects.** The stage writes the proposal and nothing else.

### Reproducibility

Model verdicts are not deterministic, so the program never treats them as
authoritative. The proposal is a file. It can be edited by hand, re-run, and
diffed. `load` reads the proposal, not the model.

A hand-edited proposal is the intended workflow, not a workaround: the model
does the first pass over dozens of items, and the person overrides the handful
it gets wrong.

## 5. Stage 3 — load, surface by surface

### 5.1 Sessions

Hand-encoded DSH v3 artifacts. The reason is in `docs/replication-plan.md` §2:
`ignorable` is unreachable from the public write API, and it is the only
mechanism that carries records DSH has no vocabulary for.

Per session: derive the path from the header with `projectKey`; encode events
with `SessionBuilder`; verify with `restoreReleasedV3Artifact`; assert the
`ignorable` count matches the proposal.

### 5.2 Agents and prompts — merged

Codex `prompts/*.md` and `agents/*.toml` are two halves of one role: measured on
the author's home, 20 of 21 names pair exactly. The loader emits **one preset
per role**, not two migrations.

```yaml
# preset.yml
name: planner
description: Strategic planning consultant with interview workflow (THOROUGH)
order: 10
```

```yaml
# agent.cordis.yml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      <identity>…</identity>          # developer_instructions, verbatim
    complete: true

- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
```

`developer_instructions` is carried verbatim. The prompt's `description` wins
over the agent's because it is the fuller string; the agent's `description`
becomes the preset's short label where the two differ.

### 5.3 The model route, and the trap in it

The route is configured, not inferred, with `deepseek-flash` at `high` as the
default:

```
--model-route deepseek-official/deepseek-flash --reasoning-effort high
```

The source model is recorded as `unmapped`:

```json
{ "surface": "agent", "id": "planner", "field": "model",
  "disposition": "unmapped",
  "sourceValue": "gpt-5.4",
  "reason": "routed to deepseek-official/deepseek-flash per --model-route; the Codex model id has no destination" }
```

**The trap.** A preset-level `agent-default-model` row is a base that the
harness home's `settings.yaml` lays over. The comment on the shipped `glm`
profile states it:

> the user layer (`$DSH_HOME/settings.yaml`) layers over this, so a harness home
> whose settings pin another provider still wins

So on a home whose `settings.yaml` carries an `agent-default-model` section, the
row the loader writes is **inert**. Writing it and saying nothing would produce a
preset that reads `deepseek-flash`/`high` and runs whatever settings pin.

The loader therefore compares its route against the target home's `settings.yaml`
and reports:

```
agent-default-model  written: deepseek-flash / high
                     settings.yaml: deepseek-flash / max
                     → the preset row is shadowed; the session will run at max
```

The row is still written — it is correct, and it takes effect on a home that
does not pin — but the shadowing is reported rather than discovered later.

### 5.4 MCP servers

Mechanical, because Codex is implicit about transport and DSH is explicit.

| Codex | DSH | Disposition |
|---|---|---|
| `command` + `args` | `{ transport: 'stdio', command, args }` | `translated` |
| `url` | `{ transport: 'streamable-http', url, headers }` | `translated` |
| `enabled = false` | imported disabled, not skipped | `translated` |
| `startup_timeout_sec` | no destination | `unmapped` |
| `oauth_resource` | no destination | `unmapped` |
| `http_headers` containing a credential | not written | `dropped` |

### 5.5 Skills

One directory per portable skill, copied to a discovery root. The loader never
overwrites: a name that already exists is skipped and recorded, because the
destination root is shared with other agents on the machine.

### 5.6 `AGENTS.md`

Archive keeps it verbatim. The loader runs the same classification stage over it
and emits an **extraction proposal**: the sections judged portable, quoting each
section heading as evidence, plus the sections judged Codex-specific with their
reasons.

The loader writes the extracted text to `AGENTS.codex.md` and prints a diff
against the target `~/.dsh/AGENTS.md`. It does not touch that file. A tool that
rewrites a file the person maintains is worse than no tool.

### 5.7 `rules/default.rules` — the honest mapping

This is the one surface where the destination cannot represent the source, and
the reason is structural rather than a gap in the loader.

Codex's file is a per-command allow-list:

```
prefix_rule(pattern=["git", "pull"], decision="allow")
```

DSH's entire permission space is:

```
SandboxMode    = 'read-only' | 'workspace-write' | 'danger-full-access'
ApprovalPolicy = 'ask' | 'never'
PresetSpec     = { sandbox, approval, name?, description? }
```

Six combinations. A preset says *"in this sandbox, ask about everything or ask
about nothing"*. There is no destination for *"`git pull` is pre-approved and
`rm` is not"*.

So the classification stage's job on this surface is not translation. It is
**semantic compression**: read the allow-list, infer the posture it encodes, and
propose a small number of custom presets.

```json
{
  "surface": "rules",
  "proposedPreset": {
    "id": "codex-imported",
    "sandbox": "workspace-write",
    "approval": "ask",
    "name": "Codex-imported posture",
    "description": "Sandboxed writes with per-command approval. The source pre-approved 70 commands; DSH cannot express per-command approval, so this asks."
  },
  "lossy": true,
  "evidence": "68 of 70 rules allow read-only inspection, package installation and git reads; 2 allow `softwareupdate --fetch-full-installer`",
  "unrepresentable": ["per-command approval granularity"]
}
```

Every proposal on this surface carries `"lossy": true` and a non-empty
`unrepresentable` list. The loader also writes the original allow-list to
`rules/codex-prefix-rules.txt` so the information survives in a readable form
even though DSH cannot act on it.

**A note on what this loses.** If a person relied on those 70 rules to avoid
approval prompts without granting full access, that convenience does not
transfer. The options are `approval: 'ask'` and answer the prompts, or `'never'`
within a sandbox mode and lose the guardrail. The proposal states this rather
than picking for them.

## 6. Verification

Each stage asserts what would otherwise fail silently.

| Stage | Check |
|---|---|
| export | The Codex home is byte-identical afterwards. Credentials appear nowhere in the archive. Every archived file's digest matches its manifest entry. |
| classify | Every source item has exactly one proposal. Every proposal has a non-empty reason. |
| load | Every written session passes `restoreReleasedV3Artifact`; its derived path equals the written path; its `ignorable` count equals the proposal's. Every `unmapped` and `dropped` field has a reason. No file outside the target roots was touched. |

The `ignorable` count check is the one that catches silent fidelity regression:
a loader that quietly stops emitting preserved events would otherwise look
successful.

## 7. What this design does not do

- **It does not resume conversations.** Whether DSH can continue from a
  synthesized artifact is untested, and `inheritedEventCount` and seed semantics
  differ between the two programs. This is the highest-risk unknown.
- **It does not reproduce the model.** Imported agents run on the routed model.
- **It does not reproduce per-command approval.** §5.7.
- **It does not render preserved events.** They are in the log and recoverable,
  not on screen.
