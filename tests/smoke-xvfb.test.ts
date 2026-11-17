import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { underXvfb } from '../scripts/fixtures/xvfb.mjs'

// Linux CI's smoke launches sometimes ran no animation frames in the never-shown window ("animationFrame": "none within
// 2 s"), so Dockview never placed its panels and the editor stayed hidden for 30 s. Under xvfb the window is shown.
describe('smoke windows on a virtual display', () => {
  it('knows xvfb-run by the XAUTHORITY it sets, on Linux only', () => {
    expect(underXvfb({ XAUTHORITY: '/tmp/xvfb-run.A5KxQZ/Xauthority' }, 'linux')).toBe(true)
    expect(underXvfb({ XAUTHORITY: '/home/runner/work/_temp/xvfb-run.x1/Xauthority' }, 'linux')).toBe(true)
    expect(underXvfb({ XAUTHORITY: '/home/user/.Xauthority' }, 'linux')).toBe(false)
    expect(underXvfb({}, 'linux')).toBe(false)
    expect(underXvfb({ XAUTHORITY: '/tmp/xvfb-run.A5KxQZ/Xauthority' }, 'win32')).toBe(false)
  })
  it('has every launch ask for a shown window under xvfb, and main honour it only as a smoke test seam', () => {
    expect(readFileSync('scripts/fixtures/smoke.mjs', 'utf8')).toContain("if (underXvfb(env)) env.VARIA_TEST_SHOW_WINDOW ??= '1'")
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain("if (testSeams && process.env.VARIA_TEST_SHOW_WINDOW === '1') window.showInactive()")
    expect(main).toMatch(/const testSeams = process\.env\.VARIA_SMOKE_TEST === '1' && !app\.isPackaged/)
  })
})
