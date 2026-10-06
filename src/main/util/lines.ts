/**
 * Splits a byte stream into newline-delimited lines. Handles chunks that end
 * mid-line, chunks with many lines, CRLF endings and multi-byte UTF-8 characters
 * split across chunk boundaries.
 */
export class LineSplitter {
  private buffer = ''
  private readonly decoder = new TextDecoder('utf-8')

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | Uint8Array | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.trim().length > 0) this.onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  /** Emits whatever is left once the stream ends. */
  flush(): void {
    this.buffer += this.decoder.decode()
    const rest = this.buffer.trim()
    this.buffer = ''
    if (rest.length > 0) this.onLine(rest)
  }
}

/** Keeps the last `max` characters of a stream, used for stderr diagnostics. */
export class TailBuffer {
  private text = ''
  constructor(private readonly max = 4000) {}
  push(chunk: Buffer | string): void {
    this.text += chunk.toString()
    if (this.text.length > this.max) this.text = this.text.slice(-this.max)
  }
  get value(): string {
    return this.text
  }
}
