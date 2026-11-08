import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { asarProblems, bareImports, readAsar } from '../scripts/asar-contents.mjs'

/** An archive as electron-builder writes one: the header's size, the JSON header (both Chromium pickles), then the files. */
function asar(files: Record<string, string>): Buffer {
  const tree: { files: Record<string, unknown> } = { files: {} }
  const bodies: Buffer[] = []
  let offset = 0
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/'), body = Buffer.from(text)
    let node = tree
    for (const part of parts.slice(0, -1)) node = (node.files[part] ??= { files: {} }) as typeof tree
    node.files[parts.at(-1)!] = { size: body.length, offset: String(offset) }
    bodies.push(body)
    offset += body.length
  }
  const json = Buffer.from(JSON.stringify(tree))
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4)
  json.copy(padded)
  const header = Buffer.alloc(8 + padded.length)
  header.writeUInt32LE(4 + padded.length, 0)
  header.writeUInt32LE(json.length, 4)
  padded.copy(header, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(header.length, 4)
  return Buffer.concat([size, header, ...bodies])
}

let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined })

describe('Packaging (issue #163)', () => {
  it('has no runtime dependencies, so electron-vite bundles every package into out/ and electron-builder ships no node_modules', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    expect(pkg.dependencies ?? {}).toEqual({})
    expect(pkg.optionalDependencies ?? {}).toEqual({})
    for (const name of ['zod', 'react', 'monaco-editor']) expect(pkg.devDependencies[name], name).toBeDefined()
    // electron-vite externalizes `dependencies` for main and preload; nothing may turn that back on or list externals.
    const config = await readFile('electron.vite.config.ts', 'utf8')
    expect(config).not.toMatch(/externalizeDeps|external\s*:/)
  })
  it('finds the modules a bundle loads by bare name', () => {
    const code = 'import { app } from "electron";\nimport { readFile } from "node:fs/promises";\nimport { z } from "zod";\nimport "side-effect";\nexport * from "re-export";\nconst x = require("legacy");\nconst y = await import("lazy");\nimport local from "./chunk.js";\nconst text = "from \\"name\\"";'
    expect(bareImports(code).sort()).toEqual(['electron', 'lazy', 'legacy', 'node:fs/promises', 're-export', 'side-effect', 'zod'])
  })
  it('reads a packaged archive and reports node_modules and unbundled imports in main and preload', async () => {
    await mkdir('artifacts', { recursive: true })
    directory = await mkdtemp(join(resolve('artifacts'), 'asar-test-'))
    const clean = join(directory, 'clean.asar'), shipped = join(directory, 'shipped.asar')
    await writeFile(clean, asar({ 'package.json': '{}', 'out/main/index.js': 'import { app } from "electron";\nimport { join } from "node:path";\n', 'out/preload/index.cjs': 'const e = require("electron");', 'out/renderer/index.html': '<html></html>' }))
    await writeFile(shipped, asar({ 'out/main/index.js': 'import { app } from "electron";\nimport { z } from "zod";\n', 'node_modules/zod/package.json': '{}' }))
    const contents = readAsar(clean)
    expect([...contents.keys()].sort()).toEqual(['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html', 'package.json'])
    expect(contents.get('out/preload/index.cjs')?.toString()).toBe('const e = require("electron");')
    expect(asarProblems(contents)).toEqual([])
    expect(asarProblems(readAsar(shipped))).toEqual(['app.asar holds 1 node_modules files, such as node_modules/zod/package.json', 'out/main/index.js loads zod, which is not bundled'])
  })
})
