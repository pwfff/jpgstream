export class BitStream {
  data: Uint8Array;
  offset: number;

  bitsCount: number;
  bitsData: number;

  constructor(input: Uint8Array, offset: number) {
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
    if (this.bitsData == 0xFF) {
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
    super(input, offset)
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
