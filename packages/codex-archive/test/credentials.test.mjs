// credentials.test.mjs — 凭据扫描器。
//
// 这个模块的失败有两种，方向相反，代价都不是对称的：
//   漏报 —— 明文密钥进了归档，而归档会被搬来搬去、会被共享
//   误报 —— 本该保存的配置被拒绝写入，用户的历史出现空洞
// 所以这里两个方向都测。下面所有密钥字面量都是**拼出来的**，不是真值：真实的
// key 形如 sk-proj-AAAA…，这种串一旦进了仓库就不可能真正撤回。
//
// 另外两条性质单独测：finding 绝不携带完整值；扫描是幂等的。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isScannable, scanAndRedact } from '../src/credentials.mjs'

/** 把片段拼成一个形似密钥的串，避免任何完整密钥字面量出现在本文件里。 */
const fake = (...parts) => parts.join('')

const OPENAI = fake('sk-', 'proj-', 'A'.repeat(40))
const GITHUB = fake('ghp_', 'B'.repeat(36))
const GITHUB_PAT = fake('github_pat_', 'C'.repeat(60))
const SLACK = fake('xoxb-', '123456789012-', 'D'.repeat(24))
const AWS_ID = fake('AKIA', 'E'.repeat(16))
const GOOGLE = fake('AIza', 'F'.repeat(35))
const ANTHROPIC = fake('sk-ant-', 'G'.repeat(30))

test('前缀类密钥逐条命中，且 pattern 说明是哪条规则', () => {
  const cases = [
    [OPENAI, 'openai-key'],
    [GITHUB, 'github-token'],
    [GITHUB_PAT, 'github-pat'],
    [SLACK, 'slack-token'],
    [AWS_ID, 'aws-access-key-id'],
    [GOOGLE, 'google-api-key'],
    [ANTHROPIC, 'anthropic-key'],
  ]
  for (const [secret, expected] of cases) {
    const { findings, redacted, hits } = scanAndRedact(`value = "${secret}"\n`, 'config.toml')
    assert.equal(hits, 1, `${expected} 应命中一次`)
    assert.equal(findings.length, 1)
    assert.match(findings[0].pattern, new RegExp(expected))
    assert.ok(!redacted.includes(secret), `${expected} 的明文不得留在脱敏结果里`)
  }
})

test('形状类信号：bearer、jwt、pem 私钥头', () => {
  const bearer = fake('Bearer ', 'h'.repeat(32))
  const jwt = fake('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 's'.repeat(24))

  const a = scanAndRedact(`Authorization: ${bearer}\n`, 'config.toml')
  assert.ok(a.findings.some((f) => f.pattern === 'bearer-token'))
  assert.ok(!a.redacted.includes(bearer.slice(7)), 'Bearer 后面的值必须被替换')
  assert.ok(a.redacted.includes('Bearer'), 'scheme 本身不是秘密，保留')

  const b = scanAndRedact(`token=${jwt}\n`, 'config.toml')
  assert.ok(b.findings.some((f) => f.pattern === 'jwt'))

  const c = scanAndRedact(`${fake('-----BEGIN ', 'RSA PRIVATE KEY', '-----')}\nMIIE\n`, 'id_rsa')
  assert.ok(c.findings.some((f) => f.pattern === 'pem-private-key'))
})

test('赋值形态：按 key 名命中，且值长度低于下限时不误报', () => {
  const long = fake('v', 'x'.repeat(30))
  const hit = scanAndRedact(`api_key = "${long}"\n`, 'config.toml')
  assert.equal(hit.hits, 1)
  assert.match(hit.findings[0].pattern, /^assignment:/)

  // 短值是配置标识而不是密钥。误报的代价是拒绝写入本该保存的配置。
  for (const text of ['model = "gpt-5"\n', 'password = "short"\n', 'timeout = 30\n']) {
    const result = scanAndRedact(text, 'config.toml')
    assert.equal(result.hits, 0, `${JSON.stringify(text)} 不该被当成凭据`)
    assert.equal(result.redacted, text)
  }
})

test('finding 绝不携带完整值：只有定位信息与省略中段的片段', () => {
  const { findings } = scanAndRedact(`api_key = "${OPENAI}"\n`, 'config.toml')
  assert.equal(findings.length, 1)
  const finding = findings[0]
  assert.deepEqual(Object.keys(finding).sort(), ['line', 'pattern', 'redacted', 'sourcePath'])
  assert.ok(finding.redacted.includes('…'), '必须省略中段，不能整段带出')
  assert.ok(finding.redacted.length < OPENAI.length)
  assert.ok(!finding.redacted.includes(OPENAI.slice(8, 20)), '中段不得出现在 finding 里')
  assert.equal(finding.line, 1)
  assert.equal(finding.sourcePath, 'config.toml')
})

test('同一行多个命中都被替换，且行号停在正确的行上', () => {
  const text = [
    '# comment',
    `a = "${OPENAI}"`,
    'model = "gpt-5"',
    `b = "${GITHUB}"`,
  ].join('\n') + '\n'

  const { findings, redacted, hits } = scanAndRedact(text, 'config.toml')
  assert.equal(hits, 2)
  assert.deepEqual(findings.map((f) => f.line), [2, 4])
  assert.ok(!redacted.includes(OPENAI) && !redacted.includes(GITHUB))
  assert.ok(redacted.includes('model = "gpt-5"'), '无关行必须一字不动')
  assert.equal(redacted.split('\n').length, text.split('\n').length, '替换不得增删行')
})

test('幂等：对已脱敏的文本再扫一次不再命中', () => {
  const once = scanAndRedact(`api_key = "${OPENAI}"\nbearer = "${fake('Bearer ', 'z'.repeat(30))}"\n`, 'config.toml')
  assert.ok(once.hits >= 2)
  const twice = scanAndRedact(once.redacted, 'config.toml')
  assert.equal(twice.hits, 0, `占位符本身不该再被当成凭据：${JSON.stringify(twice.findings)}`)
  assert.equal(twice.redacted, once.redacted)
})

test('isScannable：二进制与归档格式跳过，文本与已知配置扫', () => {
  for (const name of ['state_5.sqlite', 'x.db-wal', 'a.zst', 'b.png', 'c.zip', 'd.dylib', 'e.shm']) {
    assert.equal(isScannable(name), false, `${name} 是二进制，扫它只会制造噪音`)
  }
  for (const name of ['config.toml', 'AGENTS.md', 'hooks.json', 'skills/demo/SKILL.md', 'rules/default.rules']) {
    assert.equal(isScannable(name), true, `${name} 是文本，必须扫`)
  }
})

test('真实形态的两条已知事实：长 config 不误报，auth.json 的 jwt 被抓住', () => {
  // 合成一段形状接近真实 config.toml 的文本——用户自己的文件不进 fixture。
  const config = [
    'model = "gpt-5"',
    'approval_policy = "never"',
    '[mcp_servers.demo]',
    'url = "https://example.invalid/mcp"',
    'startup_timeout_sec = 20',
    '[projects."/demo/proj"]',
    'trust_level = "trusted"',
  ].join('\n') + '\n'
  assert.equal(scanAndRedact(config, 'config.toml').hits, 0, '普通配置不得误报')

  // auth.json 形态：tokens 对象里是 JWT。
  const jwt = fake('eyJhbGciOiJSUzI1NiJ9', '.', 'eyJzdWIiOiJ1c2VyIn0', '.', 'k'.repeat(40))
  const auth = `{"tokens":{"access_token":"${jwt}","id_token":"${jwt}"},"last_refresh":"2026-01-01T00:00:00Z"}\n`
  const result = scanAndRedact(auth, 'auth.json')
  assert.ok(result.hits >= 2, 'auth.json 里的两个 JWT 都应命中')
  assert.ok(!result.redacted.includes(jwt))
})
