import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { underXvfb, xvfbArgs } from '../scripts/fixtures/xvfb.mjs'

// Why launches under xvfb take --disable-gpu: scripts/fixtures/xvfb.mjs.
describe('Electron launches on a virtual display', () => {
  const xvfb = { XAUTHORITY: '/tmp/xvfb-run.A5KxQZ/Xauthority' }

  it('knows xvfb-run by the XAUTHORITY it sets, on Linux only', () => {
    expect(underXvfb(xvfb, 'linux')).toBe(true)
    expect(underXvfb({ XAUTHORITY: '/home/runner/work/_temp/xvfb-run.x1/Xauthority' }, 'linux')).toBe(true)
    expect(underXvfb({ XAUTHORITY: '/home/user/.Xauthority' }, 'linux')).toBe(false)
    expect(underXvfb({}, 'linux')).toBe(false)
    expect(underXvfb(xvfb, 'win32')).toBe(false)
  })

  it('start without the GPU under xvfb only, once, keeping the caller\'s own arguments', () => {
    expect(xvfbArgs(['.'], xvfb, 'linux')).toEqual(['.', '--disable-gpu'])
    expect(xvfbArgs(['.', 'a.sql', '--no-sandbox'], xvfb, 'linux')).toEqual(['.', 'a.sql', '--no-sandbox', '--disable-gpu'])
    expect(xvfbArgs(['.', '--disable-gpu'], xvfb, 'linux')).toEqual(['.', '--disable-gpu'])
    expect(xvfbArgs(['.'], { XAUTHORITY: '/home/user/.Xauthority' }, 'linux')).toEqual(['.'])
    expect(xvfbArgs(['.'], xvfb, 'win32')).toEqual(['.'])
  })

  // files-smoke's second instance and the packaged smoke started Electron themselves, without the switch.
  it('all take their arguments from xvfbArgs, whether through the smoke fixture or launched directly', () => {
    const fixture = readFileSync('scripts/fixtures/smoke.mjs', 'utf8')
    expect(fixture).toContain('const args = xvfbArgs(options.args ?? [], env)')
    expect(fixture).toMatch(/_electron\.launch\(\{ \.\.\.options, env, args: args\.includes\(frameRateSwitch\)/)
    // Every other place that starts the app: Playwright's raw launcher, or a spawn of Electron or the packaged executable.
    const raw = /\belectron\.launch\(/, spawned = /\bspawn\(\s*(?:electronPath|executable)\b/
    const launches = ['scripts', 'scripts/fixtures'].flatMap(folder => readdirSync(folder).filter(name => name.endsWith('.mjs') && name !== 'smoke.mjs').map(name => `${folder}/${name}`))
      .flatMap(path => {
        const source = readFileSync(path, 'utf8')
        // electron.launch from the smoke fixture goes through it, checked above; a spawn never does.
        const fixtureLaunch = /import \{[^}]*\belectron\b[^}]*\} from '\.\/(?:fixtures\/)?smoke\.mjs'/.test(source)
        return source.split('\n').filter(line => spawned.test(line) || (!fixtureLaunch && raw.test(line))).map(line => ({ path, line: line.trim() }))
      })
    expect(launches.map(({ path }) => path).sort()).toEqual(expect.arrayContaining(['scripts/files-smoke.mjs', 'scripts/packaged-smoke.mjs', 'scripts/startup-bench.mjs']))
    expect(launches.filter(({ line }) => !line.includes('xvfbArgs('))).toEqual([])
  })
})
