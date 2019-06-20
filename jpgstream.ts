import { IndexableStream } from "./indexable-stream.js";

export async function modifyJPGStream(readable: ReadableStream, writable: WritableStream) {
  const reader = readable.getReader();
  const writer = writable.getWriter();

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

  async function decodeScan(data: IndexableStream, offset: number,
    frame: JPEGFrame, components: Component[], resetInterval: number,
    spectralStart: number, spectralEnd: number,
    successivePrev: number, successive: number) {
    var mcusPerLine = frame.mcusPerLine;
    var progressive = frame.progressive;

    const buffer = new Array<number>();

    var startOffset = offset, bitsData = 0, bitsCount = 0;
    var writeOffset = 0;

    function writeByte(value: number) {
      buffer[writeOffset++] = value
      //await writer.write(new Uint8Array([value]))
    }
    async function writeWord(value: number) {
      await writeByte(((value >> 8) & 0xFF))
      await writeByte(value & 0xFF)
    }
    async function readUint8(): Promise<number> {
      const value = await data.getIndex(offset++)
      writeByte(value)
      return value
    }
    async function readUint16(): Promise<number> {
      var value = (await data.getIndex(offset) << 8) | await data.getIndex(offset + 1);
      offset += 2;
      await writeWord(value)
      return value;
    }
    async function readBit() {
      if (bitsCount > 0) {
        bitsCount--;
        return (bitsData >> bitsCount) & 1;
      }
      bitsData = await readUint8();
      if (bitsData == 0xFF) {
        var nextByte = await readUint8();
        if (nextByte) {
          throw new Error("unexpected marker: " + ((bitsData << 8) | nextByte).toString(16));
        }
        // unstuff 0
      }
      bitsCount = 7;
      return bitsData >>> 7;
    }
    async function decodeHuffman(tree: Node): Promise<number> {
      var node: Node | number = tree, bit;
      while ((bit = await readBit()) !== null) {
        let ret = (bit == 0 ? node.left : node.right)
        if (typeof ret === 'number')
          return ret;
        node = ret as Node
      }
      return null;
    }
    async function receive(length: number): Promise<{ bitsRead: number, value: number }> {
      var bitsRead = 0;
      var n = 0;
      while (length > 0) {
        var bit = await readBit();
        bitsRead++;
        if (bit === null) return;
        n = (n << 1) | bit;
        length--;
      }
      return { bitsRead, value: n };
    }
    async function receiveAndExtend(length: number): Promise<{ bitsRead: number, value: number }> {
      var { bitsRead, value } = await receive(length);
      var n = value
      if (n >= 1 << (length - 1))
        return { bitsRead, value: n };
      return { bitsRead, value: n + (-1 << length) + 1 };
    }
    async function decodeBaseline(component: Component, zz: Int32Array) {
      var t = await decodeHuffman(component.huffmanTableDC);

      var diff: number
      if (t === 0) {
        diff = 0
      } else {
        var { bitsRead, value } = await receiveAndExtend(t);
        diff = value

        // if (false) {
        if (Math.random() < .01) {
          console.log('magic')
          // do our weird magic here
          var lastTwo = buffer[buffer.length - 2] << 8 | buffer[buffer.length - 1];
          // just flip the sign
          var mask = 1 << (bitsRead + bitsCount + 2)
          lastTwo = lastTwo ^ mask
          buffer[buffer.length - 2] = (lastTwo >> 8) & 0xFF
          buffer[buffer.length - 1] = lastTwo & 0xFF
        }

        // var bitMask = ((1 << (bitsRead + 1)) - 1) << bitsCount;
        // bitMask = 0xFFFF ^ bitMask
        // lastTwo = lastTwo & bitMask
      }
      zz[0] = (component.pred += diff);
      var k = 1;
      while (k < 64) {
        var rs = await decodeHuffman(component.huffmanTableAC);
        var s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15)
            break;
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        var { value } = await receiveAndExtend(s);
        zz[z] = value;
        k++;
      }
    }

    async function decodeDCFirst(component: Component, zz: Int32Array) {
      var t = await decodeHuffman(component.huffmanTableDC);

      var diff: number
      if (t === 0) {
        diff = 0
      } else {
        var { bitsRead, value } = await receiveAndExtend(t);
        diff = value << successive
      }
      zz[0] = (component.pred += diff);
    }
    async function decodeDCSuccessive(component: Component, zz: Int32Array) {
      zz[0] |= await readBit() << successive;
    }
    var eobrun = 0;
    async function decodeACFirst(component: Component, zz: Int32Array) {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      var k = spectralStart, e = spectralEnd;
      while (k <= e) {
        var rs = await decodeHuffman(component.huffmanTableAC);
        var s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            var { value } = await receive(r)
            eobrun = value + (1 << r) - 1;
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        var { value } = await receiveAndExtend(s)
        zz[z] = value * (1 << successive);
        k++;
      }
    }
    var successiveACState = 0, successiveACNextValue: number;
    async function decodeACSuccessive(component: Component, zz: Int32Array) {
      var k = spectralStart, e = spectralEnd, r = 0;
      while (k <= e) {
        var z = dctZigZag[k];
        var direction = zz[z] < 0 ? -1 : 1;
        switch (successiveACState) {
          case 0: // initial state
            var rs = await decodeHuffman(component.huffmanTableAC);
            var s = rs & 15, r = rs >> 4;
            if (s === 0) {
              if (r < 15) {
                var { value } = await receive(r)
                eobrun = value + (1 << r);
                successiveACState = 4;
              } else {
                r = 16;
                successiveACState = 1;
              }
            } else {
              if (s !== 1)
                throw new Error("invalid ACn encoding");
              var { value } = await receiveAndExtend(s);
              successiveACNextValue = value;
              successiveACState = r ? 2 : 3;
            }
            continue;
          case 1: // skipping r zero items
          case 2:
            if (zz[z])
              zz[z] += (await readBit() << successive) * direction;
            else {
              r--;
              if (r === 0)
                successiveACState = successiveACState == 2 ? 3 : 0;
            }
            break;
          case 3: // set value for a zero item
            if (zz[z])
              zz[z] += (await readBit() << successive) * direction;
            else {
              zz[z] = successiveACNextValue << successive;
              successiveACState = 0;
            }
            break;
          case 4: // eob
            if (zz[z])
              zz[z] += (await readBit() << successive) * direction;
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
    async function decodeMcu(component: Component, decode: DecodeFunction, mcu: number, row: number, col: number) {
      var mcuRow = (mcu / mcusPerLine) | 0;
      var mcuCol = mcu % mcusPerLine;
      var blockRow = mcuRow * component.v + row;
      var blockCol = mcuCol * component.h + col;
      await decode(component, component.blocks[blockRow][blockCol]);
    }
    async function decodeBlock(component: Component, decode: DecodeFunction, mcu: number) {
      var blockRow = (mcu / component.blocksPerLine) | 0;
      var blockCol = mcu % component.blocksPerLine;
      await decode(component, component.blocks[blockRow][blockCol]);
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
          await decodeBlock(component, decodeFn, mcu);
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
                await decodeMcu(component, decodeFn, mcu, j, k);
              }
            }
          }
          mcu++;

          // If we've reached our expected MCU's, stop decoding
          if (mcu === mcuExpected) break;
        }
      }

      // find marker
      bitsCount = 0;
      marker = (await data.getIndex(offset) << 8 | await data.getIndex(offset + 1));
      if (marker < 0xFF00) {
        throw new Error("marker was not found");
      }

      if (marker <= 0xFFD0 || marker >= 0xFFD7) // RSTx
        break;
    }

    await writer.write(new Uint8Array(buffer));

    return offset - startOffset;
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

  async function parse(data: IndexableStream) {
    var offset = 0;
    async function writeByte(value: number) {
      await writer.write(new Uint8Array([value]))
    }
    async function writeWord(value: number) {
      await writer.write(new Uint8Array([((value >> 8) & 0xFF), ((value) & 0xFF)]))
    }

    // these read functions are only used outside of the scan functions, so we can just write
    // immediately after the read
    async function readUint8(): Promise<number> {
      const value = await data.getIndex(offset++)
      await writeByte(value)
      return value
    }
    async function readUint16(): Promise<number> {
      var value = (await data.getIndex(offset) << 8) | await data.getIndex(offset + 1);
      offset += 2;
      await writeWord(value)
      return value;
    }
    async function readDataBlock(): Promise<Uint8Array> {
      var length = await readUint16();
      var array = await data.slice(offset, offset + length - 2);
      offset += array.length;
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
    console.log('huh')
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
            component.huffmanTableAC = huffmanTablesAC[tableSpec & 15];
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
          if (await data.getIndex(offset) !== 0xFF) { // Avoid skipping a valid marker.
            offset--;
          }
          break;

        default:
          if (await data.getIndex(offset - 3) == 0xFF &&
            await data.getIndex(offset - 2) >= 0xC0 && await data.getIndex(offset - 2) <= 0xFE) {
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

    // set each frame's components quantization table
    for (let i = 0; i < frames.length; i++) {
      var cp = frames[i].components;
      for (let j in cp) {
        cp[j].quantizationTable = quantizationTables[cp[j].quantizationIdx];
        delete cp[j].quantizationIdx;
      }
    }

    this.width = frame.samplesPerLine;
    this.height = frame.scanLines;
    this.jfif = jfif;
    this.adobe = adobe;
    this.components = [];
    for (let i = 0; i < frame.componentsOrder.length; i++) {
      let component = frame.components[frame.componentsOrder[i]];
      this.components.push({
        lines: buildComponentData(frame, component),
        scaleX: component.h / frame.maxH,
        scaleY: component.v / frame.maxV
      });
    }
  }

  function getData(width: number, height: number) {
    var scaleX = this.width / width, scaleY = this.height / height;

    var component1, component2, component3, component4;
    var component1Line, component2Line, component3Line, component4Line;
    var x, y;
    var offset = 0;
    var Y, Cb, Cr, K, C, M, Ye, R, G, B;
    var colorTransform;
    var dataLength = width * height * this.components.length;
    var data = new Uint8Array(dataLength);
    switch (this.components.length) {
      case 1:
        component1 = this.components[0];
        for (y = 0; y < height; y++) {
          component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
          for (x = 0; x < width; x++) {
            Y = component1Line[0 | (x * component1.scaleX * scaleX)];

            data[offset++] = Y;
          }
        }
        break;
      case 2:
        // PDF might compress two component data in custom colorspace
        component1 = this.components[0];
        component2 = this.components[1];
        for (y = 0; y < height; y++) {
          component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
          component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
          for (x = 0; x < width; x++) {
            Y = component1Line[0 | (x * component1.scaleX * scaleX)];
            data[offset++] = Y;
            Y = component2Line[0 | (x * component2.scaleX * scaleX)];
            data[offset++] = Y;
          }
        }
        break;
      case 3:
        // The default transform for three components is true
        colorTransform = true;
        // The adobe transform marker overrides any previous setting
        if (this.adobe && this.adobe.transformCode)
          colorTransform = true;
        else if (typeof this.colorTransform !== 'undefined')
          colorTransform = !!this.colorTransform;

        component1 = this.components[0];
        component2 = this.components[1];
        component3 = this.components[2];
        for (y = 0; y < height; y++) {
          component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
          component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
          component3Line = component3.lines[0 | (y * component3.scaleY * scaleY)];
          for (x = 0; x < width; x++) {
            if (!colorTransform) {
              R = component1Line[0 | (x * component1.scaleX * scaleX)];
              G = component2Line[0 | (x * component2.scaleX * scaleX)];
              B = component3Line[0 | (x * component3.scaleX * scaleX)];
            } else {
              Y = component1Line[0 | (x * component1.scaleX * scaleX)];
              Cb = component2Line[0 | (x * component2.scaleX * scaleX)];
              Cr = component3Line[0 | (x * component3.scaleX * scaleX)];

              R = clampTo8bit(Y + 1.402 * (Cr - 128));
              G = clampTo8bit(Y - 0.3441363 * (Cb - 128) - 0.71413636 * (Cr - 128));
              B = clampTo8bit(Y + 1.772 * (Cb - 128));
            }

            data[offset++] = R;
            data[offset++] = G;
            data[offset++] = B;
          }
        }
        break;
      case 4:
        if (!this.adobe)
          throw new Error('Unsupported color mode (4 components)');
        // The default transform for four components is false
        colorTransform = false;
        // The adobe transform marker overrides any previous setting
        if (this.adobe && this.adobe.transformCode)
          colorTransform = true;
        else if (typeof this.colorTransform !== 'undefined')
          colorTransform = !!this.colorTransform;

        component1 = this.components[0];
        component2 = this.components[1];
        component3 = this.components[2];
        component4 = this.components[3];
        for (y = 0; y < height; y++) {
          component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
          component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
          component3Line = component3.lines[0 | (y * component3.scaleY * scaleY)];
          component4Line = component4.lines[0 | (y * component4.scaleY * scaleY)];
          for (x = 0; x < width; x++) {
            if (!colorTransform) {
              C = component1Line[0 | (x * component1.scaleX * scaleX)];
              M = component2Line[0 | (x * component2.scaleX * scaleX)];
              Ye = component3Line[0 | (x * component3.scaleX * scaleX)];
              K = component4Line[0 | (x * component4.scaleX * scaleX)];
            } else {
              Y = component1Line[0 | (x * component1.scaleX * scaleX)];
              Cb = component2Line[0 | (x * component2.scaleX * scaleX)];
              Cr = component3Line[0 | (x * component3.scaleX * scaleX)];
              K = component4Line[0 | (x * component4.scaleX * scaleX)];

              C = 255 - clampTo8bit(Y + 1.402 * (Cr - 128));
              M = 255 - clampTo8bit(Y - 0.3441363 * (Cb - 128) - 0.71413636 * (Cr - 128));
              Ye = 255 - clampTo8bit(Y + 1.772 * (Cb - 128));
            }
            data[offset++] = 255 - C;
            data[offset++] = 255 - M;
            data[offset++] = 255 - Ye;
            data[offset++] = 255 - K;
          }
        }
        break;
      default:
        throw new Error('Unsupported color mode');
    }
    return data;
  }

  const indexable = new IndexableStream(reader);
  try {
    await parse(indexable);
  } catch (e) {
    console.log(e)
  }
  await writer.close();
}
/*
      if (done) {
        console.log('done')
        await flushMarker.call(this, state, buffers)
        break
      }

      var j = 0
      for (var i = 0; i < value.length; i++) {
        var b = value[i]
        // console.log(hexb(b))
        if (state === 'data') {
          if (b === 0xff) {
            buffers.push(value.slice(j, i))
            state = await flushMarker.call(this, state, buffers)
            buffers = []
            j = i
            state = 'code'
          }
          pos++
          continue
        }
        if (pending > 0) {
          var n = Math.min(value.length - i, pending)
          buffers.push(value.slice(i, i + n))
          pending -= n
          if (pending === 0) {
            state = await flushMarker.call(this, state, buffers)
            if (state === 'data') j = i
            buffers = []
          }
          i += n - 1
          pos += n
          continue
        }
        console.log('state', state, 'pos', pos)
        console.log('writing', hexb(b))
        await writer.write(value.slice(i, i + 1))
        if (state === 'ff' && b !== 0xff) {
          throw new Error('expected 0xff, received: ' + hexb(b))
        } else if (state === 'ff') {
          state = 'code'
        } else if (state === 'code') {
          offset = 0
          if (b === 0x00) { // data
            state = 'data'
            j = i + 1
          } else if (b === 0xd8) { // SOI
            started = true
            state = 'ff'
          } else if (b === 0xe0) { // JF{IF,XX}-APP0
            state = 'app0'
          } else if (b === 0xda) { // SOS
            state = 'sos'
          } else if (b === 0xd9) { // EOI
            state = 'eoi'
          } else if (b === 0xe1) { // APP1
            state = 'app1'
          } else if (b === 0xe2) { // APP2
            state = 'app2'
          } else if (b === 0xdb) { // DQT
            state = 'dqt'
          } else if (b === 0xc4) { // DHT
            state = 'dht'
          } else if (b === 0xdd) { // DRI
            state = 'dri'
          } else if (b === 0xc0) { // SOF
            state = 'sof'
          } else if (b === 0xda) { // SOS
            state = 'sos'
          } else if (b === 0xfe) { // ???
            state = '0xfe'
          } else if (b === 0xee) { // ???
            state = '0xee'
          } else if (b === 0xed) { // ???
            state = '0xed'
          } else {
            throw new Error('unknown code: ' + hexb(b))
          }
        } else if (state === 'app0') {
          if (offset === 0) s1 = b
          else if (offset === 1) s2 = b
          else if (offset === 2 && b !== 0x4a) {
            throw new Error('in app0 expected 0x4a, received: ' + hexb(b))
          } else if (offset === 3 && b !== 0x46) {
            throw new Error('in app0 expected 0x46, received: ' + hexb(b))
          } else if (offset === 4 && b === 0x49) {
            state = 'jfif-app0'
            offset = -1
          } else if (offset === 4 && b === 0x58) {
            state = 'jfxx-app0'
            offset = -1
          } else if (offset >= 4) {
            throw new Error(
              'in app0 expected 0x49 or 0x58, received: ' + hexb(b))
          }
          offset++
        } else if (state === 'jfif-app0') {
          if (++offset === 2) {
            pending = s1 * 256 + s2 - 7
          }
        } else {
          if (offset === 0) s1 = b
          else if (offset === 1) s2 = b
          if (++offset === 2) {
            pending = s1 * 256 + s2 - 2
          }
        }
        pos++
      }
      if (state === 'data') {
        console.log('pushing buffer')
        buffers.push(value.slice(j, i))
      }
      if (pos > 2 && !started) {
        throw new Error('start of image not found')
      } else {
        continue
      }
    }

    console.log('closing')
    await writer.close()
  } catch (e) {
    console.log(e)
  }

  async function flushMarker(state, buffers) {
    var buf = buffers.length === 1 ? buffers[0] : Uint8Array.from(Array.prototype.concat(...buffers.map(a => Array.from(a))));
    const dv = new DataView(buf.buffer)
    console.log('flushing', state, buf.length, 'bytes')
    if (state === 'data') {
      // mess with it
      await writer.write(buf)
    } else {
      if (state !== 'sos') {
        await writer.write(buf)
      }
      if (state === 'jfif-app0') {
        var units = 'unknown'
        if (buf[2] === 0) units = 'aspect'
        else if (buf[2] === 1) units = 'pixels per inch'
        else if (buf[2] === 2) units = 'pixels per cm'
      } else if (state === 'jfxx-app0') {
        var thumb = {
          format: 'unknown',
          width: 0,
          height: 0,
          data: null
        }
        if (buf[0] === 0x10) {
          thumb.format = 'JPEG'
          thumb.data = buf.slice(1)
        } else if (buf[0] === 0x11) {
          thumb.format = 'PAL'
          thumb.width = buf[1]
          thumb.height = buf[2]
          thumb.palette = buf.slice(3, 3 + 768)
          thumb.data = buf.slice(3 + 768 + thumb.width * thumb.height)
        } else if (buf[0] === 0x12) {
          thumb.format = 'RGB'
          thumb.width = buf[1]
          thumb.height = buf[1]
          thumb.data = 3 * thumb.width * thumb.height
        }
      } else if (state === 'app1') {
      } else if (state === 'app2') {
      } else if (state === 'dqt') {
        var tables = []
        for (var i = 1; i < buf.length; i += 0x41) {
          if (buf[i - 1] !== dqtSeq++) {
            return this.emit('error', new Error('unexpected DQT byte at ' +
              (offset + i - 1) + ' (' + i + '): ' + buf[i - 1]))
          }
          tables.push(buf.slice(i, i + 0x40))
        }
      } else if (state === 'dht') {
      } else if (state === 'dri') {
      } else if (state === 'sos') {
        console.log(buf)
        return 'data'
      } else if (state === 'sof') {
        width = dv.getUint16(3)
        height = dv.getUint16(1)
      } else if (state === 'eoi') {
      }
      return 'ff'
    }
  }
}
*/

function hexb(n: number): string { return '0x' + (n < 0x10 ? '0' : '') + n.toString(16) }

type DecodeFunction = (component: Component, zz: Int32Array) => Promise<void>

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
  huffmanTableAC: Node
  quantizationTable: Int32Array

  constructor(h: number, v: number, qId: number) {
    this.h = h
    this.v = v
    this.quantizationIdx = qId
  }
}
