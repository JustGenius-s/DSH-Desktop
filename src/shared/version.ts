/** 解析版本号为 [major, minor, patch, prerelease 段数组]；非数字段补 0。 */
function parseVersion(v: string): [number, number, number, string[]] {
  const m = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim())
  if (m === null) return [0, 0, 0, []]
  const pre = m[4] === undefined ? [] : m[4].split('.')
  return [Number(m[1]), Number(m[2]), Number(m[3]), pre]
}

/** 比较两个版本号（semver，含 prerelease 规则）：a > b 返回正数，相等 0，小于负数。
 *  正式版 > 同号的任何 prerelease；prerelease 之间逐段比较，纯数字段按数值、
 *  其余按字典序，数字段排在非数字段之前。DSH 运行时以 rc 后缀发版，这里必须
 *  感知 prerelease，否则 0.1.0-rc.6 与 0.1.0-rc.7 会被判成相等。 */
export function compareVersions(a: string, b: string): number {
  const [aMaj, aMin, aPat, aPre] = parseVersion(a)
  const [bMaj, bMin, bPat, bPre] = parseVersion(b)
  for (const [x, y] of [
    [aMaj, bMaj],
    [aMin, bMin],
    [aPat, bPat],
  ]) {
    if (x !== y) return x - y
  }
  if (aPre.length === 0 && bPre.length === 0) return 0
  if (aPre.length === 0) return 1
  if (bPre.length === 0) return -1
  for (let i = 0; i < Math.max(aPre.length, bPre.length); i++) {
    const x = aPre[i]
    const y = bPre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = Number(x)
    const yn = Number(y)
    const xIsNum = !Number.isNaN(xn) && /^\d+$/.test(x)
    const yIsNum = !Number.isNaN(yn) && /^\d+$/.test(y)
    if (xIsNum && yIsNum) {
      if (xn !== yn) return xn - yn
      continue
    }
    if (xIsNum) return -1
    if (yIsNum) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
