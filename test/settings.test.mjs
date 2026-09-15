// settings.test.mjs — REQ-71 settings.json / config.toml 翻译建议
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseClaudeSettings, parseCodexConfig, buildSettingsSuggestions, runSettingsSuggest,
} from '../lib/settings.mjs'

test('parseClaudeSettings: model / permissions / hooks / env 建议', () => {
  const json = JSON.stringify({
    model: 'claude-sonnet-4-5',
    permissions: { allow: ['Read'], deny: ['Bash'] },
    hooks: { PreToolUse: [{ matcher: 'Read' }] },
    env: { FOO: 'bar' },
  })
  const suggestions = parseClaudeSettings(json)
  assert.ok(suggestions.some((s) => s.key === 'model' && s.value === 'claude-sonnet-4-5' && !s.unmappable))
  assert.ok(suggestions.some((s) => s.key === 'permissions' && s.unmappable))
  assert.ok(suggestions.some((s) => s.key === 'hooks' && s.unmappable))
  assert.ok(suggestions.some((s) => s.key === 'env' && s.unmappable))
})

test('parseCodexConfig: model / model_provider 建议', () => {
  const toml = 'model = "gpt-5"\nmodel_provider = "openai"\n'
  const suggestions = parseCodexConfig(toml)
  assert.ok(suggestions.some((s) => s.key === 'model' && s.value === 'gpt-5'))
  assert.ok(suggestions.some((s) => s.key === 'model_provider' && s.unmappable))
})

test('runSettingsSuggest: 只读解析两个来源', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-'))
  const claudePath = join(root, 'settings.json')
  const codexPath = join(root, 'config.toml')
  writeFileSync(claudePath, JSON.stringify({ model: 'claude-sonnet-4-5' }))
  writeFileSync(codexPath, 'model = "gpt-5"\n')
  const fsLike = {
    async resolve(p) { return { targetKey: p, displayPath: p } },
    async readText(t) { return readFileSync(t.targetKey, 'utf8') },
  }
  const ctx = { fs: fsLike }
  const out = await runSettingsSuggest(ctx, { claudeSettingsPath: claudePath, codexConfigPath: codexPath })
  assert.equal(out.total, 2)
  assert.deepEqual(out.sources.sort(), ['claude', 'codex'].sort())
  assert.ok(out.suggestions.every((s) => typeof s.suggestion === 'string'))
})

test('buildSettingsSuggestions: 合并列表', () => {
  const a = [{ key: 'model', source: 'claude', value: 'x', suggestion: 's', unmappable: false }]
  const b = [{ key: 'model', source: 'codex', value: 'y', suggestion: 't', unmappable: true }]
  assert.equal(buildSettingsSuggestions(a, b).length, 2)
})
