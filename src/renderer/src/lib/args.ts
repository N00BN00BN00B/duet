/** Splits a command-line string into arguments, honoring single/double quotes and backslashes. */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let has = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i]
      has = true
    } else {
      cur += ch
      has = true
    }
  }
  if (cur || has) out.push(cur)
  return out
}

/** Inverse of splitArgs: quotes arguments that need it. */
export function joinArgs(args: string[] = []): string {
  return args.map((a) => (a === '' || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ')
}
