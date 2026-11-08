import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { refuseDownloads } from '../src/main/download-guard'

describe('download guard', () => {
  it('cancels every download in the session', () => {
    const session = new EventEmitter()
    refuseDownloads(session)
    for (let download = 0; download < 2; download++) {
      let prevented = false
      session.emit('will-download', { preventDefault: () => { prevented = true } }, {})
      expect(prevented).toBe(true)
    }
  })

  it('guards the default session once the app is ready, before the window opens', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const ready = main.indexOf('app.whenReady().then(async () => {'), guard = main.indexOf('refuseDownloads(session.defaultSession)')
    expect(guard).toBeGreaterThan(ready)
    expect(guard).toBeLessThan(main.indexOf('createWindow(', ready))
    expect(main.split('refuseDownloads(').length - 1).toBe(1)
  })
})
