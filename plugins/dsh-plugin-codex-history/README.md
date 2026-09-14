# dsh-plugin-codex-history

A DeepSeek Harness plugin that exposes local Codex history and harness sessions
to the agent as three read-only tools.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `codex_history_search` | `query` (required), `limit` | Matching Codex sessions newest first: title, workspace, age, size, id |
| `codex_history_locate` | `id` (required) | The rollout file path for one session, so its raw JSONL can be read directly |
| `dsh_session_list` | `workspace`, `limit` | Harness sessions grouped by workspace, newest first |

Every tool degrades to an actionable message when its index is missing rather
than throwing: `codex_history_search` tells the caller to run
`codex-to-dsh index build`.

## Prerequisite

The plugin reads indexes; it does not build them. Build both once:

```bash
codex-to-dsh index build     # Codex rollout history
codex-to-dsh list            # harness session index
```

Both indexes live under `$DSH_HOME/codex-to-dsh/`. The plugin never writes to
either home.

## Install

The plugin ships TypeScript and builds to `dist/`, so build before installing:

```bash
pnpm install
pnpm run build
dsh plugin --profile web add /absolute/path/to/plugins/dsh-plugin-codex-history
```

Restart the harness afterwards — a new patch row takes effect at boot. Confirm
the row landed:

```bash
dsh --profile web --dump-config | grep -A4 codex-history
```

## Configuration

Set on the patch row in `cordis.patch.yml`:

```yaml
- insert:
    - id: codex-history
      name: '@codex-to-dsh/dsh-plugin-codex-history'
      config:
        codexHome: ''    # defaults to $CODEX_HOME or ~/.codex
        dshHome: ''      # defaults to $DSH_HOME or ~/.dsh
        maxResults: 20
```

## Why this plugin declares the harness API locally

`src/dsh-types.ts` declares the slice of the plugin API this plugin uses,
instead of depending on the harness packages. The harness packages are not
resolvable from the public registry — a peer dependency on them fails the
install with a 404 on an internal transitive package — and a local declaration
keeps this repository buildable without a harness checkout.

Each shape in that file was read from a shipping installed harness, and the
file records where. Two facts it captures are worth knowing because they
contradict the obvious guess:

- The tool parameter schema is the harness's own JSON-value DSL, **not**
  schemastery. Requiredness is a per-property `required: true`.
- `output: { schema, render }` is mandatory. Registration throws without it.

If the harness API changes, `src/dsh-types.ts` is the one file to update, and
`pnpm run test` exercises the plugin through a stand-in for `ctx.tools`.
