// interchange.test.mjs — REQ-18 interchange v1 协议 + REQ-21 降级规则单测
//（纯函数：schema 校验、序列化、能力矩阵、降级汇总）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INTERCHANGE_VERSION,
  INTERCHANGE_NAMESPACE,
  INTERCHANGE_SCHEMA,
  validateInterchange,
  serializeInterchange,
  SOURCE_CAPABILITIES,
  DEGRADATION_RULES,
  summarizeDegradations,
  exportDegradations,
} from '../convert.mjs'
import { validateSessionEvents } from '../convert.mjs'
import { synthesizeSession, SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'

function sampleConverted() {
  return {
    meta: { version: SESSION_FORMAT_VERSION, id: 'import-demo-1', sourceId: 'demo-1', cwd: 'C:\\work', createdAt: 1710000000000 },
    title: '演示会话',
    provider: 'claude-code',
    model: 'claude-opus-4-7',
    turns: [
      {
        prompt: '第一问',
        steps: [
          {
            content: [{ type: 'text', text: '回答' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
            toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }],
          },
        ],
      },
    ],
  }
}

test('INTERCHANGE_SCHEMA: 顶层必填字段与 version const 正确', () => {
  assert.equal(INTERCHANGE_SCHEMA.properties.version.const, INTERCHANGE_VERSION)
  assert.equal(INTERCHANGE_SCHEMA.properties.interchange.const, INTERCHANGE_NAMESPACE)
  assert.deepEqual(INTERCHANGE_SCHEMA.required, ['interchange', 'version', 'meta', 'turns'])
})

test('validateInterchange: 合法文档通过', () => {
  const doc = serializeInterchange(sampleConverted())
  const r = validateInterchange(doc)
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
  assert.equal(doc.interchange, INTERCHANGE_NAMESPACE)
  assert.equal(doc.version, INTERCHANGE_VERSION)
  assert.equal(doc.meta.sourceId, 'demo-1')
  assert.equal(doc.meta.cwd, 'C:\\work')
})

test('validateInterchange: 结构问题逐条上报（缺 meta.id / turns 非数组 / toolCalls 项残缺）', () => {
  const bad = {
    interchange: INTERCHANGE_NAMESPACE,
    version: INTERCHANGE_VERSION,
    meta: { createdAt: 1 },
    turns: [
      { prompt: 'p', steps: [{ content: [], toolCalls: [{ name: 'x' }], toolResults: [{ content: [] }] }] },
    ],
  }
  const r = validateInterchange(bad)
  assert.equal(r.ok, false)
  const kinds = r.problems.map((p) => p.kind)
  assert.ok(kinds.includes('meta-id'))
  assert.ok(kinds.includes('tool-call'))
  assert.ok(kinds.includes('tool-result'))
  assert.ok(r.problems.length <= 20)
})

test('validateInterchange: 版本 / 命名空间不匹配上报', () => {
  const doc = serializeInterchange(sampleConverted())
  const r = validateInterchange({ ...doc, version: 999, interchange: 'other' })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.kind === 'version'))
  assert.ok(r.problems.some((p) => p.kind === 'namespace'))
})

test('serializeInterchange: cwd/sourceId 缺失时不占键，title 可选', () => {
  const doc = serializeInterchange({ meta: { id: 'x', createdAt: 1 }, provider: 'chatgpt', turns: [{ prompt: 'p', steps: [] }] })
  assert.equal('cwd' in doc.meta, false)
  assert.equal('sourceId' in doc.meta, false)
  assert.equal('title' in doc, false)
  assert.equal(validateInterchange(doc).ok, true)
})

test('interchange 文档可合成平衡 DSH 事件（round-trip 契约）', () => {
  // interchange turns IR 是 synthesizeSession 的直接输入：文档校验通过后必然产出
  // 结构合法的会话事件（seq 连续 / surfaceOp / sourceEventSeqs 关联）
  const converted = sampleConverted()
  const doc = serializeInterchange(converted)
  assert.equal(validateInterchange(doc).ok, true)
  const syn = synthesizeSession({ meta: converted.meta, turns: doc.turns, title: doc.title, provider: doc.provider, model: doc.model, skipped: 0, records: 1 })
  const r = validateSessionEvents(syn.events)
  assert.equal(r.ok, true, JSON.stringify(r.problems))
})

test('SOURCE_CAPABILITIES: 全部 15 源覆盖且字段齐全', () => {
  const keys = ['toolResults', 'reasoning', 'cwd', 'branches', 'attachments', 'compacted']
  for (const [format, caps] of Object.entries(SOURCE_CAPABILITIES)) {
    for (const k of keys) {
      assert.equal(typeof caps[k], 'boolean', format + '.' + k)
    }
  }
  // 已知边界（契约锚点）：cursor 无 toolResults；chatgpt 无 cwd；codex reasoning 不可见
  assert.equal(SOURCE_CAPABILITIES.cursor.toolResults, false)
  assert.equal(SOURCE_CAPABILITIES.chatgpt.cwd, false)
  assert.equal(SOURCE_CAPABILITIES.codex.reasoning, false)
})

test('summarizeDegradations: 只列 count > 0 的降级项，kind/策略映射正确', () => {
  const out = summarizeDegradations({ toolResultFallback: 3, attachmentSkipped: 1, branchCollapsed: 0 })
  assert.deepEqual(out.map((d) => d.id), ['tool-result-missing', 'attachment-skipped'])
  assert.equal(out[0].strategy, 'skip-placeholder')
  assert.equal(out[0].count, 3)
  assert.equal(out[1].count, 1)
  assert.deepEqual(summarizeDegradations({}), [])
})

test('DEGRADATION_RULES: 规则 id 唯一、kind 唯一、策略三态合法', () => {
  const ids = new Set()
  const kinds = new Set()
  for (const rule of DEGRADATION_RULES) {
    assert.ok(!ids.has(rule.id), '重复 id ' + rule.id)
    ids.add(rule.id)
    assert.ok(!kinds.has(rule.kind), '重复 kind ' + rule.kind)
    kinds.add(rule.kind)
    assert.ok(['lossless', 'text-fallback', 'skip-placeholder'].includes(rule.strategy), rule.id)
  }
})

test('exportDegradations: 序列化器计数 → 结构化降级清单（REQ-21 导出结果字段）', () => {
  const out = exportDegradations({ droppedToolResults: 2, skippedInjections: 1, skippedBlocks: 0 })
  assert.deepEqual(out.map((d) => d.id), ['injection-skipped', 'orphan-tool-result'])
  assert.equal(out[1].strategy, 'skip-placeholder')
  assert.equal(out[1].count, 2)
  // 全零 → undefined（不占结果键）
  assert.equal(exportDegradations({ droppedToolResults: 0, skippedInjections: 0, skippedBlocks: 0 }), undefined)
  assert.equal(exportDegradations({}), undefined)
})
