// credentials.mjs — 凭据扫描与脱敏。
//
// 导出端唯一做判断的地方。规范（docs/archive-format.md §1）把「全部原样」定为默认，
// 凭据是唯一的例外：命中即拒绝写入原文。
//
// 两条不可违反的性质：
//   1. 绝不把命中的完整值写进任何输出——归档、manifest、日志、报告都不行。
//   2. 扫描必须是可解释的：每条 finding 带上是哪条规则命中的、在第几行。

/**
 * 已公开的密钥前缀。这些是高置信度信号：形状本身就说明它是密钥。
 * 每条带自己的名字，便于报告里说明命中了什么。
 *
 * **顺序有意义。** 匹配是按数组顺序跑的，而 `sk-ant-…` 同时满足两条：OpenAI 的值类
 * `[A-Za-z0-9_-]{20,}` 也吃 `ant-` 后面那串。把 openai-key 放在前面，一条 Anthropic
 * 密钥就会被报成 `openai-key`——命中的是同一个串，但 finding 里那条规则名是读者唯一的
 * 解释，报错名字比不报还糟。更具体的前缀必须排在更宽的前缀之前。
 */
const PREFIX_RULES = [
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{60,}/g],
  ['slack-token', /\bxox[abpsr]-[A-Za-z0-9-]{10,}/g],
  ['aws-access-key-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
]

/** 结构性信号：不依赖前缀，靠形状识别。 */
const SHAPE_RULES = [
  ['bearer-token', /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['pem-private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
]

/**
 * 赋值形态：`key = "..."` / `"token": "..."` / `PASSWORD=...`。
 *
 * 值长下限 16 是有意的。低于它的值几乎都是配置标识而非密钥，而把 `model = "gpt-5"`
 * 这类误判成凭据会让归档拒绝写入本该保存的文件——守卫带误报比没有守卫更糟。
 */
const ASSIGNMENT = new RegExp(
  String.raw`(?:^|[\s{,"'])` +
  String.raw`([A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|passwd|password|credential|authorization|auth[_-]?token)[A-Za-z0-9_]*)` +
  String.raw`\s*[:=]\s*` +
  String.raw`["']?([A-Za-z0-9._~+/=-]{16,})["']?`,
  'gi',
)

/** 只保留首尾各 4 个字符，中间省略。短值整体替换。 */
function redact(value) {
  if (value.length <= 12) return '…'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/**
 * 扫描一段文本，返回命中项与脱敏后的文本。
 *
 * 两者一起返回而不是分两步，是为了让「找到什么」和「写出去什么」不可能不一致。
 * @param {string} text - 待扫描内容。
 * @param {string} sourcePath - 相对 Codex home 的路径，写进 finding。
 * @returns {{ findings: import('./types.d.ts').SecretFinding[], redacted: string, hits: number }}
 */
export function scanAndRedact(text, sourcePath) {
  const lines = text.split('\n')
  /** @type {import('./types.d.ts').SecretFinding[]} */
  const findings = []
  let hits = 0

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]

    /** 在行内收替换区间，稍后一次性重建，避免偏移错乱。 */
    const spans = []

    for (const [pattern, regex] of [...PREFIX_RULES, ...SHAPE_RULES]) {
      regex.lastIndex = 0
      let m
      while ((m = regex.exec(line)) !== null) {
        // SHAPE 规则用捕获组时只脱敏组内容（如 `Bearer <token>` 里的 token）。
        const value = m[1] ?? m[0]
        const at = m[1] !== undefined ? line.indexOf(m[1], m.index) : m.index
        spans.push({ start: at, end: at + value.length, pattern, value })
      }
    }

    ASSIGNMENT.lastIndex = 0
    let a
    while ((a = ASSIGNMENT.exec(line)) !== null) {
      const value = a[2]
      const at = line.indexOf(value, a.index)
      spans.push({ start: at, end: at + value.length, pattern: `assignment:${a[1]}`, value })
    }

    if (spans.length === 0) continue

    // 从后往前替换，前面的偏移不受影响；重叠区间去重。
    spans.sort((x, y) => y.start - x.start)
    let lastStart = Number.POSITIVE_INFINITY
    for (const span of spans) {
      if (span.end > lastStart) continue
      lastStart = span.start
      findings.push({
        sourcePath,
        line: index + 1,
        pattern: span.pattern,
        redacted: redact(span.value),
      })
      line = line.slice(0, span.start) + `<redacted:${span.pattern}>` + line.slice(span.end)
      hits += 1
    }

    lines[index] = line
  }

  return { findings, redacted: lines.join('\n'), hits }
}

/**
 * 判断一个文件是否值得扫描。
 *
 * 二进制（sqlite、zstd、图片）跳过——它们的字节里出现「看起来像密钥」的随机序列
 * 是必然的，扫它们只会制造噪音。按扩展名与已知的二进制后缀判断。
 * @param {string} name - 文件名。
 * @returns {boolean}
 */
export function isScannable(name) {
  if (/\.(sqlite|sqlite3|db|db-wal|db-shm|zstd|zst|png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|so|dylib|node)$/i.test(name)) return false
  if (/(^|[-.])shm$|(^|[-.])wal$/i.test(name)) return false
  return true
}
