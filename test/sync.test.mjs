// sync.test.mjs — 双向增量同步：配置、Codex/Grok 往返、入站巡检、出站写回
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, appendFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeCodexJsonl } from '../lib/export/codex.mjs'
import { serializeGrokbuildJsonl, buildGrokSummary } from '../lib/export/grokbuild.mjs'
import { convertCodexJsonl, convertGrokbuildJson } from '../convert.mjs'
import { loadSyncConfig, saveSyncConfig, DEFAULT_INTERVAL_MS } from '../lib/sync-config.mjs'
import { runSyncOnce, stopSyncTimer, lazyInboundCheck } from '../lib/sync-loop.mjs'
import { registerSyncRoutes } from '../lib/sync-panel.mjs'
import { clearScanCache } from '../lib/discovery.mjs'

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-sync-home-'))
  clearScanCache()
})

afterEach(() => {
  stopSyncTimer()
})

function ev(type, seq, data, extra = {}) {
  return { type, seq, time: 1_700_000_000_000, data, ...extra }
}

function sampleEvents() {
  return [
    ev('session/imported', 0, { tool: 'dsh', sourceId: 'native-1', importedAt: 1 }, { ignorable: true }),
    ev('turn/start', 1, { turn: 1 }),
    ev('user/message', 2, {
      id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' }),
    ev('assistant/message', 3, {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
    }, { surfaceOp: 'append' }),
    ev('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
    ev('session/title', 5, { title: '测试会话', messageSeqs: [], source: { kind: 'user' } }),
  ]
}

test('sync 配置默认关闭，保存后能读回开关', async () => {
  const dir = join(process.env.DSH_HOME, 'dsh-chat-import')
  const fresh = await loadSyncConfig(dir)
  assert.equal(fresh.inbound.enabled, false)
  assert.equal(fresh.outbound.enabled, false)
  assert.equal(fresh.intervalMs, DEFAULT_INTERVAL_MS)
  const saved = await saveSyncConfig(dir, {
    inbound: { enabled: true, formats: ['claude'] },
    outbound: { enabled: true, targets: ['codex', 'grokbuild'] },
    intervalMs: 30_000,
  })
  assert.equal(saved.inbound.enabled, true)
  assert.deepEqual(saved.inbound.formats, ['claude'])
  assert.deepEqual(saved.outbound.targets, ['codex', 'grokbuild'])
  const again = await loadSyncConfig(dir)
  assert.equal(again.inbound.enabled, true)
  assert.equal(again.intervalMs, 30_000)
})

test('Codex 往返：DSH 事件 → rollout JSONL → convertCodexJsonl 保住用户轮', () => {
  const events = sampleEvents()
  const out = serializeCodexJsonl({
    meta: { id: 'native-1', createdAt: 1_700_000_000_000, cwd: '/tmp/proj' },
    events,
    sessionUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    cwd: '/tmp/proj',
  })
  assert.match(out.jsonl, /session_meta/)
  const back = convertCodexJsonl(out.jsonl, { sourcePath: '/tmp/rollout.jsonl' })
  assert.equal(back.turns.length, 1)
  assert.equal(back.turns[0].prompt, '你好')
})

test('Grok 往返：DSH 事件 → chat_history + summary → convertGrokbuildJson', () => {
  const events = sampleEvents()
  const out = serializeGrokbuildJsonl({
    meta: { id: 'native-1', createdAt: 1_700_000_000_000, cwd: '/tmp/proj' },
    events,
  })
  const summary = JSON.stringify(buildGrokSummary({
    sessionUuid: '01a0048c-c8aa-7911-8be8-5959ab1fd2ec',
    cwd: '/tmp/proj',
    title: '测试会话',
    createdAt: 1_700_000_000_000,
    numMessages: 2,
  }))
  const back = convertGrokbuildJson(summary, out.jsonl, { sourcePath: '/tmp/grok-sess' })
  assert.equal(back.turns.length, 1)
  assert.equal(back.turns[0].prompt, '你好')
})

function makeRealCtx(root) {
  const sessions = new Map()
  const persistence = {
    async list() { return [...sessions.values()].map((s) => s.meta) },
    async create(meta) { sessions.set(meta.id, { meta, events: [] }) },
    async append(id, events) {
      const s = sessions.get(id)
      for (const ev of events) s.events.push(ev)
    },
    async inspect(id) { return sessions.get(id) },
    async readFrom(id, fromSeq = 0) {
      const s = sessions.get(id)
      return { meta: s.meta, events: s.events.slice(fromSeq) }
    },
  }
  const webRoutes = []
  const versionOf = (p) => {
    try {
      const s = statSync(p)
      return 'v' + s.size + '-' + Math.trunc(s.mtimeMs)
    } catch {
      return 'missing'
    }
  }
  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      try {
        const s = statSync(target.targetKey)
        return s.isDirectory()
          ? { type: 'directory', size: 0, version: versionOf(target.targetKey), mtimeMs: s.mtimeMs }
          : { type: 'file', size: s.size, version: versionOf(target.targetKey), mtimeMs: s.mtimeMs }
      } catch {
        return undefined
      }
    },
    async readText(target) { return readFileSync(target.targetKey, 'utf8') },
    async writeText(target, content, options) {
      if (options && options.kind === 'replaceIfVersion') {
        if (versionOf(target.targetKey) !== options.version) {
          throw Object.assign(new Error('FS_STALE_VERSION'), { code: 'FS_STALE_VERSION' })
        }
      }
      if (options && options.kind === 'createIfAbsent' && existsSync(target.targetKey)) {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
      mkdirSync(join(target.targetKey, '..'), { recursive: true })
      writeFileSync(target.targetKey, content)
      return { operation: 'update', version: versionOf(target.targetKey) }
    },
    async listDir(target) {
      return readdirSync(target.targetKey, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        target: { targetKey: join(target.targetKey, e.name), displayPath: join(target.targetKey, e.name) },
      }))
    },
    processPath(target) { return target.targetKey },
  }
  const ctx = {
    fs,
    sessionPersistence: persistence,
    webServer: { register(def) { webRoutes.push(def); return () => {} } },
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'webServer') return ctx.webServer
      if (name === 'workspaceRegistry') return { resolveByPath: async () => null, create: async () => ({ attachSession: async () => {} }), archivedSessionIds: [] }
      return undefined
    },
    inject(_list, cb) { return cb(ctx) },
    on() { return () => {} },
    effect() { return () => {} },
  }
  return { ctx, persistence, sessions, webRoutes, root }
}

test('入站巡检：未导入 Claude 文件 → imported，再跑一轮 → skipped', async () => {
  const home = process.env.DSH_HOME
  const srcDir = join(home, 'claude-src')
  mkdirSync(srcDir, { recursive: true })
  const file = join(srcDir, 'sess-sync-001.jsonl')
  writeFileSync(file, [
    JSON.stringify({ sessionId: 'sess-sync-001', type: 'user', cwd: join(home, 'proj'), message: { role: 'user', content: '增量问题' } }),
    JSON.stringify({ sessionId: 'sess-sync-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '增量回答' }] } }),
  ].join('\n') + '\n')
  const { ctx, sessions } = makeRealCtx(home)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: true, formats: ['claude'] },
    outbound: { enabled: false, targets: ['claude'] },
  })
  const first = await runSyncOnce(ctx, registryDir, { path: srcDir })
  assert.equal(first.ok, true)
  assert.equal(first.inbound.imported, 1)
  assert.equal(sessions.size, 1)
  const second = await runSyncOnce(ctx, registryDir, { path: srcDir })
  assert.equal(second.inbound.imported, 0)
  assert.ok(second.inbound.skipped >= 1)
})

test('出站写回：原生 DSH 会话落到 Codex 副本，再增量追加', async () => {
  const home = process.env.DSH_HOME
  const outRoot = join(home, 'codex-out')
  mkdirSync(outRoot, { recursive: true })
  const { ctx, persistence } = makeRealCtx(home)
  const events = sampleEvents()
  await persistence.create({ id: 'native-sync', createdAt: 1_700_000_000_000, cwd: join(home, 'proj') })
  await persistence.append('native-sync', events)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: false, formats: ['claude'] },
    outbound: { enabled: true, targets: ['codex'], roots: { codex: outRoot } },
  })
  const first = await runSyncOnce(ctx, registryDir)
  assert.equal(first.ok, true)
  assert.equal(first.outbound.synced, 1)
  const mapping = JSON.parse(readFileSync(join(registryDir, 'outbound.json'), 'utf8'))
  const filePath = mapping.mappings['native-sync'].codex.filePath
  assert.ok(existsSync(filePath))
  const firstText = readFileSync(filePath, 'utf8')
  assert.match(firstText, /你好/)

  await persistence.append('native-sync', [
    ev('turn/start', 6, { turn: 2 }),
    ev('user/message', 7, {
      id: 'u2', role: 'user', content: [{ type: 'text', text: '第二问' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' }),
    ev('assistant/message', 8, {
      turn: 2, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '第二答' }] },
    }, { surfaceOp: 'append' }),
    ev('turn/end', 9, { turn: 2, reason: { kind: 'completed' } }),
  ])
  const second = await runSyncOnce(ctx, registryDir)
  assert.equal(second.outbound.synced, 1)
  const nextText = readFileSync(filePath, 'utf8')
  assert.match(nextText, /第二问/)
  assert.ok(nextText.length > firstText.length)
})

test('出站默认过滤子代理：delegationDepth>0 / origin=subagent 不写回', async () => {
  const home = process.env.DSH_HOME
  const outRoot = join(home, 'codex-out')
  mkdirSync(outRoot, { recursive: true })
  const { ctx, persistence } = makeRealCtx(home)
  const events = sampleEvents()
  // 子代理会话（subagent/subagent_fork 产出的 child）
  await persistence.create({ id: 'native-subagent', createdAt: 1_700_000_000_000, cwd: join(home, 'proj'), delegationDepth: 1, origin: 'subagent' })
  await persistence.append('native-subagent', events)
  // 顶层会话（对照：应正常写回）
  await persistence.create({ id: 'native-top', createdAt: 1_700_000_000_000, cwd: join(home, 'proj'), delegationDepth: 0 })
  await persistence.append('native-top', events)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: false, formats: ['claude'] },
    outbound: { enabled: true, targets: ['codex'], roots: { codex: outRoot } },
  })
  const out = await runSyncOnce(ctx, registryDir)
  assert.equal(out.ok, true)
  assert.equal(out.outbound.sessions, 2)
  assert.equal(out.outbound.synced, 1) // 只有顶层会话写回
  assert.equal(out.outbound.subagentSkipped, 1) // 子代理单独计数，不静默
  const mapping = JSON.parse(readFileSync(join(registryDir, 'outbound.json'), 'utf8'))
  assert.ok(mapping.mappings['native-top'], '顶层会话应有写回映射')
  assert.ok(!mapping.mappings['native-subagent'], '子代理会话不应有写回映射')
})

test('入站按目录排除：cwd 命中 excludeDirs 的会话不导入', async () => {
  const home = process.env.DSH_HOME
  const srcDir = join(home, 'claude-src')
  mkdirSync(srcDir, { recursive: true })
  const excluded = join(home, 'proj-excluded')
  const file = join(srcDir, 'sess-exclude-001.jsonl')
  writeFileSync(file, [
    JSON.stringify({ sessionId: 'sess-exclude-001', type: 'user', cwd: join(excluded, 'sub'), message: { role: 'user', content: '该被排除' } }),
    JSON.stringify({ sessionId: 'sess-exclude-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '答' }] } }),
  ].join('\n') + '\n')
  const { ctx, sessions } = makeRealCtx(home)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: true, formats: ['claude'], excludeDirs: [excluded] },
    outbound: { enabled: false, targets: ['claude'] },
  })
  const out = await runSyncOnce(ctx, registryDir, { path: srcDir })
  assert.equal(out.ok, true)
  assert.equal(out.inbound.scanned, 0) // 排除后不进 scanned
  assert.equal(out.inbound.excludedDirs, 1) // 单独计数不静默
  assert.equal(sessions.size, 0) // 未落任何会话
})

test('出站按目录排除：cwd 命中 excludeDirs 的 DSH 会话不写回', async () => {
  const home = process.env.DSH_HOME
  const outRoot = join(home, 'codex-out')
  mkdirSync(outRoot, { recursive: true })
  const { ctx, persistence } = makeRealCtx(home)
  await persistence.create({ id: 'native-excluded', createdAt: 1_700_000_000_000, cwd: join(home, 'proj-excluded') })
  await persistence.append('native-excluded', sampleEvents())
  await persistence.create({ id: 'native-kept', createdAt: 1_700_000_000_000, cwd: join(home, 'proj-kept') })
  await persistence.append('native-kept', sampleEvents())
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: false, formats: ['claude'] },
    outbound: { enabled: true, targets: ['codex'], roots: { codex: outRoot }, excludeDirs: [join(home, 'proj-excluded')] },
  })
  const out = await runSyncOnce(ctx, registryDir)
  assert.equal(out.ok, true)
  assert.equal(out.outbound.sessions, 2)
  assert.equal(out.outbound.synced, 1) // 只有 proj-kept 写回
  assert.equal(out.outbound.excludedDirs, 1)
  const mapping = JSON.parse(readFileSync(join(registryDir, 'outbound.json'), 'utf8'))
  assert.ok(mapping.mappings['native-kept'])
  assert.ok(!mapping.mappings['native-excluded'])
})

test('排除目录归一化：反斜杠/尾斜杠/去重 后仍能命中', async () => {
  const { normalizeDirPath } = await import('../lib/sync-config.mjs')
  assert.equal(normalizeDirPath('C:\\demo\\proj\\'), 'C:/demo/proj')
  assert.equal(normalizeDirPath('C:/demo//proj/'), 'C:/demo/proj')
  assert.equal(normalizeDirPath(' /mnt/d/Build/ '), '/mnt/d/Build')
  assert.equal(normalizeDirPath('/'), '/')
  assert.equal(normalizeDirPath(''), '')
})

test('/api-import/sync GET 返回默认关闭状态', async () => {
  const { ctx, webRoutes } = makeRealCtx(process.env.DSH_HOME)
  const registryDir = join(process.env.DSH_HOME, 'dsh-chat-import')
  registerSyncRoutes(ctx, ctx.webServer, registryDir)
  const route = webRoutes.find((r) => r.path === '/api-import/sync')
  assert.ok(route)
  const chunks = []
  const req = { method: 'GET', async *[Symbol.asyncIterator]() {} }
  const res = {
    writeHead() {},
    end(body) { chunks.push(body) },
  }
  await route.handler(req, res)
  const data = JSON.parse(chunks[0])
  assert.equal(data.ok, true)
  assert.equal(data.config.inbound.enabled, false)
  assert.equal(data.config.outbound.enabled, false)
})

test('出站追加版本守卫：读取后外部并发写入 → 拒绝覆盖而非吞掉', async () => {
  const home = process.env.DSH_HOME
  const outRoot = join(home, 'codex-out')
  mkdirSync(outRoot, { recursive: true })
  const base = makeRealCtx(home)
  const events = sampleEvents()
  await base.persistence.create({ id: 'native-race', createdAt: 1_700_000_000_000, cwd: join(home, 'proj') })
  await base.persistence.append('native-race', events)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: false, formats: ['claude'] },
    outbound: { enabled: true, targets: ['codex'], roots: { codex: outRoot } },
  })
  // 模拟外部进程在 convertExisting 读取后、appendFile 写入前落地一条并发记录：
  // readText 命中目标文件（首轮已写出）时先追加外部行再返回读取时的旧内容
  const ctx = {
    ...base.ctx,
    fs: {
      ...base.ctx.fs,
      async readText(target) {
        const text = readFileSync(target.targetKey, 'utf8')
        if (text.includes('收到') && !text.includes('并发外部记录')) {
          writeFileSync(target.targetKey, text + JSON.stringify({
            timestamp: Date.now(), type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '并发外部记录' }] },
          }) + '\n')
        }
        return text
      },
    },
  }
  const first = await runSyncOnce(ctx, registryDir)
  assert.equal(first.ok, true)
  assert.equal(first.outbound.synced, 1)
  const filePath = JSON.parse(readFileSync(join(registryDir, 'outbound.json'), 'utf8')).mappings['native-race'].codex.filePath

  await base.persistence.append('native-race', [
    ev('turn/start', 6, { turn: 2 }),
    ev('user/message', 7, {
      id: 'u3', role: 'user', content: [{ type: 'text', text: '第二问' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' }),
    ev('assistant/message', 8, {
      turn: 2, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '第二答' }] },
    }, { surfaceOp: 'append' }),
    ev('turn/end', 9, { turn: 2, reason: { kind: 'completed' } }),
  ])
  const second = await runSyncOnce(ctx, registryDir)
  assert.equal(second.ok, true)
  assert.ok(second.outbound.failed >= 1, '并发写入应使本轮写回失败而非覆盖')
  const text = readFileSync(filePath, 'utf8')
  assert.match(text, /并发外部记录/, '外部并发记录必须保留')
  assert.ok(!text.includes('第二问'), '本轮不应写入任何内容')
})

test('grok 回写真实源目录：summary.json 保留既有 info.id（不破坏目录↔id 绑定）', async () => {
  const home = process.env.DSH_HOME
  const grokDir = join(home, 'grok-proj', 'sess-real-id')
  mkdirSync(grokDir, { recursive: true })
  writeFileSync(join(grokDir, 'summary.json'), JSON.stringify({
    info: { id: 'sess-real-id', cwd: home },
    generated_title: '既有标题',
    session_summary: '既有摘要',
  }, null, 2) + '\n')
  writeFileSync(join(grokDir, 'chat_history.jsonl'), [
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: '既有问题' }], timestamp: '2026-08-01T00:00:00Z' }),
    JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: '既有回答' }], timestamp: '2026-08-01T00:00:01Z' }),
  ].join('\n') + '\n')

  const { ctx, persistence, sessions } = makeRealCtx(home)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: true, formats: ['grokbuild'] },
    outbound: { enabled: false, targets: ['grokbuild'] },
  })
  const inbound = await runSyncOnce(ctx, registryDir, { path: join(home, 'grok-proj') })
  assert.equal(inbound.ok, true)
  assert.equal(inbound.inbound.imported, 1)
  const id = [...sessions.keys()][0]

  await saveSyncConfig(registryDir, {
    inbound: { enabled: false, formats: ['grokbuild'] },
    outbound: { enabled: true, targets: ['grokbuild'] },
  })
  await persistence.append(id, [
    ev('turn/start', 100, { turn: 2 }),
    ev('user/message', 101, {
      id: 'g2', role: 'user', content: [{ type: 'text', text: '新问题' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' }),
    ev('assistant/message', 102, {
      turn: 2, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '新回答' }] },
    }, { surfaceOp: 'append' }),
    ev('turn/end', 103, { turn: 2, reason: { kind: 'completed' } }),
  ])
  const outbound = await runSyncOnce(ctx, registryDir)
  assert.equal(outbound.ok, true)
  assert.equal(outbound.outbound.synced, 1)
  const summary = JSON.parse(readFileSync(join(grokDir, 'summary.json'), 'utf8'))
  assert.equal(summary.info.id, 'sess-real-id', '真实目录 summary 的 info.id 必须保留')
  const chat = readFileSync(join(grokDir, 'chat_history.jsonl'), 'utf8')
  assert.match(chat, /既有问题/)
  assert.match(chat, /新问题/)
})

// ── REQ-54 watch 懒检查（mtime 门控，无常驻监听）──────────────────────────

test('sync 配置：watch 默认关闭，保存后读回', async () => {
  const dir = join(process.env.DSH_HOME, 'dsh-chat-import')
  const fresh = await loadSyncConfig(dir)
  assert.equal(fresh.watch.enabled, false)
  const saved = await saveSyncConfig(dir, { watch: { enabled: true } })
  assert.equal(saved.watch.enabled, true)
  const again = await loadSyncConfig(dir)
  assert.equal(again.watch.enabled, true)
})

test('watch 懒检查：mtime 未越过 importedAt → 扫描不续写；源长大且 mtime 越过 → appended', async () => {
  const home = process.env.DSH_HOME
  const srcDir = join(home, 'claude-watch')
  mkdirSync(srcDir, { recursive: true })
  const file = join(srcDir, 'sess-watch-001.jsonl')
  writeFileSync(file, [
    JSON.stringify({ sessionId: 'sess-watch-001', type: 'user', cwd: join(home, 'proj'), message: { role: 'user', content: 'watch 问题' } }),
    JSON.stringify({ sessionId: 'sess-watch-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'watch 回答' }] } }),
  ].join('\n') + '\n')
  const { ctx } = makeRealCtx(home)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: true, formats: ['claude'] },
    outbound: { enabled: false, targets: [] },
    watch: { enabled: true },
  })
  // 先完整导入一轮（registry 记录 importedAt）
  const first = await runSyncOnce(ctx, registryDir, { path: srcDir })
  assert.equal(first.ok, true)
  assert.equal(first.inbound.imported, 1)
  const rec = JSON.parse(readFileSync(join(registryDir, 'imports.json'), 'utf8')).imports[file]
  assert.equal(typeof rec.importedAt, 'number')

  // mtime 未越过 importedAt → 只扫描不续写（mtime 比较门控）
  utimesSync(file, new Date(rec.importedAt - 1000), new Date(rec.importedAt - 1000))
  const cold = await lazyInboundCheck(ctx, registryDir, { path: srcDir })
  assert.equal(cold.triggered, true)
  assert.equal(cold.scanned, 1)
  assert.equal(cold.checked, 1)
  assert.equal(cold.imported, 0)
  assert.equal(cold.appended, 0)

  // 源长大（完整新轮 user+assistant）+ mtime 越过 importedAt → 续写 appended
  appendFileSync(file, [
    JSON.stringify({ sessionId: 'sess-watch-001', type: 'user', cwd: join(home, 'proj'), message: { role: 'user', content: 'watch 第二问' } }),
    JSON.stringify({ sessionId: 'sess-watch-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'watch 第二答' }] } }),
  ].join('\n') + '\n')
  utimesSync(file, new Date(rec.importedAt + 5000), new Date(rec.importedAt + 5000))
  const hot = await lazyInboundCheck(ctx, registryDir, { path: srcDir })
  assert.equal(hot.appended, 1)
  assert.equal(hot.imported, 0)
})

test('watch 懒检查：未开启 / 入站关闭 → 零扫描零续写', async () => {
  const home = process.env.DSH_HOME
  const { ctx } = makeRealCtx(home)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: true, formats: ['claude'] },
    outbound: { enabled: false, targets: [] },
    watch: { enabled: false },
  })
  const off = await lazyInboundCheck(ctx, registryDir)
  assert.equal(off.scanned, 0)
  assert.equal(off.checked, 0)
})

test('面板 GET 打开（watch 开启）→ 触发懒检查并返回 lazyCheck', async () => {
  const home = process.env.DSH_HOME
  const { ctx, webRoutes } = makeRealCtx(home)
  const registryDir = join(home, 'dsh-chat-import')
  await saveSyncConfig(registryDir, {
    inbound: { enabled: true, formats: ['claude'] },
    outbound: { enabled: false, targets: [] },
    watch: { enabled: true },
  })
  registerSyncRoutes(ctx, ctx.webServer, registryDir)
  const route = webRoutes.find((r) => r.path === '/api-import/sync')
  const chunks = []
  const req = { method: 'GET', async *[Symbol.asyncIterator]() {} }
  const res = { writeHead() {}, end(body) { chunks.push(body) } }
  await route.handler(req, res)
  const data = JSON.parse(chunks[0])
  assert.equal(data.ok, true)
  assert.ok(data.lazyCheck, 'watch 开启时 GET 返回 lazyCheck')
  assert.equal(data.lazyCheck.triggered, true)
  assert.equal(typeof data.lazyCheck.scanned, 'number')
})
