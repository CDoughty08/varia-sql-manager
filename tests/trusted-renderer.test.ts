import { describe, expect, it } from 'vitest'
import { rendererUrlVerifier } from '../src/main/trusted-renderer'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('renderer URL verification', () => {
  it('accepts only the configured page in a packaged build', () => {
    const path = resolve('app/out/renderer/index.html')
    const url = pathToFileURL(path).href
    const check = rendererUrlVerifier(path, undefined, 'linux')
    expect(check(url)).toBe(true)
    expect(check(url.replace('index.html', 'other.html'))).toBe(false)
    expect(check(`${url}?other=1`)).toBe(false)
  })

  it('accepts only the configured development origin', () => {
    const check = rendererUrlVerifier('/app/out/renderer/index.html', 'http://127.0.0.1:5173/', 'linux')
    expect(check('http://127.0.0.1:5173/other')).toBe(true)
    expect(check('http://127.0.0.1:5174/')).toBe(false)
  })

  it.runIf(process.platform === 'win32')('recognizes a short path only for the same archive and renderer page', () => {
    const expected = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\extract\\resources\\app.asar'
    const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\extract\\resources\\app.asar'
    const canonicalize = (path: string) => {
      if (path.toLowerCase() === short.toLowerCase() || path.toLowerCase() === expected.toLowerCase()) return expected
      return path
    }
    const check = rendererUrlVerifier(`${expected}\\out\\renderer\\index.html`, undefined, 'win32', canonicalize)
    expect(check('file:///C:/Users/RUNNER~1/AppData/Local/Temp/extract/resources/app.asar/out/renderer/index.html')).toBe(true)
    expect(check('file:///C:/Users/RUNNER~1/AppData/Local/Temp/extract/resources/app.asar/out/renderer/other.html')).toBe(false)
    expect(check('file:///C:/Users/RUNNER~1/AppData/Local/Temp/other/resources/app.asar/out/renderer/index.html')).toBe(false)
    expect(check('file:///C:/Users/RUNNER~1/AppData/Local/Temp/extract/resources/app.asar/out/renderer/index.html?x=1')).toBe(false)
  })
})
