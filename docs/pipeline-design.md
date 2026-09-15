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

Deterministic scoring. No model.

### Why an algorithm and not a model

Four properties, all of which a model verdict gives up:

- **Testable.** A scorer is a function with fixtures. Its verdicts are unit
  tested, and a regression is a failing assertion rather than a subtly different
  paragraph.
- **Reproducible.** The same archive yields the same proposal byte for byte, so
  a diff between two proposals means the input changed, not that the model had a
  different day.
- **Auditable.** Every verdict cites the rule that produced it and the line that
  triggered it. A model's reason is a claim about its own reasoning; a scorer's
  reason is the computation.
- **Free.** Classifying 85 skills and a 650-line document costs no tokens and no
  network round trip.

**Correction.** Earlier revisions of this document proposed a model for this
stage, on the argument that a keyword rule cannot tell a passing mention of
`~/.codex` from a shell-out to `codex exec`. That argument is sound against a
naive keyword grep and wrong as a conclusion. The distinction is structural, and
structure is parseable: an invocation lives in a code fence or on an imperative
line, a mention lives in prose.

### The shape it emits

A scored proposal, never a change:

```json
{
  "surface": "skill",
  "id": "deep-interview",
  "score": 7.5,
  "verdict": "codex-bound",
  "threshold": 3.0,
  "evidence": [
    { "line": 42, "weight": 3.0, "token": "codex exec",
      "context": "fenced", "text": "codex exec --sandbox read-only \"$task\"" },
    { "line": 43, "weight": 3.0, "token": "codex exec",
      "context": "fenced", "text": "  --output-last-message out.txt" },
    { "line": 12, "weight": 0.5, "token": "~/.codex",
      "context": "prose", "text": "the transcripts live under ~/.codex/" }
  ]
}
```

The `evidence` array is the whole point. It is what makes a threshold verdict
reviewable: a person sees the three lines that produced 7.5 and can disagree with
the weights rather than with the outcome.

### The scorer, surface by surface

**Skills.** Tokenise each `SKILL.md`. For every occurrence of a Codex-specific
token (`codex exec`, `codex resume`, `codex://`, `~/.codex`, `$CODEX_HOME`,
`oh-my-codex`, `omx `), weight by context:

| Context | Weight | Rationale |
|---|---|---|
| inside a fenced code block | 3.0 | an executable instruction |
| on an imperative line, or inside a numbered step | 2.0 | an instruction in prose |
| in a heading | 1.0 | names the subject |
| in a sentence | 0.5 | a mention |

`score = Σ weight`, verdict at `score >= threshold`. Different tokens can carry
different base weights; `codex exec` is a stronger signal than the string
`~/.codex`, and the table says so explicitly rather than burying it in a regex.

**Rules.** A parser, not a scorer. `prefix_rule(pattern=[…], decision="…")` is a
structured literal and is parsed as one:

- `pattern[0]` is a shell binary (`/bin/zsh`, `/bin/bash`, `sh`, …) and
  `pattern[1]` is `-c` or `-lc` → **shell-wrapped**, no argv-prefix match is
  possible against what the harness sees → `unmapped` with a reason.
- otherwise → an `argv-prefix` rule, copied literally.

There is no judgement in this step and a model would only add variance.

**`AGENTS.md`.** Split on headings, score each section with the same context
weighting, and emit per-section verdicts:

```json
{ "section": "读取 Codex 线程（codex://threads/<id>）", "line": 312, "score": 14.0,
  "verdict": "codex-bound", "tokens": { "codex://": 6, "codex": 8 } }
```

A 650-line document becomes roughly twenty scored sections, and a person reviews
the two or three near the threshold rather than the whole thing.

### Where the algorithm is honestly weaker

Stated because a scorer's blind spot is invisible otherwise:

- **A skill that depends on Codex without naming it is missed.** "Run the local
  agent CLI to fetch the thread" contains no token. The scorer rates it clean.
- **A paraphrase is missed.** `~/.codex/` written as `${HOME}/.codex/`.
- **Weights are a judgement.** They are chosen, documented, and tunable, which is
  better than hidden, but they are not derived from anything.

Two mitigations, both cheap:

1. **A per-surface override file.** Any item can be pinned portable or
   codex-bound by hand. The file is read before the scorer and wins.
2. **The near-threshold band is reported separately.** Items scoring between
   `threshold/2` and `threshold*2` are listed as `uncertain` so the review
   focuses where the scorer is least confident, instead of presenting a hard
   yes/no at an arbitrary line.

### The optional model pass

A model is still useful for one thing, and it is not classification: **rewriting
the selected `AGENTS.md` sections so they read coherently once the Codex-specific
material is removed.** That is prose generation, it operates on text an algorithm
already chose, and it is off by default.

The program never uses a model to decide what to keep.

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

Archive keeps it verbatim. The classify stage splits it on headings and scores
each section with the same context weighting as a skill, producing per-section
verdicts with the tokens that drove them. A person reviews the two or three
sections near the threshold rather than 650 lines.

Optionally, and off by default, a model rewrites the selected sections so they
read coherently once the Codex-specific material is gone. The selection is the
algorithm's; the model only touches prose that was already chosen.

The loader writes the extracted text to `AGENTS.codex.md` and prints a diff
against the target `~/.dsh/AGENTS.md`. It does not touch that file. A tool that
rewrites a file the person maintains is worse than no tool.

### 5.7 `rules/default.rules` — a matcher table and a shipped answerer

**Correction.** An earlier revision of this document stated that DSH has no
destination for per-command approval and that Codex's allow-list could only be
compressed into coarse presets. That was wrong. It came from checking
`permission-presets` and `user-approval`'s policy vocabulary and stopping there,
without following the approval request to its answerer chain.

The mechanism exists. `ApprovalService.request()` does not decide; it asks the
**composed answerers**:

```
OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']
```

and the contract says `'allowed-once'` is the only grant. A composed answerer
receives the tool identity and the reason, and either grants, rejects, or
abstains. An abstention falls through to the interactive prompt.

That makes the mapping nearly one-to-one:

| Codex | DSH |
|---|---|
| `prefix_rule(pattern=["git","pull"], decision="allow")` | the answerer matches the command prefix and returns `'allowed-once'` |
| no rule matches | the answerer abstains → the interactive prompt → **the command asks** |

So "git pull is pre-approved and rm is not" is expressible, and expressing it
does not require inventing anything.

#### The shape

Two artefacts, not one.

**A matcher table**, translated from the source rules:

```json
{
  "version": 1,
  "source": "~/.codex/rules/default.rules",
  "rules": [
    { "id": "r001", "kind": "argv-prefix", "argv": ["git", "pull"], "decision": "allowed-once",
      "source": "prefix_rule(pattern=[\"git\", \"pull\"], decision=\"allow\")" }
  ],
  "unmapped": [
    { "source": "prefix_rule(pattern=[\"/bin/zsh\", \"-lc\", \"…\"], decision=\"allow\")",
      "reason": "shell-wrapped form; the argv the matcher sees is the wrapper, not the wrapped command" }
  ]
}
```

**A shipped plugin** that composes an answerer reading that table. The plugin is
part of this program, not generated: the translation target should be a fixed,
reviewable interface rather than per-import generated code.

#### This is a parser, not a judgement

`prefix_rule(pattern=[…], decision="…")` is a structured literal. Splitting the
direct forms from the shell-wrapped ones is a lookup on `pattern[0]` against a
list of shell binaries, and there is no step here where a model would produce a
better answer than a parser — only a more variable one.

The rules that do not survive are reported rather than dropped, with the reason
being the parse result itself: the pattern is a shell wrapper, so argv-prefix
matching against the command the harness sees cannot fire.

#### Two constraints to state plainly

**The session policy must be `ask`.** Policy is applied *before* answerers:
`'never'` resolves every ask to `'rejected'` deterministically without consulting
them. A home running `'never'` gets no benefit from this table — the answerer
never runs. On this machine's own sessions the policy is `'never'`, so the
imported table is inert until that changes.

**A full-access sandbox rarely asks.** Under `danger-full-access` few operations
raise a request at all, so there may be nothing for the answerer to decide. The
table is a guardrail that becomes meaningful when the sandbox is narrowed, and
the loader should say so rather than implying the imported rules are doing work.

Both constraints are recorded as `unmapped`-with-reason entries in the manifest
when the target home does not satisfy them.

The original allow-list is also written to `rules/codex-prefix-rules.txt`
verbatim, so the source survives readably regardless of what the table
translates.

## 6. Verification

Each stage asserts what would otherwise fail silently.

| Stage | Check |
|---|---|
| export | The Codex home is byte-identical afterwards. Credentials appear nowhere in the archive. Every archived file's digest matches its manifest entry. |
| classify | Every source item has exactly one proposal. Every proposal cites at least one evidence line. Scorer fixtures cover each token, each context weight, the threshold boundary, and the override file. |
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
