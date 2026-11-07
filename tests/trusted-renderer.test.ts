import { describe, expect, it } from 'vitest'
import { rendererUrlVerifier } from '../src/main/trusted-renderer'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('renderer URL verification', () => {
  it('accepts only app://varia/index.html in a built app, never a file: page', () => {
    const check = rendererUrlVerifier()
    expect(check('app://varia/index.html')).toBe(true)
    expect(check('app://varia/other.html')).toBe(false)
    expect(check('app://varia/index.html?other=1')).toBe(false)
    expect(check('app://varia/index.html#x')).toBe(false)
    expect(check('app://other/index.html')).toBe(false)
    expect(check('app://varia:1/index.html')).toBe(false)
    expect(check(pathToFileURL(resolve('out/renderer/index.html')).href)).toBe(false)
    expect(check('about:blank')).toBe(false)
    expect(check('')).toBe(false)
  })

  it('accepts only the configured development origin', () => {
    const check = rendererUrlVerifier('http://127.0.0.1:5173/')
    expect(check('http://127.0.0.1:5173/other')).toBe(true)
    expect(check('http://127.0.0.1:5174/')).toBe(false)
    expect(check('app://varia/index.html')).toBe(false)
  })
})
