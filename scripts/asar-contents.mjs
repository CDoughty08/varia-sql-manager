// What a packaged app.asar holds, for scripts/packaged-smoke.mjs. electron-vite bundles every package into out/ (Varia
// has no runtime dependencies), so the archive holds no node_modules, and main and preload load only Electron and
// Node's own modules: a package listed in `dependencies` again would be left external and shipped whole (issue #163).
import { openSync, readSync, closeSync } from 'node:fs'

/** The archive's files by path ('/'-separated, no leading slash), each with a reader of its bytes. */
export function readAsar(path) {
  const fd = openSync(path, 'r')
  const read = (position, length) => { const bytes = Buffer.alloc(length); readSync(fd, bytes, 0, length, position); return bytes }
  try {
    // Two Chromium pickles: the header's size, then the header, a JSON string.
    const headerSize = read(4, 4).readUInt32LE(0)
    const header = read(8, headerSize)
    const json = JSON.parse(header.toString('utf8', 8, 8 + header.readUInt32LE(4)))
    const files = new Map()
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const path = prefix ? `${prefix}/${name}` : name
        if (entry.files) walk(entry, path)
        else files.set(path, entry)
      }
    }
    walk(json, '')
    const contents = new Map()
    for (const [name, entry] of files) {
      const bytes = entry.unpacked || entry.link ? Buffer.alloc(0) : read(8 + headerSize + Number(entry.offset), entry.size)
      contents.set(name, bytes)
    }
    return contents
  } finally { closeSync(fd) }
}

/** The modules a bundled script loads by bare name: static imports, re-exports, dynamic imports and requires. */
export function bareImports(code) {
  const names = new Set()
  for (const pattern of [/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"'./][^"']*)["']/gm, /^\s*import\s*["']([^"'./][^"']*)["']/gm, /\b(?:import|require)\(\s*["']([^"'./][^"']*)["']\s*\)/g])
    for (const match of code.matchAll(pattern)) names.add(match[1])
  return [...names]
}

const builtIn = name => name === 'electron' || name.startsWith('node:')

/** Problems with the files an app.asar holds: any node_modules, and any main or preload module a script loads by a name other than Electron's or a node: one. */
export function asarProblems(contents) {
  const problems = []
  const modules = [...contents.keys()].filter(name => name.split('/').includes('node_modules'))
  if (modules.length) problems.push(`app.asar holds ${modules.length} node_modules files, such as ${modules[0]}`)
  for (const [name, bytes] of contents) {
    if (!/^out\/(main|preload)\/.*\.(c|m)?js$/.test(name)) continue
    for (const loaded of bareImports(bytes.toString('utf8')).filter(loaded => !builtIn(loaded))) problems.push(`${name} loads ${loaded}, which is not bundled`)
  }
  return problems
}
