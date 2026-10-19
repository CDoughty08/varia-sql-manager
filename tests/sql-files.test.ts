import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileCheckLimits, fileKinds, isReadOnly, saveDocument, saveFileSchema, SqlFileStore, type SavePrompts } from '../src/main/sql-files'

let directory: string
beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(join(resolve('artifacts'), 'sql-files-test-'))
})
afterEach(async () => {
  expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
  await rm(directory, { recursive: true, force: true })
})

describe('SQL documents', () => {
  it('opens, saves, and saves as without exposing paths as renderer capabilities', async () => {
    const store = new SqlFileStore()
    const path = join(directory, 'query.sql')
    await writeFile(path, 'SELECT 1;\n')
    const opened = await store.read(path)
    expect(opened.content).toBe('SELECT 1;\n')
    await store.save('SELECT 2;\n', opened.id)
    expect(await readFile(path, 'utf8')).toBe('SELECT 2;\n')
    const copy = await store.save('SELECT 3;\n', opened.id, join(directory, 'copy.sql'))
    expect(copy.name).toBe('copy.sql')
    expect(await readFile(path, 'utf8')).toBe('SELECT 2;\n')
    expect(await readFile(copy.path, 'utf8')).toBe('SELECT 3;\n')
  })
  it('refuses Save As over a file that is open in another tab', async () => {
    const store = new SqlFileStore()
    const path = join(directory, 'shared.sql')
    await writeFile(path, 'SELECT 1;\n')
    await store.read(path)
    const other = await store.save('SELECT 2;\n', undefined, join(directory, 'other.sql'))
    const target = process.platform === 'win32' ? path.toUpperCase() : path
    await expect(store.save('SELECT 3;\n', other.id, target)).rejects.toThrow('open in another query tab')
    expect(await readFile(path, 'utf8')).toBe('SELECT 1;\n')
  })
  it('opens a file again under the path it was first opened with, so the page finds its tab', async () => {
    // Windows paths differ only in case; elsewhere the platform option stands in for Windows' comparison.
    const store = new SqlFileStore({ platform: 'win32' })
    const path = join(directory, 'Orders.sql'), shouted = join(directory, 'ORDERS.SQL')
    await writeFile(path, 'SELECT 1;\n')
    const first = await store.read(path)
    // On a case-sensitive file system the other spelling is another file with the same text.
    if (process.platform !== 'win32') await writeFile(shouted, 'SELECT 1;\n')
    const again = await store.read(shouted)
    expect(again).toMatchObject({ id: first.id, path, name: 'Orders.sql' })
    expect(store.get(first.id)).toMatchObject({ path, name: 'Orders.sql' })
  })
  it('preserves UTF-16 LE scripts produced by SQL tools', async () => {
    const path = join(directory, 'unicode.sql')
    await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("SELECT N'日本語';\r\n", 'utf16le')]))
    const store = new SqlFileStore()
    const opened = await store.read(path)
    expect(opened.content).toBe("SELECT N'日本語';\r\n")
    await store.save("SELECT N'Français';\r\n", opened.id)
    const bytes = await readFile(path)
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe])
    expect(bytes.subarray(2).toString('utf16le')).toBe("SELECT N'Français';\r\n")
  })
  it('leaves the original file intact when a replacement fails', async () => {
    const path = join(directory, 'query.sql')
    await writeFile(path, 'original')
    const store = new SqlFileStore()
    const opened = await store.read(path)
    await expect(store.save('replacement', opened.id, directory)).rejects.toThrow('is not a file.')
    expect(await readFile(path, 'utf8')).toBe('original')
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('rejects unknown and released file tokens', async () => {
    const store = new SqlFileStore()
    await expect(store.save('SELECT 1', crypto.randomUUID(), join(directory, 'no.sql'))).rejects.toThrow('Unknown SQL file')
    const file = await store.save('SELECT 1', undefined, join(directory, 'yes.sql'))
    store.release(file.id)
    await expect(store.save('SELECT 2', file.id)).rejects.toThrow('Unknown SQL file')
    expect(await readFile(file.path, 'utf8')).toBe('SELECT 1')
  })
  it('saves a value opened from the results with its kind\'s filters and limits', async () => {
    expect(fileKinds.xml.filters).toEqual([{ name: 'XML files', extensions: ['xml'] }])
    expect(fileKinds.json.filters).toEqual([{ name: 'JSON files', extensions: ['json'] }])
    expect(fileKinds.sqlplan.filters.map(filter => filter.extensions)).toEqual([['sqlplan'], ['xml']])
    expect(fileKinds.sql).toMatchObject({ title: 'Save SQL query', maxChars: 5_000_000, maxBytes: 5_000_000 })
    const request = (content: string, kind?: string) => saveFileSchema.safeParse({ name: 'v.xml', content, saveAs: true, ...kind ? { kind } : {} }).success
    expect(request('x'.repeat(4_194_304), 'xml')).toBe(true)
    expect(request('x'.repeat(4_194_305), 'json')).toBe(false)
    expect(request('x'.repeat(4_194_305))).toBe(true)
    expect(request('x'.repeat(5_000_001))).toBe(false)
    expect(request('x', 'text')).toBe(false)
    expect(saveFileSchema.safeParse({ name: 'v.xml', content: 'x', saveAs: true, kind: 'xml', path: '/tmp/x' }).success).toBe(false)
    // A value may take more than a query's 5 MB on disk (up to 16 MiB), never more.
    const store = new SqlFileStore()
    const wide = '日'.repeat(2_000_000)
    await expect(store.save(wide, undefined, join(directory, 'wide.sql'))).rejects.toThrow('SQL files must be smaller than 5 MB.')
    const saved = await store.save(wide, undefined, join(directory, 'wide.xml'), 'xml')
    expect((await readFile(saved.path, 'utf8')).length).toBe(2_000_000)
    await expect(store.save('日'.repeat(5_600_000), undefined, join(directory, 'huge.xml'), 'xml')).rejects.toThrow('Files must be smaller than 16 MB.')
  })
})

describe('SQL file encodings and save hardening', () => {
  it('reports each file\'s encoding, line endings and read-only state, and writes the encoding it read', async () => {
    const store = new SqlFileStore({ platform: 'linux' })
    const path = join(directory, 'big-endian.sql')
    const text = "SELECT N'Grüße';\r\nGO\r\n"
    await writeFile(path, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]))
    const opened = await store.read(path)
    expect(opened).toMatchObject({ content: text, encoding: 'utf16be', eol: 'crlf', mixedEol: false, readOnly: false })
    expect(opened).not.toHaveProperty('codePage')
    const saved = await store.save("SELECT N'Français';\r\n", opened.id)
    expect(saved).toEqual({ id: opened.id, name: 'big-endian.sql', path: opened.path, encoding: 'utf16be', readOnly: false })
    expect([...(await readFile(path))]).toEqual([0xfe, 0xff, ...Buffer.from("SELECT N'Français';\r\n", 'utf16le').swap16()])
    await writeFile(path, 'a\nb\r\nc\n')
    // Opened again, the file keeps what its tab's text was read as; a reload takes what it is now.
    expect(await store.read(path)).toMatchObject({ id: opened.id, encoding: 'utf16be' })
    expect(await store.reload(opened.id)).toMatchObject({ id: opened.id, encoding: 'utf8', eol: 'lf', mixedEol: true })
  })
  it('reads a file in the ANSI code page, and writes it only as Unicode it was told to use', async () => {
    const store = new SqlFileStore({ legacyLabel: () => 'windows-1252' })
    const path = join(directory, 'ansi.sql')
    await writeFile(path, Buffer.from([0x53, 0xe9, 0x80]))
    const opened = await store.read(path)
    expect(opened).toMatchObject({ content: 'Sé€', encoding: 'legacy', codePage: 'Windows-1252' })
    await expect(store.save('Sé€', opened.id)).rejects.toThrow('ansi.sql was read as Windows-1252, which Varia SQL Manager does not write. Save it as Unicode.')
    expect([...await readFile(path)]).toEqual([0x53, 0xe9, 0x80])
    expect(await store.save('Sé€', opened.id, undefined, 'sql', { encoding: 'utf8bom' })).toMatchObject({ encoding: 'utf8bom' })
    expect(await readFile(path)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Sé€')]))
    // Save files with a specific encoding converts any file.
    expect(await store.save('Sé€', opened.id, undefined, 'sql', { encoding: 'utf16le' })).toMatchObject({ encoding: 'utf16le' })
    expect(await readFile(path)).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Sé€', 'utf16le')]))
  })
  it('refuses a directory and files over the limit before decoding them', async () => {
    const store = new SqlFileStore()
    await expect(store.read(directory)).rejects.toThrow(/is not a file\.$/)
    const big = join(directory, 'big.sql')
    await writeFile(big, Buffer.alloc(5_000_001, 0x41))
    await expect(store.read(big)).rejects.toThrow('SQL files must be smaller than 5 MB.')
  })
  // Root can write any file, so the attribute means nothing there (cloud sessions).
  it.skipIf(process.getuid?.() === 0)('never replaces a read-only file without Overwrite, which clears the attribute first', async () => {
    const store = new SqlFileStore()
    const path = join(directory, 'locked.sql')
    await writeFile(path, 'SELECT 1')
    await chmod(path, 0o444)
    try {
      const opened = await store.read(path)
      expect(opened.readOnly).toBe(true)
      expect(await store.readOnly(opened.id)).toBe(true)
      await expect(store.save('SELECT 2', opened.id)).rejects.toThrow('locked.sql is read-only.')
      expect(await readFile(path, 'utf8')).toBe('SELECT 1')
      expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
      // Overwrite: a save that fails puts the attribute back, and one that succeeds leaves the file writable.
      const failing = new SqlFileStore({ replace: async () => { throw new Error('The file is in use.') } })
      const held = await failing.read(path)
      await expect(failing.save('SELECT 2', held.id, undefined, 'sql', { overwriteReadOnly: true })).rejects.toThrow('The file is in use.')
      expect(await isReadOnly(path)).toBe(true)
      expect(await readFile(path, 'utf8')).toBe('SELECT 1')
      expect(await store.save('SELECT 2', opened.id, undefined, 'sql', { overwriteReadOnly: true })).toMatchObject({ readOnly: false })
      expect(await store.readOnly(opened.id)).toBe(false)
      expect(await readFile(path, 'utf8')).toBe('SELECT 2')
    } finally { await chmod(path, 0o644).catch(() => {}) }
    expect(await isReadOnly(join(directory, 'missing.sql'))).toBe(false)
  })
  it('replaces the file through replaceFile, which retries Windows\' brief holds', async () => {
    const calls: [string, string][] = []
    const store = new SqlFileStore({ replace: async (from, to) => { calls.push([from, to]); await rename(from, to) } })
    const path = join(directory, 'held.sql')
    await writeFile(path, 'SELECT 1')
    const opened = await store.read(path)
    await store.save('SELECT 2', opened.id)
    expect(calls).toHaveLength(1)
    expect(dirname(calls[0][0])).toBe(dirname(await realpath(path)))
    expect(calls[0][1]).toBe(await realpath(path))
    expect(await readFile(path, 'utf8')).toBe('SELECT 2')
  })
  it('saves a file whose volume cannot resolve links, as some RAM disks and virtual drives cannot on Windows', async () => {
    const realpathFails = async (path: string) => { if (path.endsWith('.sql')) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, realpath '${path}'`), { code: 'EISDIR' }); return path }
    const store = new SqlFileStore({ realpath: realpathFails })
    const path = join(directory, 'ram.sql')
    await writeFile(path, 'SELECT 1')
    const opened = await store.read(path)
    expect(await store.readOnly(opened.id)).toBe(false)
    await store.save('SELECT 2', opened.id)
    expect(await readFile(path, 'utf8')).toBe('SELECT 2')
  })
  it('writes BOM-less UTF-16 without a byte order mark', async () => {
    const store = new SqlFileStore()
    const path = join(directory, 'bomless.sql')
    await writeFile(path, Buffer.from('SELECT 1;\r\n', 'utf16le'))
    const opened = await store.read(path)
    expect(opened.encoding).toBe('utf16leNoBom')
    await store.save('SELECT 1;\r\n', opened.id)
    expect(await readFile(path)).toEqual(Buffer.from('SELECT 1;\r\n', 'utf16le'))
  })
  it.skipIf(process.platform === 'win32')('keeps a POSIX file\'s permissions', async () => {
    const store = new SqlFileStore()
    const path = join(directory, 'private.sql')
    await writeFile(path, 'SELECT 1')
    await chmod(path, 0o600)
    const opened = await store.read(path)
    await store.save('SELECT 2', opened.id)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await chmod(path, 0o640)
    await store.save('SELECT 3', opened.id)
    expect((await stat(path)).mode & 0o777).toBe(0o640)
  })
  it.skipIf(process.platform === 'win32')('keeps a POSIX file\'s group, which the new file would otherwise take from the saver', async ({ skip }) => {
    // A group of the saver's other than its primary one: the new file starts in the primary group.
    const group = process.getgroups?.().find(gid => gid !== process.getgid?.())
    if (group === undefined) skip()
    const store = new SqlFileStore()
    const path = join(directory, 'shared.sql')
    await writeFile(path, 'SELECT 1')
    await chown(path, -1, group!)
    await chmod(path, 0o660)
    const opened = await store.read(path)
    await store.save('SELECT 2', opened.id)
    expect(await stat(path)).toMatchObject({ gid: group })
    expect((await stat(path)).mode & 0o777).toBe(0o660)
  })
  it('saves through a symbolic link to its target and keeps the link', async ({ skip }) => {
    const store = new SqlFileStore()
    await mkdir(join(directory, 'real'))
    const target = join(directory, 'real', 'query.sql'), link = join(directory, 'link.sql')
    await writeFile(target, 'SELECT 1')
    // Windows creates symbolic links only for administrators or in Developer Mode.
    try { await symlink(target, link, 'file') } catch { skip() }
    const opened = await store.read(link)
    expect(opened).toMatchObject({ name: 'link.sql', path: link, content: 'SELECT 1' })
    const saved = await store.save('SELECT 2', opened.id)
    expect(saved.path).toBe(link)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('SELECT 2')
    expect((await readdir(join(directory, 'real'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('treats a file and a symbolic link to it as one file, so two tabs cannot save over each other', async ({ skip }) => {
    const store = new SqlFileStore()
    const target = join(directory, 'real.sql'), link = join(directory, 'link.sql')
    await writeFile(target, 'SELECT 1')
    try { await symlink(target, link, 'file') } catch { skip() }
    const real = await store.read(target)
    // Opening the link finds the file's tab.
    expect(await store.read(link)).toMatchObject({ id: real.id, path: target })
    // Save As onto the link from another query is refused, as onto the file itself.
    const other = await store.save('SELECT 2', undefined, join(directory, 'other.sql'))
    await expect(store.save('SELECT 3', other.id, link)).rejects.toThrow('real.sql is open in another query tab')
    expect(await readFile(target, 'utf8')).toBe('SELECT 1')
    // And the other way round: the link registered first owns the file.
    store.release(real.id)
    const viaLink = await store.read(link)
    expect(viaLink).toMatchObject({ path: link })
    expect(await store.read(target)).toMatchObject({ id: viaLink.id, path: link })
    await expect(store.save('SELECT 3', other.id, target)).rejects.toThrow('link.sql is open in another query tab')
    expect(await readFile(target, 'utf8')).toBe('SELECT 1')
  })
  it('compares the files paths resolve to, wherever links can be made', async () => {
    // A stand-in for a link (Windows makes symbolic links only for administrators or in Developer Mode): realpath maps
    // alias.sql to real.sql, as it would through a link.
    const target = join(directory, 'real.sql'), alias = join(directory, 'alias.sql')
    const store = new SqlFileStore({ realpath: async path => path === alias ? target : path })
    await writeFile(target, 'SELECT 1')
    await writeFile(alias, 'SELECT 1')
    const real = await store.read(target)
    expect(await store.read(alias)).toMatchObject({ id: real.id, path: target })
    const other = await store.save('SELECT 2', undefined, join(directory, 'other.sql'))
    await expect(store.save('SELECT 3', other.id, alias)).rejects.toThrow('real.sql is open in another query tab')
    expect(await readFile(target, 'utf8')).toBe('SELECT 1')
  })
})

/** Answers from a queue and records what was asked. */
const prompts = (answers: { readOnly?: 'saveAs' | 'overwrite' | 'cancel'; changed?: boolean; unicode?: boolean; save?: string } = {}) => {
  const asked: string[] = []
  const value: SavePrompts = {
    readOnly: async path => { asked.push(`readOnly ${basename(path)}`); return answers.readOnly ?? 'cancel' },
    changed: async path => { asked.push('changed ' + basename(path)); return answers.changed ?? false },
    unicode: async (name, codePage) => { asked.push(`unicode ${name} ${codePage}`); return answers.unicode ?? false },
    saveDialog: async path => { asked.push(`save ${path ? basename(path) : '(new)'}`); return answers.save }
  }
  return { asked, value }
}
const request = (content: string, fileId?: string, saveAs = false) => ({ name: 'SQLQuery1.sql', content, saveAs, ...fileId ? { fileId } : {} })

describe('the save prompts', () => {

  it('saves in Save files with a specific encoding\'s encoding while it is on: a new query, and a legacy file without asking', async () => {
    const store = new SqlFileStore({ legacyLabel: () => 'windows-1252' })
    const fresh = prompts({ save: join(directory, 'new.sql') })
    expect(await saveDocument(store, request('SELECT 1'), 'utf16be', fresh.value)).toMatchObject({ name: 'new.sql', encoding: 'utf16be' })
    expect(fresh.asked).toEqual(['save (new)'])
    expect(await readFile(join(directory, 'new.sql'))).toEqual(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('SELECT 1', 'utf16le').swap16()]))
    // Off, a new query is UTF-8 without a BOM.
    const plain = prompts({ save: join(directory, 'plain.sql') })
    expect(await saveDocument(store, request('SELECT 1'), undefined, plain.value)).toMatchObject({ encoding: 'utf8' })
    expect(await readFile(join(directory, 'plain.sql'))).toEqual(Buffer.from('SELECT 1'))
    const path = join(directory, 'ansi.sql')
    await writeFile(path, Buffer.from([0x53, 0xe9]))
    const opened = await store.read(path)
    const quiet = prompts()
    expect(await saveDocument(store, request('Sé', opened.id), 'utf8', quiet.value)).toMatchObject({ encoding: 'utf8' })
    expect(quiet.asked).toEqual([])
    expect(await readFile(path)).toEqual(Buffer.from('Sé'))
  })
  it('asks Save as Unicode for a legacy file while the setting is off, and writes nothing on Cancel', async () => {
    const store = new SqlFileStore({ legacyLabel: () => 'windows-1252' })
    const path = join(directory, 'ansi.sql')
    await writeFile(path, Buffer.from([0x53, 0xe9]))
    const opened = await store.read(path)
    const cancelled = prompts({ unicode: false })
    expect(await saveDocument(store, request('Sé!', opened.id), undefined, cancelled.value)).toBeNull()
    expect(cancelled.asked).toEqual(['unicode ansi.sql Windows-1252'])
    expect([...await readFile(path)]).toEqual([0x53, 0xe9])
    expect(await saveDocument(store, request('Sé!', opened.id), undefined, prompts({ unicode: true }).value)).toMatchObject({ encoding: 'utf8bom' })
    expect(await readFile(path)).toEqual(Buffer.from('\uFEFFSé!'))
  })
  // Root can write any file, so the attribute means nothing there (cloud sessions).
  it.skipIf(process.getuid?.() === 0)('answers Save of Read-Only File: Save As… writes elsewhere, and Overwrite waits until nothing else can cancel', async () => {
    const store = new SqlFileStore({ legacyLabel: () => 'windows-1252' })
    const path = join(directory, 'locked.sql'), copy = join(directory, 'copy.sql')
    await writeFile(path, Buffer.from([0x53, 0xe9]))
    await chmod(path, 0o444)
    try {
      const opened = await store.read(path)
      // Save As… opens one Save dialog at the file, writes the new path, and leaves the read-only original alone.
      const saveAs = prompts({ readOnly: 'saveAs', unicode: true, save: copy })
      expect(await saveDocument(store, request('SELECT 2', opened.id), undefined, saveAs.value)).toMatchObject({ id: opened.id, path: copy, encoding: 'utf8bom' })
      expect(saveAs.asked).toEqual(['readOnly locked.sql', 'unicode locked.sql Windows-1252', 'save locked.sql'])
      expect(await readFile(copy)).toEqual(Buffer.from('\uFEFFSELECT 2'))
      expect([...await readFile(path)]).toEqual([0x53, 0xe9])
      expect(await isReadOnly(path)).toBe(true)
      // Overwrite, then Cancel at Save as Unicode: the file keeps its attribute and its bytes.
      const again = await store.read(path)
      const overwrite = prompts({ readOnly: 'overwrite', unicode: false })
      expect(await saveDocument(store, request('SELECT 3', again.id), undefined, overwrite.value)).toBeNull()
      expect(overwrite.asked).toEqual(['readOnly locked.sql', 'unicode locked.sql Windows-1252'])
      expect(await isReadOnly(path)).toBe(true)
      expect([...await readFile(path)]).toEqual([0x53, 0xe9])
      // Cancel at Save of Read-Only File asks nothing more.
      const cancel = prompts({ readOnly: 'cancel' })
      expect(await saveDocument(store, request('SELECT 3', again.id), undefined, cancel.value)).toBeNull()
      expect(cancel.asked).toEqual(['readOnly locked.sql'])
      // Overwrite, agreed throughout, clears the attribute and saves.
      const agreed = prompts({ readOnly: 'overwrite', unicode: true })
      expect(await saveDocument(store, request('SELECT 3', again.id), undefined, agreed.value)).toMatchObject({ path, readOnly: false })
      expect(agreed.asked).toEqual(['readOnly locked.sql', 'unicode locked.sql Windows-1252'])
      expect(await isReadOnly(path)).toBe(false)
      expect(await readFile(path)).toEqual(Buffer.from('\uFEFFSELECT 3'))
    } finally { await chmod(path, 0o644).catch(() => {}) }
  })
})

describe('changes made outside', () => {
  const later = (seconds: number) => new Date(Date.now() + seconds * 1000)
  it('reports a changed file once, and a touched file that kept its content never', async () => {
    const store = new SqlFileStore()
    const path = join(directory, 'one.sql')
    await writeFile(path, 'SELECT 1')
    const opened = await store.read(path)
    expect(await store.check()).toEqual([])
    // The same content with a new time is no change.
    await utimes(path, later(10), later(10))
    expect(await store.check()).toEqual([])
    await writeFile(path, 'SELECT 2')
    await utimes(path, later(20), later(20))
    expect(await store.check()).toEqual([{ fileId: opened.id, change: 'modified' }])
    expect(await store.check()).toEqual([])
    // Reading it again keeps its id and takes its content.
    expect(await store.reload(opened.id)).toMatchObject({ id: opened.id, content: 'SELECT 2' })
    expect(await store.check()).toEqual([])
  })
  it('reports a deleted file once, and one written back with the same content as unchanged', async () => {
    const store = new SqlFileStore()
    const path = join(directory, 'gone.sql'), other = join(directory, 'other.sql')
    await writeFile(path, 'SELECT 1')
    await writeFile(other, 'SELECT 2')
    const gone = await store.read(path), kept = await store.read(other)
    await rm(path)
    await writeFile(other, 'SELECT 3')
    await utimes(other, later(10), later(10))
    // In registration order.
    expect(await store.check()).toEqual([{ fileId: gone.id, change: 'deleted' }, { fileId: kept.id, change: 'modified' }])
    expect(await store.check()).toEqual([])
    await writeFile(path, 'SELECT 1')
    expect(await store.check()).toEqual([])
    // Save writes a deleted file again, without asking whether it changed.
    await rm(path)
    expect(await store.changedOnDisk(gone.id)).toBe(false)
    await store.save('SELECT 4', gone.id)
    expect(await readFile(path, 'utf8')).toBe('SELECT 4')
    expect(await store.check()).toEqual([])
  })
  it('keeps asking before a Save over a change the user did not reload, until the file is saved or reloaded', async () => {
    const store = new SqlFileStore()
    const path = join(directory, 'one.sql')
    await writeFile(path, 'SELECT 1')
    const opened = await store.read(path)
    expect(await store.changedOnDisk(opened.id)).toBe(false)
    await writeFile(path, 'SELECT outside')
    await utimes(path, later(10), later(10))
    // Not yet checked: Save still sees the change.
    expect(await store.changedOnDisk(opened.id)).toBe(true)
    // A check reports it once; the No answer leaves it changed for Save.
    expect(await store.check()).toHaveLength(1)
    expect(await store.changedOnDisk(opened.id)).toBe(true)
    await store.save('SELECT mine', opened.id)
    expect(await store.changedOnDisk(opened.id)).toBe(false)
    await writeFile(path, 'SELECT outside again')
    await utimes(path, later(20), later(20))
    expect(await store.check()).toHaveLength(1)
    await store.reload(opened.id)
    expect(await store.changedOnDisk(opened.id)).toBe(false)
    // A change the user kept, then the file deleted: Save writes it again without asking.
    await writeFile(path, 'SELECT outside once more')
    await utimes(path, later(30), later(30))
    expect(await store.check()).toHaveLength(1)
    await rm(path)
    expect(await store.check()).toEqual([{ fileId: opened.id, change: 'deleted' }])
    expect(await store.changedOnDisk(opened.id)).toBe(false)
  })
  it('does not hide a change behind a second Open of the same file', async () => {
    const store = new SqlFileStore()
    const path = join(directory, 'one.sql')
    await writeFile(path, 'SELECT 1')
    const opened = await store.read(path)
    await writeFile(path, 'SELECT 2')
    await utimes(path, later(10), later(10))
    expect((await store.read(path)).id).toBe(opened.id)
    expect(await store.check()).toEqual([{ fileId: opened.id, change: 'modified' }])
  })
  it('counts a file it cannot look at in time as unchanged, and reports it when it can', async () => {
    // A share that answers after the check gave up on it, as a slow network drive does.
    let slow = true, answered!: () => void
    const late = new Promise<void>(resolve => { answered = resolve })
    const store = new SqlFileStore({ stat: async path => { if (slow) await late; return stat(path) } })
    const path = join(directory, 'slow.sql')
    await writeFile(path, 'SELECT 1')
    const opened = await store.read(path)
    await writeFile(path, 'SELECT 2')
    await utimes(path, later(10), later(10))
    expect(await store.check({ concurrency: 8, timeoutMs: 20 })).toEqual([])
    // Its answer arrives after the check ended and changes nothing: the change is reported by the next check.
    answered()
    await new Promise(resolve => setTimeout(resolve, 20))
    slow = false
    expect(await store.check()).toEqual([{ fileId: opened.id, change: 'modified' }])
  })
  it('does not compare a file again while its last comparison hangs, and lets at most two hang', async () => {
    // A share that never answers (a hard NFS mount, an unplugged VPN): each call would hold one of libuv's four threads.
    const calls = new Map<string, number>()
    const hung = (path: string) => basename(path).startsWith('hung')
    const store = new SqlFileStore({ stat: async path => { calls.set(basename(path), (calls.get(basename(path)) ?? 0) + 1); return hung(path) ? new Promise<never>(() => {}) : stat(path) } })
    const paths = ['hung-1.sql', 'hung-2.sql', 'hung-3.sql', 'hung-4.sql'].map(name => join(directory, name))
    for (const path of paths) await writeFile(path, 'SELECT 1')
    for (const path of paths) await store.read(path)
    const limits = { ...fileCheckLimits, timeoutMs: 20 }
    expect(await store.check(limits)).toEqual([])
    expect(await store.check(limits)).toEqual([])
    expect(await store.check(limits)).toEqual([])
    expect([...calls.values()].reduce((sum, count) => sum + count, 0)).toBe(fileCheckLimits.concurrency)
    expect(Math.max(...calls.values())).toBe(1)
  })
  it('compares a file again once its late comparison settles', async () => {
    let answered!: () => void
    const late = new Promise<void>(resolve => { answered = resolve })
    let calls = 0
    const store = new SqlFileStore({ stat: async path => { if (++calls === 1) await late; return stat(path) } })
    const path = join(directory, 'late.sql')
    await writeFile(path, 'SELECT 1')
    const opened = await store.read(path)
    await writeFile(path, 'SELECT 2')
    await utimes(path, later(10), later(10))
    expect(await store.check({ concurrency: 2, timeoutMs: 20 })).toEqual([])
    expect(await store.check({ concurrency: 2, timeoutMs: 20 })).toEqual([])
    expect(calls).toBe(1)
    answered()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await store.check()).toEqual([{ fileId: opened.id, change: 'modified' }])
    expect(calls).toBe(2)
  })
  it('hashes a saved value larger than a query may be in full, so touching it is no change', async () => {
    const store = new SqlFileStore()
    const path = join(directory, 'large.xml')
    // 6 MB of UTF-8: more than a query file, less than a value document.
    const saved = await store.save('<a>' + 'é'.repeat(3_000_000) + '</a>', undefined, path, 'xml')
    expect((await stat(path)).size).toBeGreaterThan(5_000_000)
    await utimes(path, later(10), later(10))
    expect(await store.check()).toEqual([])
    expect(await store.changedOnDisk(saved.id)).toBe(false)
    await writeFile(path, '<a>' + 'è'.repeat(3_000_000) + '</a>')
    await utimes(path, later(20), later(20))
    expect(await store.check()).toEqual([{ fileId: saved.id, change: 'modified' }])
  })
  it('keeps what an open file was read as when it is opened again after another program rewrote it', async () => {
    const store = new SqlFileStore({ legacyLabel: () => 'windows-1252' })
    const path = join(directory, 'wide.sql')
    await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('SELECT 1', 'utf16le')]))
    const opened = await store.read(path)
    expect(opened.encoding).toBe('utf16le')
    await writeFile(path, Buffer.from([0x53, 0xe9]))
    await utimes(path, later(10), later(10))
    const again = await store.read(path)
    expect(again.id).toBe(opened.id)
    expect(store.get(opened.id)).toEqual({ id: opened.id, name: 'wide.sql', path: opened.path, encoding: 'utf16le', readOnly: false })
    // Only a reload takes what the file is now.
    expect(await store.reload(opened.id)).toMatchObject({ encoding: 'legacy', codePage: 'Windows-1252' })
    expect(store.get(opened.id)).toMatchObject({ encoding: 'legacy', codePage: 'Windows-1252' })
  })
  it('looks at no more than two files at a time, and reports them in registration order', async () => {
    let active = 0, most = 0
    const store = new SqlFileStore({ stat: async path => { active++; most = Math.max(most, active); try { await new Promise(resolve => setTimeout(resolve, 5)); return await stat(path) } finally { active-- } } })
    const paths = Array.from({ length: 20 }, (_, index) => join(directory, `${index}.sql`))
    for (const path of paths) await writeFile(path, 'SELECT 1')
    const opened = []
    for (const path of paths) opened.push(await store.read(path))
    for (const path of paths) { await writeFile(path, 'SELECT 2'); await utimes(path, later(10), later(10)) }
    expect((await store.check()).map(change => change.fileId)).toEqual(opened.map(file => file.id))
    expect(most).toBe(fileCheckLimits.concurrency)
  })
  it('asks File changed before Save replaces a change, and before Save as Unicode, only while detection is on', async () => {
    const store = new SqlFileStore({ legacyLabel: () => 'windows-1252' })
    const path = join(directory, 'ansi.sql')
    await writeFile(path, Buffer.from([0x53, 0xe9]))
    const opened = await store.read(path)
    await writeFile(path, Buffer.from([0x53, 0xe8]))
    await utimes(path, later(10), later(10))
    const cancelled = prompts({ changed: false })
    expect(await saveDocument(store, request('Sé!', opened.id), undefined, cancelled.value, true)).toBeNull()
    expect(cancelled.asked).toEqual(['changed ansi.sql'])
    expect([...await readFile(path)]).toEqual([0x53, 0xe8])
    const agreed = prompts({ changed: true, unicode: true })
    expect(await saveDocument(store, request('Sé!', opened.id), undefined, agreed.value, true)).toMatchObject({ encoding: 'utf8bom' })
    expect(agreed.asked).toEqual(['changed ansi.sql', 'unicode ansi.sql Windows-1252'])
    // Save As writes elsewhere, so it does not ask; nor does Save while detection is off.
    await writeFile(path, 'SELECT outside')
    await utimes(path, later(20), later(20))
    const saveAs = prompts({ save: join(directory, 'copy.sql') })
    expect(await saveDocument(store, request('SELECT 1', opened.id, true), undefined, saveAs.value, true)).toMatchObject({ name: 'copy.sql' })
    expect(saveAs.asked).toEqual(['save ansi.sql'])
    const again = await store.read(path)
    await writeFile(path, 'SELECT outside again')
    await utimes(path, later(30), later(30))
    const off = prompts()
    expect(await saveDocument(store, request('SELECT 2', again.id), undefined, off.value, false)).toMatchObject({ name: 'ansi.sql' })
    expect(off.asked).toEqual([])
  })
})
