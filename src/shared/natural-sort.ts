/**
 * 自然排序(FR-1 / §8):数字段按数值比较,`page2 < page10`;
 * 字符串段大小写不敏感比较,支持中英文混排。
 * 纯函数、无依赖,可单测。
 */

type Token =
  | { type: 'num'; value: string }
  | { type: 'str'; value: string }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    if (isDigit(input[i])) {
      let j = i
      while (j < input.length && isDigit(input[j])) j++
      tokens.push({ type: 'num', value: input.slice(i, j) })
      i = j
    } else {
      let j = i
      while (j < input.length && !isDigit(input[j])) j++
      tokens.push({ type: 'str', value: input.slice(i, j) })
      i = j
    }
  }
  return tokens
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/** 去除前导零后的数字串(空串视为 "0") */
function stripLeadingZeros(value: string): string {
  const stripped = value.replace(/^0+/, '')
  return stripped === '' ? '0' : stripped
}

/**
 * 按数值比较两个数字串(避免 Number 的精度损失,用长度 + 字典序)。
 * 前导零更多的视为更大("01" > "1"),保持直观的文件名顺序。
 */
function compareNumericTokens(a: string, b: string): number {
  const sa = stripLeadingZeros(a)
  const sb = stripLeadingZeros(b)
  if (sa.length !== sb.length) return sa.length - sb.length
  if (sa !== sb) return sa < sb ? -1 : 1
  // 数值相同:前导零多的排后面
  if (a.length !== b.length) return a.length - b.length
  return 0
}

function compareStrTokens(a: string, b: string): number {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  // 大小写不敏感相等:继续比较后续 token(数字段优先判定顺序)
  return 0
}

/**
 * 自然比较函数,可直接传入 Array.prototype.sort:
 * `['p1','p2','p10'].sort(naturalCompare)` → `['p1','p2','p10']`
 */
export function naturalCompare(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  const n = Math.max(ta.length, tb.length)
  for (let i = 0; i < n; i++) {
    const x = ta[i]
    const y = tb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x.type !== y.type) {
      // 数字段优先于字符串段("p2" < "pa")
      return x.type === 'num' ? -1 : 1
    }
    const cmp = x.type === 'num' ? compareNumericTokens(x.value, y.value) : compareStrTokens(x.value, y.value)
    if (cmp !== 0) return cmp
  }
  return 0
}
