import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Result values are untrusted SQL data: the grid and the results views write text only through Text nodes and React,
// never as markup.
const roots = ['src/renderer/src/grid', 'src/renderer/src/results']
const sinks = /\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|createContextualFragment)\b|document\.write|\.textContent\s*=(?!=)/
const files = roots.flatMap(root => readdirSync(root).filter(name => /\.(ts|tsx)$/.test(name)).map(name => join(root, name)))

describe('grid lint', () => {
  it('finds the grid and results sources', () => {
    expect(files).toEqual(expect.arrayContaining(['src/renderer/src/grid/GridView.ts', 'src/renderer/src/results/OutputPane.tsx', 'src/renderer/src/results/MessagesView.tsx']))
  })
  it('writes no HTML from the grid or the results views', () => {
    const offenders = files.flatMap(file => readFileSync(file, 'utf8').split('\n').map((line, index) => [file, index + 1, line] as const)).filter(([, , line]) => sinks.test(line))
    expect(offenders.map(([file, line]) => `${file}:${line}`)).toEqual([])
  })
  it('writes cell and header text only through Text nodes', () => {
    const source = readFileSync('src/renderer/src/grid/GridView.ts', 'utf8')
    expect(source).toMatch(/\.nodeValue = value/)
    expect(source).not.toMatch(/\.(innerText|textContent)\b/)
  })
})
