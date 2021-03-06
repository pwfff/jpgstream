import { BitStream, TeeBitStream, BitWriter } from "./bitstream";
import { fromByteArray } from 'ipaddr.js'

export async function modifyJPGStream(data: Uint8Array, writable: WritableStream, payload: Uint8Array, recover: boolean) {
  const writer = writable.getWriter();

  let recoverBits = 0, recoveredByte: number = undefined, recoverBytes: number = undefined;

  // https://github.com/eugeneware/jpeg-js/blob/master/lib/decoder.js
  var dctZigZag = new Int32Array([
    0,
    1, 8,
    16, 9, 2,
    3, 10, 17, 24,
    32, 25, 18, 11, 4,
    5, 12, 19, 26, 33, 40,
    48, 41, 34, 27, 20, 13, 6,
    7, 14, 21, 28, 35, 42, 49, 56,
    57, 50, 43, 36, 29, 22, 15,
    23, 30, 37, 44, 51, 58,
    59, 52, 45, 38, 31,
    39, 46, 53, 60,
    61, 54, 47,
    55, 62,
    63
  ]);

  var dctCos1 = 4017   // cos(pi/16)
  var dctSin1 = 799   // sin(pi/16)
  var dctCos3 = 3406   // cos(3*pi/16)
  var dctSin3 = 2276   // sin(3*pi/16)
  var dctCos6 = 1567   // cos(6*pi/16)
  var dctSin6 = 3784   // sin(6*pi/16)
  var dctSqrt2 = 5793   // sqrt(2)
  var dctSqrt1d2 = 2896  // sqrt(2) / 2

  function buildHuffmanTable(codeLengths: Uint8Array, values: Uint8Array, isDC: boolean, huffmanIndex: number): Node {
    // k is our index into the values list
    var k = 0;

    // don't look at any empty code lengths
    var length = 16;
    while (length > 0 && !codeLengths[length - 1])
      length--;

    // start with an empty root node
    const codes: Node[] = [{ left: undefined, right: undefined, index: 0 }]
    var p = codes[0];

    // loop through the code length array, from the beginning
    for (let i = 0; i < length; i++) {

      // process `codeLengths[i]` number of codes from the values
      for (let j = 0; j < codeLengths[i]; j++) {
        const value = values[k]

        // pull the last node off of our list
        p = codes.pop();

        // p.index tracks if this value should go on the left or right
        p.index == 0 ? p.left = value : p.right = value;

        // if this node is full, go back until we find a node with room
        while (p.index > 0) {
          p = codes.pop();
        }

        // mark that the next entry goes into the right branch
        p.index++;

        // get back on the end of our list of nodes
        codes.push(p);

        // the tree is built such that the values only fill up all the nodes if there
        // are no more values/nodes under them.
        // here, we fill the rest of this level of the tree with new, empty nodes.
        while (codes.length <= i) {
          let q: Node = { left: undefined, right: undefined, index: 0 }
          codes.push(q);
          p.index == 0 ? p.left = q : p.right = q
          p = q;
        }
        k++;
      }
      if (i + 1 < length) {
        // p here points to last code
        let q: Node = { left: undefined, right: undefined, index: 0 }
        codes.push(q);
        p.index == 0 ? p.left = q : p.right = q
        p = q;
      }
    }

    return codes[0];
  }

  async function decodeScan(data: Uint8Array, offset: number,
    frame: JPEGFrame, components: Component[], resetInterval: number,
    spectralStart: number, spectralEnd: number,
    successivePrev: number, successive: number) {
    var mcusPerLine = frame.mcusPerLine;
    var progressive = frame.progressive;

    const bitStream = new TeeBitStream(data, offset);
    const recoverer = new BitWriter();

    // TODO: add a secret_key binding, sign
    let toWrite = new BitStream(new Uint8Array(new Array<number>(payload.length, ...payload)), 0, false)

    var startOffset = offset;

    function decodeHuffman(tree: Node): number {
      // TODO: implement cool STB prefix cache: https://github.com/nothings/stb/blob/master/stb_image.h#L1911
      var node: Node | number = tree, bit;
      while ((bit = bitStream.readBit()) !== null) {
        let ret = (bit == 0 ? node.left : node.right)
        if (typeof ret === 'number')
          return ret;
        node = ret as Node
      }
      return null;
    }
    function receiveAndExtend(length: number): { orig: number, value: number } {
      var value = bitStream.readBits(length);
      var n = value
      if (n >= 1 << (length - 1))
        return { orig: n, value: n };
      return { orig: n, value: n + (-1 << length) + 1 };
    }

    function decodeBaseline(component: Component, zz: Int32Array) {

      var t = decodeHuffman(component.huffmanTableDC);
      var diff: number
      if (t === 0) {
        diff = 0
      } else {
        var { value } = receiveAndExtend(t);
        diff = value

        // if (Math.random() < .01) {
        //   // do our weird magic here
        //   var lastTwo = writeBuffer[writeBuffer.length - 2] << 8 | writeBuffer[writeBuffer.length - 1];
        //   // just flip the sign
        //   var mask = bitMask << bitsRead
        //   lastTwo = lastTwo ^ mask
        //   writeBuffer[writeBuffer.length - 2] = (lastTwo >> 8) & 0xFF
        //   writeBuffer[writeBuffer.length - 1] = lastTwo & 0xFF
        // }
      }
      // zz[0] = (component.pred += diff);
      var k = 1;
      while (k < 64) {
        var rs = decodeHuffman(component.huffmanTableAC);
        var bitsToRead = rs & 15, zeroValuesBefore = rs >> 4;
        if (bitsToRead === 0) {
          if (zeroValuesBefore < 15)
            break;
          k += 16;
          continue;
        }
        k += zeroValuesBefore;
        // var z = dctZigZag[k];
        var { orig, value } = receiveAndExtend(bitsToRead);
        // zz[z] = value;
        k++;
      }

      if (k === 64) {
        // last chunk of an AC thing, put our values in here
        // in the sample jpg this has always been 1 bit? -1?
        if (recover && (recoverBytes == undefined || recoverBytes > 0)) {
          let written = recoverer.writeBits(orig, bitsToRead)
          if (recoverBytes == undefined) {
            if (written.length) {
              recoverBytes = written[0] - (written.length - 1)
              recoverer.buffer.shift()
            }
          } else {
            recoverBytes -= written.length
          }
        } else {
          if (toWrite.bitsLeft > 0) {
            // assume toWrite[0:1] is XXXXXXXX XXXXXXXX, last component is 12 bits,
            // and we've already written 6 bits of our data
            bitsToRead = Math.min(toWrite.bitsLeft, bitsToRead)
            let writeBits = toWrite.readBits(bitsToRead) // 0000XXXX XXXXXXXX
            let writeMask = (1 << bitsToRead) - 1 // 00001111 11111111

            // our write buffer has the previous bits (A), the bits we want to replace (B),
            // and maybe some of the next chunk (C)
            // AAAAAABB BBBBBBBB BBCCCCCC

            // ok, how many bits have we read into the last byte?
            writeBits = writeBits << (bitStream.bitsCount) // 000000XX XXXXXXXX XX000000
            writeMask = writeMask << (bitStream.bitsCount) // 00000011 11111111 11000000
            let lastThreeWritten = (
              bitStream.writeBuffer[bitStream.writeBuffer.length - 3] << 16
              | bitStream.writeBuffer[bitStream.writeBuffer.length - 2] << 8
              | bitStream.writeBuffer[bitStream.writeBuffer.length - 1]
            ) // AAAAAABB BBBBBBBB BBCCCCCC
            let newLastThree = lastThreeWritten & (writeMask ^ 0xFFFFFF) // AAAAAA00 00000000 00CCCCCC
            newLastThree = newLastThree | writeBits // AAAAAAXX XXXXXXXX XXCCCCCC

            bitStream.writeBuffer[bitStream.writeBuffer.length - 3] = newLastThree >> 16
            bitStream.writeBuffer[bitStream.writeBuffer.length - 2] = (newLastThree >> 8) & 0xFF
            bitStream.writeBuffer[bitStream.writeBuffer.length - 1] = newLastThree & 0xFF
          }
        }
      } else {
      }
    }

    function decodeDCFirst(component: Component, zz: Int32Array) {
      var t = decodeHuffman(component.huffmanTableDC);

      var diff: number
      if (t === 0) {
        diff = 0
      } else {
        var { value } = receiveAndExtend(t);
        diff = value << successive
      }
      zz[0] = (component.pred += diff);
    }
    function decodeDCSuccessive(component: Component, zz: Int32Array) {
      zz[0] |= bitStream.readBit() << successive;
    }
    var eobrun = 0;
    function decodeACFirst(component: Component, zz: Int32Array) {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      var k = spectralStart, e = spectralEnd;
      while (k <= e) {
        var rs = decodeHuffman(component.huffmanTableAC);
        var s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            var value = bitStream.readBits(r)
            eobrun = value + (1 << r) - 1;
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        var { value } = receiveAndExtend(s)
        zz[z] = value * (1 << successive);
        k++;
      }
    }
    var successiveACState = 0, successiveACNextValue: number;
    function decodeACSuccessive(component: Component, zz: Int32Array) {
      var k = spectralStart, e = spectralEnd, r = 0;
      while (k <= e) {
        var z = dctZigZag[k];
        var direction = zz[z] < 0 ? -1 : 1;
        switch (successiveACState) {
          case 0: // initial state
            var rs = decodeHuffman(component.huffmanTableAC);
            var s = rs & 15, r = rs >> 4;
            if (s === 0) {
              if (r < 15) {
                var value = bitStream.readBits(r)
                eobrun = value + (1 << r);
                successiveACState = 4;
              } else {
                r = 16;
                successiveACState = 1;
              }
            } else {
              if (s !== 1)
                throw new Error("invalid ACn encoding");
              var { value } = receiveAndExtend(s);
              successiveACNextValue = value;
              successiveACState = r ? 2 : 3;
            }
            continue;
          case 1: // skipping r zero items
          case 2:
            if (zz[z])
              zz[z] += (bitStream.readBit() << successive) * direction;
            else {
              r--;
              if (r === 0)
                successiveACState = successiveACState == 2 ? 3 : 0;
            }
            break;
          case 3: // set value for a zero item
            if (zz[z])
              zz[z] += (bitStream.readBit() << successive) * direction;
            else {
              zz[z] = successiveACNextValue << successive;
              successiveACState = 0;
            }
            break;
          case 4: // eob
            if (zz[z])
              zz[z] += (bitStream.readBit() << successive) * direction;
            break;
        }
        k++;
      }
      if (successiveACState === 4) {
        eobrun--;
        if (eobrun === 0)
          successiveACState = 0;
      }
    }
    function decodeMcu(component: Component, decode: DecodeFunction, mcu: number, row: number, col: number) {
      var mcuRow = (mcu / mcusPerLine) | 0;
      var mcuCol = mcu % mcusPerLine;
      var blockRow = mcuRow * component.v + row;
      var blockCol = mcuCol * component.h + col;
      decode(component, component.blocks[blockRow][blockCol]);
    }
    function decodeBlock(component: Component, decode: DecodeFunction, mcu: number) {
      var blockRow = (mcu / component.blocksPerLine) | 0;
      var blockCol = mcu % component.blocksPerLine;
      decode(component, component.blocks[blockRow][blockCol]);
    }

    var componentsLength = components.length;
    var component: Component, i, j, k, n;
    var decodeFn: DecodeFunction;
    if (progressive) {
      if (spectralStart === 0)
        decodeFn = successivePrev === 0 ? decodeDCFirst : decodeDCSuccessive;
      else
        decodeFn = successivePrev === 0 ? decodeACFirst : decodeACSuccessive;
    } else {
      decodeFn = decodeBaseline;
    }

    var mcu = 0, marker;
    var mcuExpected;
    if (componentsLength == 1) {
      mcuExpected = components[0].blocksPerLine * components[0].blocksPerColumn;
    } else {
      mcuExpected = mcusPerLine * frame.mcusPerColumn;
    }
    if (!resetInterval) resetInterval = mcuExpected;

    var h, v;
    while (mcu < mcuExpected) {
      // reset interval stuff
      for (i = 0; i < componentsLength; i++)
        components[i].pred = 0;
      eobrun = 0;

      if (componentsLength == 1) {
        component = components[0];
        for (n = 0; n < resetInterval; n++) {
          decodeBlock(component, decodeFn, mcu);
          mcu++;
        }
      } else {
        for (n = 0; n < resetInterval; n++) {
          for (i = 0; i < componentsLength; i++) {
            component = components[i];
            h = component.h;
            v = component.v;
            for (j = 0; j < v; j++) {
              for (k = 0; k < h; k++) {
                decodeMcu(component, decodeFn, mcu, j, k);
              }
            }
          }
          mcu++;

          // If we've reached our expected MCU's, stop decoding
          if (mcu === mcuExpected) break;
        }
      }

      // find marker
      // bitsCount = 0;
      marker = (data[bitStream.offset] << 8 | data[bitStream.offset + 1]);
      if (marker < 0xFF00) {
        throw new Error("marker was not found");
      }

      if (marker <= 0xFFD0 || marker >= 0xFFD7) // RSTx
        break;
    }

    if (!recover)
      await writer.write(new Uint8Array(bitStream.writeBuffer));
    else {
      try {
        let addr = fromByteArray(recoverer.buffer)
        await writer.write(new TextEncoder().encode(addr.toString()));
      } catch {
        await writer.write(new Uint8Array(recoverer.buffer))
      }
    }

    return bitStream.offset - startOffset;
  }

  function buildComponentData(frame: JPEGFrame, component: Component) {
    var lines = [];
    var blocksPerLine = component.blocksPerLine;
    var blocksPerColumn = component.blocksPerColumn;
    var samplesPerLine = blocksPerLine << 3;
    var R = new Int32Array(64), r = new Uint8Array(64);

    // A port of poppler's IDCT method which in turn is taken from:
    //   Christoph Loeffler, Adriaan Ligtenberg, George S. Moschytz,
    //   "Practical Fast 1-D DCT Algorithms with 11 Multiplications",
    //   IEEE Intl. Conf. on Acoustics, Speech & Signal Processing, 1989,
    //   988-991.
    function quantizeAndInverse(zz: Int32Array, dataOut: Uint8Array, dataIn: Int32Array) {
      var qt = component.quantizationTable;
      var v0, v1, v2, v3, v4, v5, v6, v7, t;
      var p = dataIn;
      var i;

      // dequant
      for (i = 0; i < 64; i++)
        p[i] = zz[i] * qt[i];

      // inverse DCT on rows
      for (i = 0; i < 8; ++i) {
        var row = 8 * i;

        // check for all-zero AC coefficients
        if (p[1 + row] == 0 && p[2 + row] == 0 && p[3 + row] == 0 &&
          p[4 + row] == 0 && p[5 + row] == 0 && p[6 + row] == 0 &&
          p[7 + row] == 0) {
          t = (dctSqrt2 * p[0 + row] + 512) >> 10;
          p[0 + row] = t;
          p[1 + row] = t;
          p[2 + row] = t;
          p[3 + row] = t;
          p[4 + row] = t;
          p[5 + row] = t;
          p[6 + row] = t;
          p[7 + row] = t;
          continue;
        }

        // stage 4
        v0 = (dctSqrt2 * p[0 + row] + 128) >> 8;
        v1 = (dctSqrt2 * p[4 + row] + 128) >> 8;
        v2 = p[2 + row];
        v3 = p[6 + row];
        v4 = (dctSqrt1d2 * (p[1 + row] - p[7 + row]) + 128) >> 8;
        v7 = (dctSqrt1d2 * (p[1 + row] + p[7 + row]) + 128) >> 8;
        v5 = p[3 + row] << 4;
        v6 = p[5 + row] << 4;

        // stage 3
        t = (v0 - v1 + 1) >> 1;
        v0 = (v0 + v1 + 1) >> 1;
        v1 = t;
        t = (v2 * dctSin6 + v3 * dctCos6 + 128) >> 8;
        v2 = (v2 * dctCos6 - v3 * dctSin6 + 128) >> 8;
        v3 = t;
        t = (v4 - v6 + 1) >> 1;
        v4 = (v4 + v6 + 1) >> 1;
        v6 = t;
        t = (v7 + v5 + 1) >> 1;
        v5 = (v7 - v5 + 1) >> 1;
        v7 = t;

        // stage 2
        t = (v0 - v3 + 1) >> 1;
        v0 = (v0 + v3 + 1) >> 1;
        v3 = t;
        t = (v1 - v2 + 1) >> 1;
        v1 = (v1 + v2 + 1) >> 1;
        v2 = t;
        t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
        v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
        v7 = t;
        t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
        v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
        v6 = t;

        // stage 1
        p[0 + row] = v0 + v7;
        p[7 + row] = v0 - v7;
        p[1 + row] = v1 + v6;
        p[6 + row] = v1 - v6;
        p[2 + row] = v2 + v5;
        p[5 + row] = v2 - v5;
        p[3 + row] = v3 + v4;
        p[4 + row] = v3 - v4;
      }

      // inverse DCT on columns
      for (i = 0; i < 8; ++i) {
        var col = i;

        // check for all-zero AC coefficients
        if (p[1 * 8 + col] == 0 && p[2 * 8 + col] == 0 && p[3 * 8 + col] == 0 &&
          p[4 * 8 + col] == 0 && p[5 * 8 + col] == 0 && p[6 * 8 + col] == 0 &&
          p[7 * 8 + col] == 0) {
          t = (dctSqrt2 * dataIn[i + 0] + 8192) >> 14;
          p[0 * 8 + col] = t;
          p[1 * 8 + col] = t;
          p[2 * 8 + col] = t;
          p[3 * 8 + col] = t;
          p[4 * 8 + col] = t;
          p[5 * 8 + col] = t;
          p[6 * 8 + col] = t;
          p[7 * 8 + col] = t;
          continue;
        }

        // stage 4
        v0 = (dctSqrt2 * p[0 * 8 + col] + 2048) >> 12;
        v1 = (dctSqrt2 * p[4 * 8 + col] + 2048) >> 12;
        v2 = p[2 * 8 + col];
        v3 = p[6 * 8 + col];
        v4 = (dctSqrt1d2 * (p[1 * 8 + col] - p[7 * 8 + col]) + 2048) >> 12;
        v7 = (dctSqrt1d2 * (p[1 * 8 + col] + p[7 * 8 + col]) + 2048) >> 12;
        v5 = p[3 * 8 + col];
        v6 = p[5 * 8 + col];

        // stage 3
        t = (v0 - v1 + 1) >> 1;
        v0 = (v0 + v1 + 1) >> 1;
        v1 = t;
        t = (v2 * dctSin6 + v3 * dctCos6 + 2048) >> 12;
        v2 = (v2 * dctCos6 - v3 * dctSin6 + 2048) >> 12;
        v3 = t;
        t = (v4 - v6 + 1) >> 1;
        v4 = (v4 + v6 + 1) >> 1;
        v6 = t;
        t = (v7 + v5 + 1) >> 1;
        v5 = (v7 - v5 + 1) >> 1;
        v7 = t;

        // stage 2
        t = (v0 - v3 + 1) >> 1;
        v0 = (v0 + v3 + 1) >> 1;
        v3 = t;
        t = (v1 - v2 + 1) >> 1;
        v1 = (v1 + v2 + 1) >> 1;
        v2 = t;
        t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
        v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
        v7 = t;
        t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
        v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
        v6 = t;

        // stage 1
        p[0 * 8 + col] = v0 + v7;
        p[7 * 8 + col] = v0 - v7;
        p[1 * 8 + col] = v1 + v6;
        p[6 * 8 + col] = v1 - v6;
        p[2 * 8 + col] = v2 + v5;
        p[5 * 8 + col] = v2 - v5;
        p[3 * 8 + col] = v3 + v4;
        p[4 * 8 + col] = v3 - v4;
      }

      // convert to 8-bit integers
      for (i = 0; i < 64; ++i) {
        var sample = 128 + ((p[i] + 8) >> 4);
        dataOut[i] = sample < 0 ? 0 : sample > 0xFF ? 0xFF : sample;
      }
    }

    var i, j;
    for (var blockRow = 0; blockRow < blocksPerColumn; blockRow++) {
      var scanLine = blockRow << 3;
      for (i = 0; i < 8; i++)
        lines.push(new Uint8Array(samplesPerLine));
      for (var blockCol = 0; blockCol < blocksPerLine; blockCol++) {
        quantizeAndInverse(component.blocks[blockRow][blockCol], r, R);

        var offset = 0, sample = blockCol << 3;
        for (j = 0; j < 8; j++) {
          var line = lines[scanLine + j];
          for (i = 0; i < 8; i++)
            line[sample + i] = r[offset++];
        }
      }
    }
    return lines;
  }

  function clampTo8bit(a: number) {
    return a < 0 ? 0 : a > 255 ? 255 : a;
  }

  async function parse(data: Uint8Array) {
    var offset = 0;
    async function writeByte(value: number) {
      if (!recover)
        await writer.write(new Uint8Array([value]))
    }
    async function writeWord(value: number) {
      if (!recover)
        await writer.write(new Uint8Array([((value >> 8) & 0xFF), ((value) & 0xFF)]))
    }

    // these read functions are only used outside of the scan functions, so we can just write
    // immediately after the read
    async function readUint8(): Promise<number> {
      const value = data[offset++]
      await writeByte(value)
      return value
    }
    async function readUint16(): Promise<number> {
      var value = (data[offset++] << 8) | data[offset++];
      await writeWord(value)
      return value;
    }
    async function readDataBlock(): Promise<Uint8Array> {
      var length = await readUint16();
      var array = data.slice(offset, offset + length - 2);
      offset += array.length;
      if (!recover)
        await writer.write(array)
      return array;
    }

    function prepareComponents(frame: JPEGFrame) {
      var maxH = 0, maxV = 0;
      var component: Component, componentId;
      for (componentId in frame.components) {
        if (frame.components.hasOwnProperty(componentId)) {
          component = frame.components[componentId];
          if (maxH < component.h) maxH = component.h;
          if (maxV < component.v) maxV = component.v;
        }
      }
      var mcusPerLine = Math.ceil(frame.samplesPerLine / 8 / maxH);
      var mcusPerColumn = Math.ceil(frame.scanLines / 8 / maxV);
      for (componentId in frame.components) {
        if (frame.components.hasOwnProperty(componentId)) {
          component = frame.components[componentId];
          var blocksPerLine = Math.ceil(Math.ceil(frame.samplesPerLine / 8) * component.h / maxH);
          var blocksPerColumn = Math.ceil(Math.ceil(frame.scanLines / 8) * component.v / maxV);
          var blocksPerLineForMcu = mcusPerLine * component.h;
          var blocksPerColumnForMcu = mcusPerColumn * component.v;
          var blocks: Int32Array[][] = [];
          for (var i = 0; i < blocksPerColumnForMcu; i++) {
            var row = [];
            for (var j = 0; j < blocksPerLineForMcu; j++)
              row.push(new Int32Array(64));
            blocks.push(row);
          }
          component.blocksPerLine = blocksPerLine;
          component.blocksPerColumn = blocksPerColumn;
          component.blocks = blocks;
        }
      }
      frame.maxH = maxH;
      frame.maxV = maxV;
      frame.mcusPerLine = mcusPerLine;
      frame.mcusPerColumn = mcusPerColumn;
    }
    var jfif = null;
    var adobe = null;
    var frame, resetInterval;
    var quantizationTables: Int32Array[] = [], frames = [];
    var huffmanTablesAC: Node[] = [], huffmanTablesDC: Node[] = [];
    var fileMarker = await readUint16();
    console.log(fileMarker.toString(16))
    if (fileMarker != 0xFFD8) { // SOI (Start of Image)
      throw new Error("SOI not found");
    }

    fileMarker = await readUint16();
    console.log(fileMarker.toString(16))
    while (fileMarker != 0xFFD9) { // EOI (End of image)
      console.log(fileMarker.toString(16))
      var i, j;
      switch (fileMarker) {
        case 0xFF00: break;
        case 0xFFE0: // APP0 (Application Specific)
        case 0xFFE1: // APP1
        case 0xFFE2: // APP2
        case 0xFFE3: // APP3
        case 0xFFE4: // APP4
        case 0xFFE5: // APP5
        case 0xFFE6: // APP6
        case 0xFFE7: // APP7
        case 0xFFE8: // APP8
        case 0xFFE9: // APP9
        case 0xFFEA: // APP10
        case 0xFFEB: // APP11
        case 0xFFEC: // APP12
        case 0xFFED: // APP13
        case 0xFFEE: // APP14
        case 0xFFEF: // APP15
        case 0xFFFE: // COM (Comment)
          var appData = await readDataBlock();

          if (fileMarker === 0xFFE0) {
            if (appData[0] === 0x4A && appData[1] === 0x46 && appData[2] === 0x49 &&
              appData[3] === 0x46 && appData[4] === 0) { // 'JFIF\x00'
              jfif = {
                version: { major: appData[5], minor: appData[6] },
                densityUnits: appData[7],
                xDensity: (appData[8] << 8) | appData[9],
                yDensity: (appData[10] << 8) | appData[11],
                thumbWidth: appData[12],
                thumbHeight: appData[13],
                thumbData: appData.slice(14, 14 + 3 * appData[12] * appData[13])
              };
            }
          }
          // TODO APP1 - Exif
          if (fileMarker === 0xFFEE) {
            if (appData[0] === 0x41 && appData[1] === 0x64 && appData[2] === 0x6F &&
              appData[3] === 0x62 && appData[4] === 0x65 && appData[5] === 0) { // 'Adobe\x00'
              adobe = {
                version: appData[6],
                flags0: (appData[7] << 8) | appData[8],
                flags1: (appData[9] << 8) | appData[10],
                transformCode: appData[11]
              };
            }
          }
          break;

        case 0xFFDB: // DQT (Define Quantization Tables)
          var quantizationTablesLength = await readUint16();
          var quantizationTablesEnd = quantizationTablesLength + offset - 2;
          while (offset < quantizationTablesEnd) {
            var quantizationTableSpec = await readUint8();
            var tableData = new Int32Array(64);
            if ((quantizationTableSpec >> 4) === 0) { // 8 bit values
              for (j = 0; j < 64; j++) {
                var z = dctZigZag[j];
                tableData[z] = await readUint8();
              }
            } else if ((quantizationTableSpec >> 4) === 1) { //16 bit
              for (j = 0; j < 64; j++) {
                var z = dctZigZag[j];
                tableData[z] = await readUint16();
              }
            } else
              throw new Error("DQT: invalid table spec");
            quantizationTables[quantizationTableSpec & 15] = tableData;
          }
          break;

        case 0xFFC0: // SOF0 (Start of Frame, Baseline DCT)
        case 0xFFC1: // SOF1 (Start of Frame, Extended DCT)
        case 0xFFC2: // SOF2 (Start of Frame, Progressive DCT)
          await readUint16(); // skip data length
          frame = new JPEGFrame(fileMarker, await readUint8(), await readUint16(), await readUint16())
          var componentsCount = await readUint8(), componentId: number;
          for (i = 0; i < componentsCount; i++) {
            componentId = await readUint8();
            var hv = await readUint8();
            var h = hv >> 4;
            var v = hv & 15;
            var qId = await readUint8();
            frame.componentsOrder.push(componentId);
            frame.components[componentId] = new Component(h, v, qId);
          }
          prepareComponents(frame);
          frames.push(frame);
          break;

        case 0xFFC4: // DHT (Define Huffman Tables)
          var huffmanLength = await readUint16();
          for (i = 2; i < huffmanLength;) {
            var huffmanTableSpec = await readUint8();
            var codeLengths = new Uint8Array(16);
            var codeLengthSum = 0;
            for (j = 0; j < 16; j++)
              codeLengthSum += (codeLengths[j] = await readUint8());
            var huffmanValues = new Uint8Array(codeLengthSum);
            for (j = 0; j < codeLengthSum; j++)
              huffmanValues[j] = await readUint8()
            i += 17 + codeLengthSum;

            const isDC = (huffmanTableSpec >> 4) === 0;
            const huffmanIndex = huffmanTableSpec & 15;
            const table = buildHuffmanTable(codeLengths, huffmanValues, isDC, huffmanIndex);
            (isDC ? huffmanTablesDC : huffmanTablesAC)[huffmanIndex] = table;
          }
          break;

        case 0xFFDD: // DRI (Define Restart Interval)
          await readUint16(); // skip data length
          resetInterval = await readUint16();
          break;

        case 0xFFDA: // SOS (Start of Scan)
          var scanLength = await readUint16();
          var selectorsCount = await readUint8();
          var components = [], component;
          for (i = 0; i < selectorsCount; i++) {
            component = frame.components[await readUint8()];
            var tableSpec = await readUint8();
            component.huffmanTableDC = huffmanTablesDC[tableSpec >> 4];
            component.DCIndex = tableSpec >> 15
            component.huffmanTableAC = huffmanTablesAC[tableSpec & 15];
            component.ACIndex = tableSpec & 15
            components.push(component);
          }
          var spectralStart = await readUint8();
          var spectralEnd = await readUint8();
          var successiveApproximation = await readUint8();
          var processed = await decodeScan(data, offset,
            frame, components, resetInterval,
            spectralStart, spectralEnd,
            successiveApproximation >> 4, successiveApproximation & 15);
          offset += processed;
          break;

        case 0xFFFF: // Fill bytes
          // TODO: do we write here?? unwrite?? sup with this
          if (data[offset] !== 0xFF) { // Avoid skipping a valid marker.
            offset--;
          }
          break;

        default:
          if (data[offset - 3] == 0xFF &&
            data[offset - 2] >= 0xC0 && data[offset - 2] <= 0xFE) {
            // could be incorrect encoding -- last 0xFF byte of the previous
            // block was eaten by the encoder
            offset -= 3;
            break;
          }
          throw new Error("unknown JPEG marker " + hexb(fileMarker & 0xFF));
      }
      fileMarker = await readUint16();
    }
    if (frames.length != 1)
      throw new Error("only single frame JPEGs supported");

    return
  }

  try {
    await parse(data);
  } catch (e) {
    writer.write(new TextEncoder().encode(e.toString()))
  }
  await writer.close();
}

function hexb(n: number): string { return '0x' + (n < 0x10 ? '0' : '') + n.toString(16) }

type DecodeFunction = (component: Component, zz: Int32Array) => void

class JPEGFrame {
  extended: boolean
  progressive: boolean
  precision: number
  scanLines: number
  samplesPerLine: number
  maxH: number
  maxV: number
  mcusPerLine: number
  mcusPerColumn: number
  components: { [key: number]: Component }
  componentsOrder: number[]

  constructor(fileMarker: number, precision: number, scanLines: number, samplesPerLine: number) {
    this.extended = (fileMarker === 0xFFC1)
    this.progressive = (fileMarker === 0xFFC2)
    this.precision = precision
    this.scanLines = scanLines
    this.samplesPerLine = samplesPerLine
    this.components = {}
    this.componentsOrder = []
  }
}

interface Node {
  left: number | Node
  right: number | Node
  index: number
}

class Component {
  h: number
  v: number
  quantizationIdx: number
  pred: number
  blocksPerLine: number
  blocksPerColumn: number
  blocks: Int32Array[][]
  huffmanTableDC: Node
  DCIndex: number
  huffmanTableAC: Node
  ACIndex: number
  quantizationTable: Int32Array

  constructor(h: number, v: number, qId: number) {
    this.h = h
    this.v = v
    this.quantizationIdx = qId
  }
}
