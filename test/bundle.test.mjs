// bundle.test.mjs — REQ-56/62 interchange bundle 纯函数单测：序列化 / 双层指纹 /
// 损坏检测 / 还原 JSONL 往返。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  BUNDLE_NAMESPACE, BUNDLE_FORMAT, BUNDLE_VERSION,
  sessionLogToJsonl, serializeBundle, verifyBundle,
} from '../export.mjs'
import { convertDshJsonl } from '../convert.mjs'

const T = 1786000000000

function sampleEvents() {
  return [
    { type: 'turn/start', seq: 0, time: T, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: T, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: T, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '你好！' }], source: { kind: 'model', provider: 'claude-code' } } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 3, time: T, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('sessionLogToJsonl: session 头 + 事件行，可被 convertDshJsonl 还原', () => {
  const meta = { id: 'import-orig-001', cwd: 'C:\\work', createdAt: T }
  const log = sessionLogToJsonl(meta, sampleEvents())
  const lines = log.slice(0, -1).split('\n')
  assert.equal(lines.length, 5)
  assert.deepEqual(JSON.parse(lines[0]), { type: 'session', id: 'import-orig-001', cwd: 'C:\\work', createdAt: T })
  assert.equal(JSON.parse(lines[1]).type, 'turn/start')
  // 还原：convertDshJsonl 能消费（0 skipped，事件重排 seq）
  const out = convertDshJsonl(log, { sourcePath: 'bundle.json' })
  assert.equal(out.skipped, 0)
  assert.ok(out.turns.length >= 1)
  assert.equal(out.messages, 2)
})

test('serializeBundle: 双层指纹正确（session = hash(log)，bundle = hash(其余字段)）', () => {
  const doc = serializeBundle({ meta: { id: 's1', cwd: 'C:\\work', createdAt: T }, events: sampleEvents(), sourceSessionId: 's1', exportedAt: T })
  assert.equal(doc.bundle, BUNDLE_NAMESPACE)
  assert.equal(doc.format, BUNDLE_FORMAT)
  assert.equal(doc.version, BUNDLE_VERSION)
  assert.equal(doc.originalCwd, 'C:\\work')
  assert.equal(doc.landingHint, 'work')
  assert.equal(doc.sha256.session, createHash('sha256').update(doc.log, 'utf8').digest('hex'))
  assert.equal(verifyBundle(doc).ok, true)
  // 确定性：同一输入（含 exportedAt）两次序列化指纹一致
  const again = serializeBundle({ meta: { id: 's1', cwd: 'C:\\work', createdAt: T }, events: sampleEvents(), sourceSessionId: 's1', exportedAt: T })
  assert.equal(again.sha256.bundle, doc.sha256.bundle)
  assert.equal(again.sha256.session, doc.sha256.session)
})

test('verifyBundle: 篡改检测（log 改动 / 指纹字段改动）大声失败', () => {
  const doc = serializeBundle({ meta: { id: 's1', cwd: 'C:\\work', createdAt: T }, events: sampleEvents(), sourceSessionId: 's1' })
  // 会话级：log 被篡改（fingerprint 不重算）
  const tampered = { ...doc, log: doc.log.replace('你好！', '被改') }
  const r1 = verifyBundle(tampered)
  assert.equal(r1.ok, false)
  assert.ok(r1.problems.some((p) => p.includes('会话级指纹不匹配')))
  // 文件级：bundle 指纹字段被改
  const tampered2 = { ...doc, sha256: { ...doc.sha256, bundle: 'deadbeef' } }
  const r2 = verifyBundle(tampered2)
  assert.equal(r2.ok, false)
  assert.ok(r2.problems.some((p) => p.includes('文件级指纹不匹配')))
  // 形状：version/format 不符
  const r3 = verifyBundle({ ...doc, version: 999 })
  assert.equal(r3.ok, false)
  // 非对象
  assert.equal(verifyBundle(null).ok, false)
  assert.equal(verifyBundle('x').ok, false)
})

test('verifyBundle: originalCwd 缺失不报错（机器无关/无 cwd 会话）', () => {
  const doc = serializeBundle({ meta: { id: 's2', createdAt: T }, events: sampleEvents(), sourceSessionId: 's2' })
  assert.equal(doc.originalCwd, null)
  assert.equal(verifyBundle(doc).ok, true)
})
