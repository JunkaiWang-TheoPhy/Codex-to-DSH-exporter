// cwd-remap.test.mjs — REQ-74 cwd 重映射单测。
//
// 背景：宿主用平台相关的 isAbsolute 校验 header.cwd（dsh-session/lib/index.js:786），
// 所以源机路径（如 Windows 的 D:\demo\proj 在 POSIX 上）在 prepareHostMeta 处被剔除，
// 会话退化为未分组。那个取舍是刻意的，本选项不推翻它——只给用户一个把源前缀改写成
// 本机前缀的机会，改写结果仍要过同一道绝对性校验。
//
// 本文件只覆盖重映射本身的语义与接线，不重复既有导入流程的用例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { applyCwdRemap, attachReq26, finalizeConvertedSession } from '../lib/import-core.mjs'

const conv = (cwd) => ({ meta: { id: 'import-x', cwd }, turns: [], events: [] })
// 期望值用与产品同口径的 node:path join 计算（AGENTS.md 跨平台路径纪律）：
// applyCwdRemap 内部就是 join(to, ...rest)，写死 '/' 会在 Windows 上得到 '\local\demo\proj'
const mapped = (to, ...rest) => join(to, ...rest)
// 源机路径故意用 Windows 形态（跨机迁移的真实场景）：这些常量是被测**输入**，
// 不是「本机 cwd 断言」，因此不走 hostAbs——那会把要测的场景抹掉。
const SRC = {
  proj: 'D:\\demo\\proj',
  demo: 'D:\\demo',
  src: 'D:\\demo\\proj\\src',
  demolition: 'D:\\demolition\\x',
  traversal: 'D:\\demo\\..\\etc',
}

test('未传 cwdRemap 时完全不碰 meta（默认不启用，既有行为不变）', () => {
  for (const args of [{}, { cwdRemap: undefined }, { cwdRemap: [] }, { cwdRemap: null }]) {
    const out = conv(SRC.proj)
    applyCwdRemap(out, args)
    assert.equal(out.meta.cwd, SRC.proj)
    assert.equal(out.cwdRemap, undefined)
  }
})

// 参数来自模型/用户，静默忽略会让人以为已经重映射了（仓库「失败要大声」纪律）
test('畸形 cwdRemap 大声失败，而不是静默不生效', () => {
  assert.throws(() => applyCwdRemap(conv(SRC.proj), { cwdRemap: 'x' }), /cwdRemap 必须是/)
  assert.throws(() => applyCwdRemap(conv(SRC.proj), { cwdRemap: [null] }), /cwdRemap\[0\]/)
  assert.throws(() => applyCwdRemap(conv(SRC.proj), { cwdRemap: [{ from: SRC.demo }] }), /cwdRemap\[0\]/)
  assert.throws(() => applyCwdRemap(conv(SRC.proj), { cwdRemap: [{ from: ' ', to: '/x' }] }), /cwdRemap\[0\]/)
})

test('命中规则：前缀被改写为 to，其余部分按本机分隔符拼接', () => {
  const out = conv(SRC.proj)
  applyCwdRemap(out, { cwdRemap: [{ from: SRC.demo, to: '/Users/me/demo' }] })
  assert.equal(out.meta.cwd, mapped('/Users/me/demo', 'proj'))
  assert.deepEqual(out.cwdRemap, {
    from: SRC.demo,
    to: '/Users/me/demo',
    original: SRC.proj,
    mapped: mapped('/Users/me/demo', 'proj'),
    absolute: true,
  })
})

test('cwd 恰好等于 from 时映射为 to 本身（不经过 join，原样落 to）', () => {
  const out = conv(SRC.demo)
  applyCwdRemap(out, { cwdRemap: [{ from: SRC.demo, to: '/Users/me/demo' }] })
  assert.equal(out.meta.cwd, '/Users/me/demo')
})

test('长前缀优先：/a 不得抢先命中 /a/b 下的路径', () => {
  const out = conv(SRC.src)
  applyCwdRemap(out, {
    cwdRemap: [
      { from: SRC.demo, to: '/short' },
      { from: SRC.proj, to: '/long' },
    ],
  })
  assert.equal(out.meta.cwd, mapped('/long', 'src'), '规则按 from 长度降序匹配')
})

test('前缀边界：from 必须落在分隔符上，D:\\demo 不得命中 D:\\demolition', () => {
  const out = conv(SRC.demolition)
  applyCwdRemap(out, { cwdRemap: [{ from: SRC.demo, to: '/x' }] })
  assert.equal(out.meta.cwd, SRC.demolition, '未命中则原样保留')
  assert.equal(out.cwdRemap, undefined)
})

test('未命中任何规则时不做任何改动', () => {
  const out = conv('/already/local/proj')
  applyCwdRemap(out, { cwdRemap: [{ from: SRC.demo, to: '/x' }] })
  assert.equal(out.meta.cwd, '/already/local/proj')
  assert.equal(out.cwdRemap, undefined)
})

test('规则里的首尾分隔符与正斜杠写法都能用', () => {
  const a = conv(SRC.proj)
  applyCwdRemap(a, { cwdRemap: [{ from: 'D:\\demo\\', to: '/local/demo/' }] })
  assert.equal(a.meta.cwd, mapped('/local/demo', 'proj'), '尾部斜杠被归一')

  const b = conv('D:/demo/proj')
  applyCwdRemap(b, { cwdRemap: [{ from: 'D:/demo', to: '/local/demo' }] })
  assert.equal(b.meta.cwd, mapped('/local/demo', 'proj'), '正斜杠写法同样命中')
})

// 源转录是不可信输入：余段含 '..' 时改写会把结果推出 to（改写后的 cwd 决定归组），
// 因此拒绝改写并如实记下原因，而不是静默拼出一个越界路径。
test('余段含 .. 时拒绝改写，并记录 parent-traversal', () => {
  const out = conv(SRC.traversal)
  applyCwdRemap(out, { cwdRemap: [{ from: SRC.demo, to: '/local/demo' }] })
  assert.equal(out.meta.cwd, SRC.traversal, '不应用会越界的改写')
  assert.equal(out.cwdRemap.reason, 'parent-traversal')
})

test('幂等：重复调用保持首次结果，不叠加', () => {
  const out = conv(SRC.proj)
  const args = { cwdRemap: [{ from: SRC.demo, to: '/local/demo' }] }
  applyCwdRemap(out, args)
  const first = out.meta.cwd
  applyCwdRemap(out, args)
  applyCwdRemap(out, { cwdRemap: [{ from: '/local/demo', to: '/other' }] })
  assert.equal(out.meta.cwd, first, '第二次改写不再生效')
})

test('to 写成相对路径时结果非本机绝对，如实记为 absolute:false（随后由 prepareHostMeta 剔除）', () => {
  // to 应当是**本机绝对**路径。这里故意给一个相对路径，验证：重映射不绕过宿主校验——
  // 结果过不了 isAbsolute，于是照旧被 prepareHostMeta 剔除、会话退化为未分组；而
  // 「非绝对」这个事实被记进 cwdRemap.absolute 供结果层上报（不静默改写）。
  const out = conv(SRC.proj)
  applyCwdRemap(out, { cwdRemap: [{ from: SRC.demo, to: 'relative/other' }] })
  assert.equal(out.meta.cwd, mapped('relative/other', 'proj'))
  assert.equal(out.cwdRemap.absolute, false, '不静默：非绝对的事实要被记下')
})

test('meta 缺失或 cwd 非字符串时安全返回', () => {
  for (const out of [{}, { meta: {} }, { meta: { cwd: 42 } }, { meta: { cwd: '' } }, null]) {
    assert.doesNotThrow(() => applyCwdRemap(out, { cwdRemap: [{ from: SRC.demo, to: '/x' }] }))
  }
})

test('接线：finalizeConvertedSession 应用重映射；attachReq26 把结果透出到返回值', () => {
  const out = conv(SRC.proj)
  finalizeConvertedSession(out, { cwdRemap: [{ from: SRC.demo, to: '/local/demo' }] })
  assert.equal(out.meta.cwd, mapped('/local/demo', 'proj'), 'finalize 阶段即改写（早于落盘与归组）')

  const res = attachReq26(out, { sessionId: 'import-x', turns: 0, messages: 0, toolCalls: 0, skipped: 0 })
  assert.deepEqual(res.cwdRemap, out.cwdRemap, '重映射事实进入返回值，可被观察')

  const plain = attachReq26(conv('/local/x'), { sessionId: 'y' })
  assert.equal(plain.cwdRemap, undefined, '未启用时不占键')
})
