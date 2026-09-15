// test/_support/host-path.mjs — 夹具里的「宿主平台绝对路径」（工具模块，不被 npm test 收集）
//
// 为什么需要：`lib/import-core.mjs` 落盘前按**宿主平台**的 `isAbsolute()` 剔除 cwd（宿主
// 要求 header.cwd 绝对："format v2 header cwd must be absolute"），源记录里的跨平台路径
// 会让会话退化为未分组。夹具若把 cwd 写死成 `'D:\\demo\\proj'`，Linux CI 上 `cwd` 整条被
// 剔除 → 断言拿到 undefined、分组落到「(未分组)」——这正是 CI 长期红的根因（本地 Windows
// 永远绿，因为 `path.win32.isAbsolute('D:\\demo')` 为真）。
//
// 夹具改写成 `hostAbs('D:/demo/proj')`：Windows 上得到 `D:\demo\proj`（与改造前逐字一致），
// POSIX 上得到 `/demo/proj`（去盘符）——两侧都是本平台的绝对路径，basename / 项目名不变，
// 断言与产品行为在两端同口径。
export const IS_WINDOWS = process.platform === 'win32'

/**
 * 把一个「逻辑上的绝对路径」转成本平台的绝对路径。
 * @param {string} logical 形如 `D:/demo/proj` 或 `C:/Users/u/proj`（接受 `\` 或 `/` 分隔符）
 * @returns {string} Windows：`D:\demo\proj`；POSIX：`/demo/proj`
 */
export function hostAbs(logical) {
  const s = String(logical).trim()
  if (IS_WINDOWS) return s.replace(/\//g, '\\')
  return s.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
}

/**
 * 把一段**文本**里出现的盘符绝对路径转成本平台形态（用于夹具文件内容：JSONL / JSON / SQL 文本）。
 * 认 JSON 转义形态（`D:\\demo\\proj`，即 `\\\\` 两字符）与正斜杠形态（`D:/demo/proj`）；
 * Windows 上是恒等变换，`\n` 之类的其它转义不受影响。
 * @param {string} text 夹具文本
 * @returns {string} 同样长度量级的文本，路径部分已按宿主平台改写
 */
export function hostAbsText(text) {
  const s = String(text)
  if (IS_WINDOWS) return s
  return s.replace(/[A-Za-z]:((?:\\\\|\/)[^"'\s,;)\]}]*)*/g, (match) => match.slice(2).replace(/\\\\|\//g, '/'))
}
