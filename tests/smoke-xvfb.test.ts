import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gpuSwitch, underXvfb, xvfbArgs } from '../scripts/fixtures/xvfb.mjs'

// Linux CI's smoke launches sometimes ran no animation frames ("animationFrame": "none within 2 s"), so Dockview never
// placed its panels and the editor stayed hidden for 30 s. Each such launch's GPU process had failed to start (xvfb has no
// GPU) and never finished exiting, so no software one replaced it. Under xvfb the fixture starts Chromium in software.
describe('smoke windows on a virtual display', () => {
  const xvfb = { XAUTHORITY: '/tmp/xvfb-run.A5KxQZ/Xauthority' }

  it('knows xvfb-run by the XAUTHORITY it sets, on Linux only', () => {
    expect(underXvfb(xvfb, 'linux')).toBe(true)
    expect(underXvfb({ XAUTHORITY: '/home/runner/work/_temp/xvfb-run.x1/Xauthority' }, 'linux')).toBe(true)
    expect(underXvfb({ XAUTHORITY: '/home/user/.Xauthority' }, 'linux')).toBe(false)
    expect(underXvfb({}, 'linux')).toBe(false)
    expect(underXvfb(xvfb, 'win32')).toBe(false)
  })

  it('launches without the GPU under xvfb only, once, keeping the suite\'s own arguments', () => {
    expect(gpuSwitch).toBe('--disable-gpu')
    expect(xvfbArgs(['.'], xvfb, 'linux')).toEqual(['.', '--disable-gpu'])
    expect(xvfbArgs(['.', '--disable-gpu'], xvfb, 'linux')).toEqual(['.', '--disable-gpu'])
    expect(xvfbArgs(['.'], { XAUTHORITY: '/home/user/.Xauthority' }, 'linux')).toEqual(['.'])
    expect(xvfbArgs(['.'], xvfb, 'win32')).toEqual(['.'])
  })

  it('is how every smoke launch gets its arguments, and main keeps no show-window seam', () => {
    const fixture = readFileSync('scripts/fixtures/smoke.mjs', 'utf8')
    expect(fixture).toContain('const args = xvfbArgs(options.args ?? [], env)')
    expect(fixture).toMatch(/_electron\.launch\(\{ \.\.\.options, env, args: args\.includes\(frameRateSwitch\)/)
    expect(readFileSync('src/main/index.ts', 'utf8')).not.toContain('VARIA_TEST_SHOW_WINDOW')
  })
})
