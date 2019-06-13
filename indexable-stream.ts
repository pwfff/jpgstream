export class IndexableStream {
  [index: number]: number
  [index: string]: any

  reader: ReadableStreamDefaultReader;
  buffer: Uint8Array;
  offset: number;
  lastRead: number;
  done: boolean;

  constructor(reader: ReadableStreamDefaultReader) {
    this.reader = reader
    this.offset = 0
    this.lastRead = 0
    this.done = false

    return new Proxy(this, {
      get(target, name) {
        const i = Number(name)
        if (isNaN(i)) {
          return target[name.toString()]
        }
        return target.getIndex(i)
      }
    });
  }

  async getIndex(i: number): Promise<number> {
    if (this.buffer.length + this.offset <= i) {
      if (this.done) {
        throw new Error(`requested byte ${i} but source is done and we only have ${this.buffer.length + this.offset} bytes`)
      }
      await this.read()
    }

    return this.buffer[i - this.offset]
  }

  async read() {
    const { done, value } = await this.reader.read()

    this.done = done

    if (this.buffer === undefined) {
      this.buffer = value
      return
    }

    let lastChunk: Uint8Array
    if (this.lastRead > 0) {
      // drop the oldest chunk we read
      lastChunk = this.buffer.slice(this.lastRead)
      this.offset += this.buffer.length - lastChunk.length
    } else {
      lastChunk = this.buffer
    }

    const tmp = new Uint8Array(lastChunk + value.length);
    tmp.set(lastChunk, 0);
    tmp.set(value, lastChunk.length);
    this.buffer = tmp

    this.lastRead = value.length
  }
}
