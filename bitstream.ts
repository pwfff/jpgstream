export class BitStream {
  jpegEncoding: boolean;
  data: Uint8Array;
  offset: number;

  bitsCount: number;
  bitsData: number;

  constructor(input: Uint8Array, offset: number, jpegEncoding: boolean) {
    this.jpegEncoding = jpegEncoding;

    this.data = input;
    this.offset = offset;

    this.bitsCount = 0;
  }

  get length() {
    return this.data.length
  }

  get bitsLeft() {
    return ((this.length - this.offset) * 8) + this.bitsCount
  }

  readBit(): number {
    if (this.bitsCount > 0) {
      this.bitsCount--;
      return (this.bitsData >> this.bitsCount) & 1;
    }
    this.bitsData = this.readUint8();
    if (!this.jpegEncoding)
      console.log(this.bitsData.toString(16))
    if (this.bitsData == 0xFF && this.jpegEncoding) {
      var nextByte = this.readUint8();
      if (nextByte) {
        throw new Error("unexpected marker: " + ((this.bitsData << 8) | nextByte).toString(16));
      }
      // unstuff 0
    }
    this.bitsCount = 7;
    return this.bitsData >>> 7;
  }

  readBits(length: number): number {
    var n = 0;
    while (length > 0) {
      var bit = this.readBit();
      if (bit === null) return;
      n = (n << 1) | bit;
      length--;
    }
    return n;
  }

  readUint8(): number {
    return this.data[this.offset++]
  }
}

export class TeeBitStream extends BitStream {
  writeBuffer: Array<number>;

  constructor(input: Uint8Array, offset: number) {
    super(input, offset, true)
    this.writeBuffer = new Array<number>();
  }

  writeByte(value: number) {
    this.writeBuffer.push(value)
  }

  readUint8(): number {
    const value = this.data[this.offset++]
    this.writeByte(value)
    return value
  }
}

export class BitWriter {
  buffer: number[];
  writePos: number;
  currentByte: number;

  constructor() {
    this.buffer = new Array<number>();
    this.writePos = 8
  }

  writeBits(input: number, length: number) {
    let bytesWritten = Array<number>();
    while (length > 0) {
      if (this.writePos == 0) {
        if (this.currentByte != undefined) {
          // we had a byte, write it and reset
          bytesWritten.push(this.currentByte)
          this.buffer.push(this.currentByte)
          this.writePos = 8
          this.currentByte = undefined
        }
      }
      if (length >= this.writePos) {
        // shift the input over until it fits in our byte
        let toWrite = input >> (length - this.writePos)

        // mask out the stuff we just wrote
        input = input & ((1 << length - this.writePos) - 1)

        // if we didn't have a partial byte, the whole thing is our new byte
        if (this.currentByte == undefined)
          this.currentByte = toWrite
        else // if we did have a partial byte, OR our new bits in
          this.currentByte = this.currentByte | toWrite

        length -= this.writePos
        this.writePos = 0
      } else {
        let toWrite = input << this.writePos - length

        if (this.currentByte == undefined)
          this.currentByte = toWrite
        else
          this.currentByte = this.currentByte | toWrite

          this.writePos -= length
          length = 0
      }
    }

    // final flush
    if (this.writePos == 0) {
      if (this.currentByte != undefined) {
        // we had a byte, write it and reset
        bytesWritten.push(this.currentByte)
        this.buffer.push(this.currentByte)
        this.writePos = 8
        this.currentByte = undefined
      }
    }

    return bytesWritten
  }
}
