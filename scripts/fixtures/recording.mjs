// Opt-in recordings of a smoke suite's live behaviour for review (VARIA_SMOKE_RECORD=1; docs/testing.md › Smoke hooks): screenshots of a
// region taken while the suite runs, written as one animated PNG, which browsers play without a codec. Playwright's recordVideo needs its
// own ffmpeg download, so this uses only the page's screenshots and Node's zlib. CI never records.
import { writeFile } from 'node:fs/promises'
import { crc32 } from 'node:zlib'

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A PNG's chunks, in order. */
function chunks(png) {
  const list = []
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8)
    list.push({ type, data: png.subarray(at + 8, at + 8 + length) })
    at += 12 + length
  }
  return list
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** Frames of one size (PNG buffers, each with how long it shows in ms) as an animated PNG that loops. */
export function animatedPng(frames) {
  const first = chunks(frames[0].png), header = first.find(item => item.type === 'IHDR').data
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4)
  const out = [signature, chunk('IHDR', header)]
  const control = Buffer.alloc(8)
  control.writeUInt32BE(frames.length, 0)
  out.push(chunk('acTL', control))
  let sequence = 0
  frames.forEach((frame, index) => {
    const own = chunks(frame.png), size = own.find(item => item.type === 'IHDR').data
    if (size.readUInt32BE(0) !== width || size.readUInt32BE(4) !== height) throw new Error('Every frame of a recording needs the same size.')
    const fctl = Buffer.alloc(26)
    fctl.writeUInt32BE(sequence++, 0); fctl.writeUInt32BE(width, 4); fctl.writeUInt32BE(height, 8)
    fctl.writeUInt16BE(Math.max(1, Math.min(65535, Math.round(frame.ms))), 20); fctl.writeUInt16BE(1000, 22)
    out.push(chunk('fcTL', fctl))
    for (const data of own.filter(item => item.type === 'IDAT').map(item => item.data)) {
      if (index === 0) { out.push(chunk('IDAT', data)); continue }
      const numbered = Buffer.alloc(4)
      numbered.writeUInt32BE(sequence++, 0)
      out.push(chunk('fdAT', Buffer.concat([numbered, data])))
    }
  })
  out.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(out)
}

/**
 * Records `page` while the suite runs when VARIA_SMOKE_RECORD=1: a screenshot about every `everyMs`, clipped to the window's size at the
 * start. `stop(path)` writes the animated PNG and says where; without the variable both are no-ops.
 */
export function recordPage(page, { everyMs = 500 } = {}) {
  if (process.env.VARIA_SMOKE_RECORD !== '1') return { stop: async () => undefined }
  const frames = []
  let running = true
  const loop = (async () => {
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    while (running) {
      const begun = Date.now()
      const png = await page.screenshot({ clip: { x: 0, y: 0, ...size } }).catch(() => undefined)
      if (png) frames.push({ png, at: begun })
      const rest = everyMs - (Date.now() - begun)
      // A recording paces its own frames: it is not a wait on the app, and it runs only when asked for.
      if (rest > 0 && running) await new Promise(resolve => setTimeout(resolve, rest))
    }
  })()
  return {
    async stop(path) {
      running = false
      await loop
      if (!frames.length) return undefined
      const timed = frames.map((frame, index) => ({ png: frame.png, ms: index + 1 < frames.length ? frames[index + 1].at - frame.at : 1500 }))
      await writeFile(path, animatedPng(timed))
      return path
    }
  }
}
