// opencode-tool-map.test.mjs — REQ-74 opencode 工具名映射
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapOpencodeToolName, convertOpencodeJson } from '../lib/convert/opencode.mjs'

test('mapOpencodeToolName: 已知别名映射到 DSH 标准工具名，未知原样保留', () => {
  assert.equal(mapOpencodeToolName('websearch'), 'web_search')
  assert.equal(mapOpencodeToolName('webfetch'), 'web_fetch')
  assert.equal(mapOpencodeToolName('question'), 'ask_user_question')
  assert.equal(mapOpencodeToolName('todowrite'), 'todo_write')
  assert.equal(mapOpencodeToolName('task'), 'subagent')
  assert.equal(mapOpencodeToolName('read'), 'read')
  assert.equal(mapOpencodeToolName('custom_tool'), 'custom_tool')
})

test('convertOpencodeJson: tool part 使用映射后的 DSH 工具名', () => {
  const chat = {
    id: 'oc-map-1',
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'tool', tool: 'websearch', state: { input: { query: 'x' }, output: 'ok' } },
        ],
      },
    ],
  }
  const out = convertOpencodeJson(JSON.stringify(chat))
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.ok(call, 'tool/call 存在')
  assert.equal(call.data.name, 'web_search')
})
