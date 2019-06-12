export async function modifyJPGStream(readable, writable) {
  let offset = 0
  let pending = 0
  let buffers = []
  let pos = 0
  let s1 = 0, s2 = 0
  let state = 'ff'
  let started = false
  let dqtSeq = 0
  let width = -1, height = -1

  const reader = readable.getReader();
  const writer = writable.getWriter();

  try {
    for (; ;) {
      const { done, value } = await reader.read();

      console.log(state, done, value)

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

function hexb(n) { return '0x' + (n < 0x10 ? '0' : '') + n.toString(16) }
