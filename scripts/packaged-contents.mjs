// What a package holds, for scripts/packaged-smoke.mjs (issue #163).
//
// app.asar: electron-vite bundles every package into out/ (Varia
// has no runtime dependencies), so the archive holds no node_modules, and main and preload load only Electron and
// Node's own modules: a package listed in `dependencies` again would be left external and shipped whole.
//
// The backend: the release publish is ReadyToRun (Varia.Backend.csproj), so Varia and its packages carry native code
// instead of being JIT-compiled on every launch and first use.
import { openSync, readFileSync, readSync, closeSync } from 'node:fs'

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

/**
 * Whether the managed PE file at `path` is ReadyToRun: its CLI header's ManagedNativeHeader points at a READYTORUN_HEADER,
 * whose signature is 'RTR'. An IL-only assembly has no such header.
 */
export function isReadyToRun(path) {
  const pe = readFileSync(path)
  try { return readyToRunHeader(pe) } catch (error) { if (error instanceof RangeError) return false; throw error }
}
function readyToRunHeader(pe) {
  if (pe.length < 0x40 || pe.readUInt16LE(0) !== 0x5a4d) return false
  const header = pe.readUInt32LE(0x3c)
  if (pe.readUInt32LE(header) !== 0x00004550) return false
  const sections = pe.readUInt16LE(header + 6), optional = header + 24, optionalSize = pe.readUInt16LE(header + 20)
  const directories = optional + (pe.readUInt16LE(optional) === 0x20b ? 112 : 96)
  const offsetOf = rva => {
    for (let i = 0, table = optional + optionalSize; i < sections; i++, table += 40) {
      const virtual = pe.readUInt32LE(table + 12), size = Math.max(pe.readUInt32LE(table + 8), pe.readUInt32LE(table + 16))
      if (rva >= virtual && rva < virtual + size) return rva - virtual + pe.readUInt32LE(table + 20)
    }
    return undefined
  }
  const cli = offsetOf(pe.readUInt32LE(directories + 14 * 8))
  if (cli === undefined) return false
  const native = pe.readUInt32LE(cli + 64) && offsetOf(pe.readUInt32LE(cli + 64))
  return native !== undefined && native !== 0 && pe.readUInt32LE(native) === 0x00525452
}

/** The backend assemblies a package must carry precompiled: Varia's own and the ones every connect and Script As loads. */
export const readyToRunAssemblies = ['Varia.Backend.dll', 'Microsoft.Data.SqlClient.dll', 'Microsoft.SqlServer.Smo.dll']
