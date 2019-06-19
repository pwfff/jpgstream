export class IndexableStream {
  [index: number]: Promise<number>
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
        const ret = target.getIndex(i)
        return ret.catch(e => {
          console.log(e)
          throw e
        })
      }
    });
  }

  async getIndex(i: number): Promise<number> {
    if (this.buffer === undefined || (this.buffer.length + this.offset <= i)) {
      if (this.done) {
        throw new Error(`requested byte ${i} but source is done and we only have ${this.buffer.length + this.offset} bytes`)
      }
      await this.read()
    }

    return this.buffer[i - this.offset]
  }

  async slice(from: number, to: number): Promise<Uint8Array> {
    try {
      if (from < this.offset) {
        throw new Error(`can't get data before ${this.offset}`)
      }

      while (from > this.offset + this.buffer.length) {
        await this.read()
      }

      let ret = new Uint8Array(to - from)
      let writeOffset = 0

      while (to > this.offset + this.buffer.length) {
        let toWrite = this.buffer.slice(from + writeOffset - this.offset)
        ret.set(toWrite, writeOffset)
        writeOffset += toWrite.length
        await this.read()
      }

      let toWrite = this.buffer.slice(from + writeOffset - this.offset, to - this.offset)
      ret.set(toWrite, writeOffset)

      return ret
    } catch (e) {
      console.log(e)
      throw e
    }
  }

  async read() {
    const { done, value } = await this.reader.read()

    this.done = done

    if (done) {
      return
    }

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

    const tmp = new Uint8Array(lastChunk.length + value.length);
    tmp.set(lastChunk, 0);
    tmp.set(value, lastChunk.length);
    this.buffer = tmp

    this.lastRead = value.length
  }
}
