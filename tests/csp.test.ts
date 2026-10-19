import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { HtmlTagDescriptor } from 'vite'
import { cspMeta } from '../electron.vite.config'
import { contentSecurityPolicy } from '../src/shared/csp'

const directives = (policy: string) => new Map(policy.split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]))

describe('content security policy', () => {
  it('allows only the page\'s own scripts in production: no inline script, no eval, no plugins, frames or <base>', () => {
    const policy = directives(contentSecurityPolicy())
    expect(policy.get('script-src')).toEqual(["'self'"])
    expect(policy.get('default-src')).toEqual(["'self'"])
    expect(policy.get('connect-src')).toEqual(["'self'"])
    expect(policy.get('object-src')).toEqual(["'none'"])
    expect(policy.get('frame-src')).toEqual(["'none'"])
    expect(policy.get('base-uri')).toEqual(["'none'"])
    // Monaco's editor worker and the results worker are bundled files.
    expect(policy.get('worker-src')).toEqual(["'self'", 'blob:'])
    expect(contentSecurityPolicy()).not.toMatch(/unsafe-eval|wasm-unsafe-eval|\*/)
  })
  it('lets only the development server\'s page run inline scripts and reach its origin and socket', () => {
    const policy = directives(contentSecurityPolicy('http://127.0.0.1:5173/'))
    expect(policy.get('script-src')).toEqual(["'self'", "'unsafe-inline'"])
    expect(policy.get('connect-src')).toEqual(['http://127.0.0.1:5173', 'ws://127.0.0.1:*', 'ws://localhost:*'])
    expect(contentSecurityPolicy('http://127.0.0.1:5173/')).not.toContain('unsafe-eval')
  })
  it('puts main\'s production policy in built pages, ahead of every script, and never in the development server\'s', async () => {
    expect(cspMeta.apply).toBe('build')
    const transform = cspMeta.transformIndexHtml as () => HtmlTagDescriptor[]
    expect(transform()).toEqual([{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy() }, injectTo: 'head-prepend' }])
    // The page's own markup has no inline script for the policy to block.
    const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
    expect([...html.matchAll(/<script\b[^>]*>([^<]*)<\/script>/g)].map(match => match[1].trim())).toEqual([''])
  })
})
