import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileCheckLimits, fileKinds, isReadOnly, protectedLinkRefused, saveDocument, saveFileSchema, SqlFileStore, type SavePrompts } from '../src/main/sql-files'

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
  it('reads a sqlplan larger than the SQL file cap without raising that cap for query files', async () => {
    const store = new SqlFileStore(), content = 'x'.repeat(5_000_001)
    const plan = join(directory, 'large.sqlplan'), sql = join(directory, 'large.sql')
    await writeFile(plan, content)
    await writeFile(sql, content)
    expect(await store.read(plan)).toMatchObject({ kind: 'sqlplan', content })
    await expect(store.read(sql)).rejects.toThrow('5 MB')
  })
  it('reopens a large Showplan saved as XML using its root and namespace', async () => {
    const store = new SqlFileStore(), path = join(directory, 'exported.XML')
    const header = '<?xml version="1.0"?>\n<!--' + 'x'.repeat(5_000_000) + '-->\n'
    const root = '<p:ShowPlanXML Version="1.6" xmlns:p=\'http://schemas.microsoft.com/sqlserver/2004/07/showplan\'/>'
    const content = header + root
    const saved = await store.save(content, undefined, path, 'sqlplan')
    store.release(saved.id)
    const opened = await store.read(path)
    expect(opened).toMatchObject({ kind: 'sqlplan', content })
    expect(await store.reload(opened.id)).toMatchObject({ kind: 'sqlplan', id: opened.id })

    const ordinary = join(directory, 'ordinary.xml')
    await writeFile(ordinary, header + '<root>' + root + '</root>')
    await expect(store.read(ordinary)).rejects.toThrow('5 MB')
  })
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
  it('uses the value kind limits when registering and refreshing a large saved XML file', async () => {
    const store = new SqlFileStore(), path = join(directory, 'value.xml')
    const content = '<a>' + '\u6f22'.repeat(1_700_000) + '</a>'
    const saved = await store.save(content, undefined, path, 'xml')
    expect((await store.reload(saved.id)).content).toBe(content)
    store.clear()
    const registered = await store.register(path, 'xml')
    expect(registered?.path).toBe(path)
    expect((await store.reload(registered!.id)).content).toBe(content)
    await expect(store.read(path)).rejects.toThrow('SQL files must be smaller than 5 MB.')
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
    const store = new SqlFileStore({ platform: 'win32', realpath: realpathFails })
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
  it('refuses to save through another user\'s link in a shared sticky folder, as Linux\'s protected_symlinks would', async () => {
    expect(protectedLinkRefused({ mode: 0o41777, uid: 0 }, { mode: 0o120777, uid: 2000 }, 1000)).toBe(true)
    // The follower's own link, the folder owner's link, and a folder that is not both sticky and world-writable are followed.
    expect(protectedLinkRefused({ mode: 0o41777, uid: 0 }, { mode: 0o120777, uid: 1000 }, 1000)).toBe(false)
    expect(protectedLinkRefused({ mode: 0o41777, uid: 2000 }, { mode: 0o120777, uid: 2000 }, 1000)).toBe(false)
    expect(protectedLinkRefused({ mode: 0o40777, uid: 0 }, { mode: 0o120777, uid: 2000 }, 1000)).toBe(false)
    expect(protectedLinkRefused({ mode: 0o41775, uid: 0 }, { mode: 0o120777, uid: 2000 }, 1000)).toBe(false)
    // A stand-in for /tmp/link.sql that another user made (links of other owners need root to make): the save writes nothing.
    const link = join(directory, 'link.sql'), target = join(directory, 'target.sql')
    await writeFile(link, 'SELECT 1')
    await writeFile(target, 'SELECT 1')
    const facts = (linkOwner: number) => ({
      platform: 'linux' as const, uid: 1000, folderStat: async () => ({ mode: 0o41777, uid: 0 }),
      lstat: async (path: string) => path === link ? { mode: 0o120777, uid: linkOwner, isSymbolicLink: () => true } : lstat(path),
      readlink: async (path: string) => { if (path !== link) throw new Error(`not a link: ${path}`); return 'target.sql' }
    })
    const store = new SqlFileStore(facts(2000))
    const opened = await store.read(link)
    await expect(store.save('SELECT 2', opened.id)).rejects.toThrow('link.sql goes through a symbolic link another user made in a shared folder')
    await expect(new SqlFileStore(facts(2000)).save('SELECT 2', undefined, link)).rejects.toThrow('another user made')
    await expect(store.readOnly(opened.id)).rejects.toThrow('another user made')
    expect(await readFile(link, 'utf8')).toBe('SELECT 1')
    expect(await readFile(target, 'utf8')).toBe('SELECT 1')
    // Windows has no such rule; the user's own link saves to its target and stays.
    expect((await new SqlFileStore({ ...facts(2000), platform: 'win32' }).save('SELECT 3', undefined, link)).path).toBe(link)
    const own = new SqlFileStore(facts(1000))
    await own.save('SELECT 4', (await own.read(link)).id)
    expect(await readFile(target, 'utf8')).toBe('SELECT 4')
  })
  it('refuses another user\'s link at a folder component too, as the kernel checks every link it follows', async () => {
    // A stand-in for /tmp/shared -> the saver's project folder, made by another user: shared/q.sql is not itself a link.
    const shared = join(directory, 'shared'), project = join(directory, 'project')
    await mkdir(shared)
    await mkdir(project)
    await writeFile(join(project, 'q.sql'), 'SELECT 1')
    const store = new SqlFileStore({
      platform: 'linux', uid: 1000, folderStat: async () => ({ mode: 0o41777, uid: 0 }),
      lstat: async (path: string) => path === shared ? { mode: 0o120777, uid: 2000, isSymbolicLink: () => true } : lstat(path),
      readlink: async (path: string) => { if (path !== shared) throw new Error(`not a link: ${path}`); return project }
    })
    await expect(store.save('SELECT 2', undefined, join(shared, 'q.sql'))).rejects.toThrow('q.sql goes through a symbolic link another user made')
    await expect(store.save('SELECT 2', undefined, join(shared, 'new.sql'))).rejects.toThrow('another user made')
    expect(await readFile(join(project, 'q.sql'), 'utf8')).toBe('SELECT 1')
    expect(await readdir(shared)).toEqual([])
    expect(await readdir(project)).toEqual(['q.sql'])
  })
  it('resolves chained and relative links, folder components included, to where realpath would', async ({ skip }) => {
    await mkdir(join(directory, 'real', 'deep'), { recursive: true })
    const target = join(directory, 'real', 'deep', 'q.sql')
    await writeFile(target, 'SELECT 1')
    try {
      await symlink(join('real', 'deep'), join(directory, 'dir-link'), 'dir')
      await symlink(join('..', 'dir-link', 'q.sql'), join(directory, 'real', 'hop.sql'), 'file')
    } catch { skip() }
    const store = new SqlFileStore({ platform: 'linux', uid: 1000 })
    await store.save('SELECT 2', undefined, join(directory, 'real', 'hop.sql'))
    expect(await readFile(target, 'utf8')).toBe('SELECT 2')
    expect((await lstat(join(directory, 'real', 'hop.sql'))).isSymbolicLink()).toBe(true)
    await store.save('SELECT 3', undefined, join(directory, 'dir-link', 'new.sql'))
    expect(await readFile(join(directory, 'real', 'deep', 'new.sql'), 'utf8')).toBe('SELECT 3')
  })
  it('fails closed when it cannot look at a component of the path', async () => {
    // Linux refuses lstat through a protected link with EACCES; the walk must not read that as "no link here".
    const path = join(directory, 'hidden.sql')
    const store = new SqlFileStore({
      platform: 'linux', uid: 1000, folderStat: async () => ({ mode: 0o40755, uid: 1000 }),
      lstat: async (candidate: string) => {
        if (candidate === path) throw Object.assign(new Error(`EACCES: permission denied, lstat '${candidate}'`), { code: 'EACCES' })
        return lstat(candidate)
      }
    })
    await expect(store.save('SELECT 1', undefined, path)).rejects.toThrow('EACCES')
    expect(await readdir(directory)).toEqual([])
  })
  it('compares the files paths resolve to, wherever links can be made', async () => {
    // A stand-in for a link (Windows makes symbolic links only for administrators or in Developer Mode): realpath maps
    // alias.sql to real.sql, as it would through a link.
    const target = join(directory, 'real.sql'), alias = join(directory, 'alias.sql')
    // Windows' rules: POSIX resolves links itself (`resolveCheckingLinks`), not through realpath.
    const store = new SqlFileStore({ platform: 'win32', realpath: async path => path === alias ? target : path })
    await writeFile(target, 'SELECT 1')
    await writeFile(alias, 'SELECT 1')
    const real = await store.read(target)
    expect(await store.read(alias)).toMatchObject({ id: real.id, path: target })
    const other = await store.save('SELECT 2', undefined, join(directory, 'other.sql'))
    await expect(store.save('SELECT 3', other.id, alias)).rejects.toThrow('real.sql is open in another query tab')
    expect(await readFile(target, 'utf8')).toBe('SELECT 1')
  })
  // The two checks below map alias.sql to another file through an injected realpath. On Windows that is the resolution;
  // on POSIX it names the walk's target (`identity`), as macOS's realpath gives a path its case on disk. #284's walk
  // dropped realpath from POSIX entirely, so both failed on Linux and macOS, and only Windows passed.
  it('resolves each path once in a burst of opens, as a 64-tab restore makes, and again in the next burst', async () => {
    const calls: string[] = []
    let aliasTarget = join(directory, 'tab0.sql')
    const alias = join(directory, 'alias.sql')
    const store = new SqlFileStore({ realpath: async path => { calls.push(path); return path === alias ? aliasTarget : path } })
    const paths = Array.from({ length: 64 }, (_, index) => join(directory, `tab${index}.sql`))
    for (const path of [...paths, alias]) await writeFile(path, 'SELECT 1')
    const restore = store.targets()
    const registered = []
    for (const path of paths) registered.push(await store.register(path, 'sql', undefined, restore))
    expect(new Set(registered.map(file => file?.id)).size).toBe(64)
    // One resolution per file, not one per registered file per open (2,016 for register's two lookups at 64 tabs).
    expect(calls.length).toBeLessThanOrEqual(64)
    expect(await store.read(alias, { targets: restore })).toMatchObject({ id: registered[0]?.id })
    // A later burst resolves again, so a link retargeted since is seen.
    aliasTarget = paths[1]
    calls.length = 0
    expect(await store.read(alias, { targets: store.targets() })).toMatchObject({ id: registered[1]?.id })
    expect(calls).toContain(paths[0])
  })
  it('registers a file and a link to it once when one Open dialog selection reads both at the same time', async () => {
    const target = join(directory, 'real.sql'), alias = join(directory, 'alias.sql')
    // A slow volume: every resolution takes a while, so both reads look for an owner before either has registered.
    const store = new SqlFileStore({ realpath: async path => { await new Promise(done => setTimeout(done, 20)); return path === alias ? target : path } })
    await writeFile(target, 'SELECT 1')
    await writeFile(alias, 'SELECT 1')
    // Another tab is open, so each read resolves paths before it can tell it owns none.
    await writeFile(join(directory, 'open.sql'), 'SELECT 0')
    await store.read(join(directory, 'open.sql'))
    const targets = store.targets()
    const [real, viaAlias, again] = await Promise.all([store.read(target, { targets }), store.read(alias, { targets }), store.read(target, { targets })])
    expect(viaAlias.id).toBe(real.id)
    expect(again.id).toBe(real.id)
    // One registration: a Save As onto either path from another query is refused.
    const other = await store.save('SELECT 2', undefined, join(directory, 'other.sql'))
    await expect(store.save('SELECT 3', other.id, alias)).rejects.toThrow('is open in another query tab')
    // A failed read does not stall the next one.
    await expect(store.read(join(directory, 'missing.sql'))).rejects.toThrow()
    expect((await store.read(target)).id).toBe(real.id)
  })
  it('names one file by its realpath on POSIX after the walk, so macOS\'s other case of a path finds its tab', async () => {
    // A stand-in for a case-insensitive APFS volume: realpath gives each spelling the case on disk, as Darwin's does.
    const real = join(directory, 'Q', 'Report.sql'), other = join(directory, 'q', 'report.sql')
    const folded = (path: string) => path.toLowerCase() === real.toLowerCase() ? real : path
    await mkdir(dirname(real))
    await writeFile(real, 'SELECT 1')
    // On a case-sensitive file system the other spelling is another file with the same text.
    await mkdir(dirname(other), { recursive: true })
    await writeFile(other, 'SELECT 1')
    const store = new SqlFileStore({ platform: 'darwin', uid: 1000, realpath: async path => folded(path) })
    const first = await store.read(real)
    const elsewhere = await store.save('SELECT 2', undefined, join(directory, 'elsewhere.sql'))
    expect(await store.read(other)).toMatchObject({ id: first.id, path: real, name: 'Report.sql' })
    await expect(store.save('SELECT 3', elsewhere.id, other)).rejects.toThrow('Report.sql is open in another query tab')
    // And the other way round: the spelling opened first owns the file.
    store.release(first.id)
    const viaOther = await store.read(other)
    expect(await store.read(real)).toMatchObject({ id: viaOther.id, path: other })
    expect(await readFile(real, 'utf8')).toBe('SELECT 1')
  })
  it('opens two spellings of one file on a case-insensitive volume as one tab, whatever the platform', async ({ skip }) => {
    const real = join(directory, 'Q', 'Report.sql'), other = join(directory, 'q', 'report.sql')
    await mkdir(dirname(real))
    await writeFile(real, 'SELECT 1')
    // macOS's and Windows' default volumes; Linux's are case-sensitive and covered by the stand-in above.
    if (!await stat(other).then(() => true, () => false)) skip()
    const store = new SqlFileStore()
    const first = await store.read(real)
    const elsewhere = await store.save('SELECT 2', undefined, join(directory, 'elsewhere.sql'))
    expect(await store.read(other)).toMatchObject({ id: first.id, path: real })
    await expect(store.save('SELECT 3', elsewhere.id, other)).rejects.toThrow('Report.sql is open in another query tab')
    expect(await readFile(real, 'utf8')).toBe('SELECT 1')
  })
  it('opens a file reached through a link at a folder component, as macOS\'s /var is one, as one tab', async ({ skip }) => {
    // var -> private/var, as macOS's /var (os.tmpdir() is under /var/folders): two spellings of one file.
    const real = join(directory, 'private', 'var', 'folders', 'q.sql'), viaLink = join(directory, 'var', 'folders', 'q.sql')
    await mkdir(dirname(real), { recursive: true })
    await writeFile(real, 'SELECT 1')
    try { await symlink(join('private', 'var'), join(directory, 'var'), 'dir') } catch { skip() }
    const store = new SqlFileStore()
    const first = await store.read(viaLink)
    const elsewhere = await store.save('SELECT 2', undefined, join(directory, 'elsewhere.sql'))
    expect(await store.read(real)).toMatchObject({ id: first.id, path: viaLink })
    await expect(store.save('SELECT 3', elsewhere.id, real)).rejects.toThrow('q.sql is open in another query tab')
    store.release(first.id)
    const direct = await store.read(real)
    expect(await store.read(viaLink)).toMatchObject({ id: direct.id, path: real })
    await expect(store.save('SELECT 3', elsewhere.id, viaLink)).rejects.toThrow('q.sql is open in another query tab')
    expect(await readFile(real, 'utf8')).toBe('SELECT 1')
  })
  it('replaces a dangling link that stands in for one, wherever links can be made', async () => {
    // Stand-ins for gone.sql -> gone/q.sql and kept.sql -> kept/q.sql, with gone/ missing and kept/ empty.
    await mkdir(join(directory, 'kept'))
    const noFolder = join(directory, 'gone.sql'), noFile = join(directory, 'kept.sql')
    const links = new Map([[noFolder, join('gone', 'q.sql')], [noFile, join('kept', 'q.sql')]])
    const store = new SqlFileStore({
      platform: 'linux', uid: 1000, folderStat: async () => ({ mode: 0o40755, uid: 1000 }),
      lstat: async (path: string) => links.has(path) ? { mode: 0o120777, uid: 1000, isSymbolicLink: () => true } : lstat(path),
      readlink: async (path: string) => { const text = links.get(path); if (!text) throw new Error(`not a link: ${path}`); return text }
    })
    for (const link of links.keys()) {
      const saved = await store.save('SELECT 1', undefined, link)
      expect(saved).toMatchObject({ path: link })
      expect(await readFile(link, 'utf8')).toBe('SELECT 1')
      expect(await store.readOnly(saved.id)).toBe(false)
    }
    expect(await readdir(join(directory, 'kept'))).toEqual([])
    expect((await readdir(directory)).sort()).toEqual(['gone.sql', 'kept', 'kept.sql'])
  })
  it('replaces a dangling link with the saved file, as before the walk, whether or not its target\'s folder exists', async ({ skip }) => {
    await mkdir(join(directory, 'kept'))
    const noFolder = join(directory, 'gone.sql'), noFile = join(directory, 'kept.sql'), chained = join(directory, 'chained.sql')
    try {
      await symlink(join('gone', 'q.sql'), noFolder, 'file')
      await symlink(join('kept', 'q.sql'), noFile, 'file')
      // chained.sql -> kept.sql -> kept/q.sql: the link the path names is replaced, not the one it leads to.
      await symlink('kept.sql', chained, 'file')
    } catch { skip() }
    const store = new SqlFileStore({ platform: 'linux', uid: process.getuid?.() ?? 1000 })
    await store.save('SELECT 1', undefined, chained)
    expect((await lstat(chained)).isSymbolicLink()).toBe(false)
    expect(await readFile(chained, 'utf8')).toBe('SELECT 1')
    expect((await lstat(noFile)).isSymbolicLink()).toBe(true)
    for (const link of [noFolder, noFile]) {
      const saved = await store.save('SELECT 2', undefined, link)
      expect(saved).toMatchObject({ path: link })
      expect((await lstat(link)).isSymbolicLink()).toBe(false)
      expect(await readFile(link, 'utf8')).toBe('SELECT 2')
      expect(await store.readOnly(saved.id)).toBe(false)
    }
    // Nothing is written where the links pointed.
    expect(await readdir(join(directory, 'kept'))).toEqual([])
    expect((await readdir(directory)).sort()).toEqual(['chained.sql', 'gone.sql', 'kept', 'kept.sql'])
  })
  // #319: a dangling link is the walk's one result that is still a link, and stat, access and chmod would follow it again.
  it('treats a dangling link as a new file, whatever its target has become since the walk', async () => {
    // A stand-in for alias.sql -> kept/q.sql, with q.sql missing when the walk looks. What following alias.sql finds
    // afterwards is the file standing in for it: read-only, as a file another user made at the link's target can be.
    await mkdir(join(directory, 'kept'))
    const alias = join(directory, 'alias.sql')
    await writeFile(alias, 'SELECT 0')
    await chmod(alias, 0o444)
    const seen: { target: number; saved: number }[] = []
    const store = new SqlFileStore({
      platform: 'linux', uid: 1000, folderStat: async () => ({ mode: 0o40755, uid: 1000 }),
      lstat: async (path: string) => path === alias ? { mode: 0o120777, uid: 1000, isSymbolicLink: () => true } : lstat(path),
      readlink: async (path: string) => { if (path !== alias) throw new Error(`not a link: ${path}`); return join('kept', 'q.sql') },
      // The modes as the rename finds them. A rename replaces a link whatever it names; Windows replaces the file
      // standing in for it only once that is writable.
      replace: async (from, to) => {
        seen.push({ target: (await stat(to)).mode & 0o777, saved: (await stat(from)).mode & 0o777 })
        await chmod(to, 0o644)
        await rename(from, to)
      }
    })
    // Not refused as read-only, and the new file does not take the mode found through the link.
    const saved = await store.save('SELECT 1', undefined, alias)
    expect(saved).toMatchObject({ path: alias, readOnly: false })
    expect(await readFile(alias, 'utf8')).toBe('SELECT 1')
    await chmod(alias, 0o444)
    // Root may write a read-only file, so there the question is no test.
    if (process.getuid?.() !== 0) expect(await isReadOnly(alias)).toBe(true)
    expect(await store.readOnly(saved.id)).toBe(false)
    // Overwrite of a read-only file changes no mode through the link either.
    await store.save('SELECT 2', saved.id, undefined, 'sql', { overwriteReadOnly: true })
    expect(await readFile(alias, 'utf8')).toBe('SELECT 2')
    expect(seen.map(modes => modes.target)).toEqual([0o444, 0o444])
    for (const modes of seen) expect(modes.saved).not.toBe(0o444)
    expect(await readdir(join(directory, 'kept'))).toEqual([])
    expect((await readdir(directory)).sort()).toEqual(['alias.sql', 'kept'])
  })
  // #318: realpath fails on a missing file, so its spellings were compared as written and a Save As found no owner.
  it('refuses Save As onto the missing file that an open dangling link leads to', async () => {
    // Stand-ins for alias.sql -> kept/q.sql and second.sql -> kept/q.sql.
    await mkdir(join(directory, 'kept'))
    const alias = join(directory, 'alias.sql'), second = join(directory, 'second.sql'), target = join(directory, 'kept', 'q.sql')
    await writeFile(alias, 'SELECT 1')
    await writeFile(target, 'SELECT 1')
    const store = new SqlFileStore({
      platform: 'linux', uid: 1000, folderStat: async () => ({ mode: 0o40755, uid: 1000 }),
      lstat: async (path: string) => path === alias || path === second ? { mode: 0o120777, uid: 1000, isSymbolicLink: () => true } : lstat(path),
      readlink: async (path: string) => { if (path !== alias && path !== second) throw new Error(`not a link: ${path}`); return join('kept', 'q.sql') }
    })
    const viaLink = await store.read(alias)
    const other = await store.save('SELECT 2', undefined, join(directory, 'other.sql'))
    // Another program deletes the link's target and leaves its folder: the tab's file is now a dangling link.
    await rm(target)
    await expect(store.save('SELECT 3', other.id, target)).rejects.toThrow('alias.sql is open in another query tab')
    await expect(store.save('SELECT 3', undefined, target)).rejects.toThrow('alias.sql is open in another query tab')
    expect(await readdir(join(directory, 'kept'))).toEqual([])
    // Another dangling link to that missing file is another file: its save replaces that link and writes no target.
    expect(await store.save('SELECT 4', undefined, second)).toMatchObject({ path: second })
    // And the tab's own Save keeps replacing its link.
    expect(await store.save('SELECT 5', viaLink.id)).toMatchObject({ id: viaLink.id, path: alias })
    expect(await readFile(alias, 'utf8')).toBe('SELECT 5')
    expect(await readdir(join(directory, 'kept'))).toEqual([])
  })
  it('names a missing file by its folder, so its other case is the same file where the volume folds case', async () => {
    const real = join(directory, 'Q', 'Report.sql'), other = join(directory, 'q', 'report.sql'), folder = dirname(real)
    await mkdir(folder)
    // On a case-sensitive file system the other spelling's folder is another folder.
    await mkdir(dirname(other), { recursive: true })
    await writeFile(real, 'SELECT 1')
    // A stand-in for realpath on macOS: on a case-insensitive volume every spelling of Q gets its case on disk, on a
    // case-sensitive one only Q itself is there. A missing file fails either way.
    let folds = true, present = true
    const same = (left: string, right: string) => folds ? left.toLowerCase() === right.toLowerCase() : left === right
    const absent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' })
    const store = new SqlFileStore({
      platform: 'darwin', uid: 1000, realpath: async path => {
        if (same(path, folder)) return folder
        if (same(dirname(path), folder)) { if (present && same(basename(path), basename(real))) return real; throw absent(path) }
        if (path.toLowerCase() === folder.toLowerCase()) throw absent(path)
        return path
      }
    })
    const first = await store.read(real)
    const elsewhere = await store.save('SELECT 2', undefined, join(directory, 'elsewhere.sql'))
    // Another program deletes the tab's file.
    await rm(real)
    present = false
    await expect(store.save('SELECT 3', elsewhere.id, other)).rejects.toThrow('Report.sql is open in another query tab')
    expect(await readdir(dirname(other))).toEqual([])
    // Linux's realpath never gives a name another case, so a spelling that resolves to the folder is a link, not folding.
    const linux = new SqlFileStore({ platform: 'linux', uid: 1000, realpath: async path => same(path, folder) ? folder : dirname(path) === folder ? Promise.reject(absent(path)) : path })
    await writeFile(real, 'SELECT 1')
    await linux.read(real)
    await rm(real)
    const upper = join(folder, 'REPORT.sql')
    expect(await linux.save('SELECT 4', undefined, upper)).toMatchObject({ path: upper })
    await rm(upper)
    // On a case-sensitive volume the other case is another file, and is saved.
    folds = false
    expect(await store.save('SELECT 3', elsewhere.id, other)).toMatchObject({ id: elsewhere.id, path: other })
    expect(store.get(first.id).path).toBe(real)
  })
  // #301: one store-wide queue made every read wait for the resolutions of the reads before it.
  it('does not queue a Reload, or an Open of a tab\'s own path, behind another file\'s resolution', async () => {
    const offline = join(directory, 'offline.sql'), changed = join(directory, 'changed.sql'), unrelated = join(directory, 'unrelated.sql')
    for (const path of [offline, changed, unrelated]) await writeFile(path, 'SELECT 1')
    // A stand-in for a share that has gone offline: resolving the file on it does not come back.
    let stuck = false
    const store = new SqlFileStore({ realpath: path => stuck && basename(path) === basename(offline) ? new Promise<string>(() => {}) : Promise.resolve(path) })
    const onShare = await store.read(offline), tab = await store.read(changed)
    stuck = true
    let settled = false
    void store.read(unrelated).then(() => { settled = true }, () => { settled = true })
    await writeFile(changed, 'SELECT 2')
    expect(await store.reload(tab.id)).toMatchObject({ id: tab.id, content: 'SELECT 2' })
    expect(await store.read(changed)).toMatchObject({ id: tab.id, path: changed })
    expect(await store.read(offline)).toMatchObject({ id: onShare.id })
    // The unrelated open is still waiting for the share, and the reads above did not wait for it.
    expect(settled).toBe(false)
  })
  // The restore that #163 names, the Open dialog and the files handed to main (arguments, a second instance, a drop) each
  // share one cache across their burst; a per-file cache would bring back n² resolutions with every check above green.
  it('shares one target cache across every open of a burst in main', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')
    const body = (start: string) => { const from = main.indexOf(start); expect(from, start).toBeGreaterThan(-1); return main.slice(from, main.indexOf('\n}', from)) }
    const restore = main.slice(main.indexOf("handle('varia:session-take'"), main.indexOf("handle('varia:session-restored'"))
    expect(restore.match(/files\.targets\(\)/g)).toHaveLength(1)
    expect(restore.indexOf('files.targets()')).toBeLessThan(restore.indexOf('for (const [index, document]'))
    expect(restore).toContain('reopenDocument(document, targets)')
    const reopen = body('async function reopenDocument(')
    expect(reopen).toMatch(/files\.register\([^)]*, targets\)/)
    expect(reopen).toMatch(/files\.read\(path, \{[^}]*\btargets\b[^}]*\}\)/)
    const launch = body('async function openPaths(')
    expect(launch.indexOf('files.targets()')).toBeGreaterThan(-1)
    expect(launch.indexOf('files.targets()')).toBeLessThan(launch.indexOf('for (const path'))
    expect(launch).toContain('openPath(path, targets)')
    expect(body('async function openPath(')).toContain('files.read(path, { targets })')
    const dialog = main.slice(main.indexOf("title: 'Open SQL query'"), main.indexOf('return opened', main.indexOf("title: 'Open SQL query'")))
    expect(dialog).toMatch(/const targets = files\.targets\(\), opened = await Promise\.all\(selected\.filePaths\.map\(path => files\.read\(path, \{ targets \}\)\)\)/)
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
    // Once it answers, the late comparison still takes a while to settle, as a loaded machine's file system does.
    const store = new SqlFileStore({ stat: async path => { if (slow) { await late; await new Promise(resolve => setTimeout(resolve, 50)) } return stat(path) } })
    const path = join(directory, 'slow.sql')
    await writeFile(path, 'SELECT 1')
    const opened = await store.read(path)
    await writeFile(path, 'SELECT 2')
    await utimes(path, later(10), later(10))
    expect(await store.check({ concurrency: 8, timeoutMs: 20 })).toEqual([])
    // Its answer arrives after the check ended and changes nothing: the change is reported by a check once it settles.
    // Until then checks skip the file, so the wait polls them; had the late answer moved the stamp, none would report it.
    // The polled checks give the file system as long as the wait itself: a check drops a comparison that outlasts its
    // time, and on a loaded runner the default 2 s was shorter than one stat and read took, so no check ever reported it.
    answered()
    slow = false
    await vi.waitFor(async () => expect(await store.check({ concurrency: 2, timeoutMs: 30_000 })).toEqual([{ fileId: opened.id, change: 'modified' }]), { timeout: 30_000, interval: 20 })
    expect(await store.check()).toEqual([])
  }, 45_000)
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
    // Once it answers, the first comparison still takes a while to settle, as a loaded machine's file system does.
    const store = new SqlFileStore({ stat: async path => { if (++calls === 1) { await late; await new Promise(resolve => setTimeout(resolve, 50)) } return stat(path) } })
    const path = join(directory, 'late.sql')
    await writeFile(path, 'SELECT 1')
    const opened = await store.read(path)
    await writeFile(path, 'SELECT 2')
    await utimes(path, later(10), later(10))
    expect(await store.check({ concurrency: 2, timeoutMs: 20 })).toEqual([])
    expect(await store.check({ concurrency: 2, timeoutMs: 20 })).toEqual([])
    expect(calls).toBe(1)
    // Checks skip the file until its comparison settles, then compare it once more.
    answered()
    await vi.waitFor(async () => expect(await store.check()).toEqual([{ fileId: opened.id, change: 'modified' }]), { timeout: 10_000, interval: 20 })
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
  it('keeps the disk baseline for a restored buffer after a check sees a newer version', async () => {
    const store = new SqlFileStore(), path = join(directory, 'pinned.sql')
    await writeFile(path, 'SELECT original')
    const opened = await store.read(path)
    const checkpoint = store.sessionFile(opened.id)!
    await writeFile(path, 'SELECT external changes')
    expect(await store.check()).toEqual([{ fileId: opened.id, change: 'modified' }])
    expect(store.sessionFile(opened.id)).toEqual(checkpoint)

    store.clear()
    const restored = (await store.register(path, 'sql', { baseSha256: checkpoint.fileSha256 }))!
    expect(store.sessionFile(restored.id)).toEqual(checkpoint)
    expect(await store.check()).toEqual([])
    const cancelled = prompts()
    expect(await saveDocument(store, request('SELECT mine', restored.id), undefined, cancelled.value, true)).toBeNull()
    expect(cancelled.asked).toEqual(['changed pinned.sql'])
    expect(await readFile(path, 'utf8')).toBe('SELECT external changes')

    const confirmed = prompts({ changed: true })
    await saveDocument(store, request('SELECT mine', restored.id), undefined, confirmed.value, true)
    expect(confirmed.asked).toEqual(['changed pinned.sql'])
    expect(await readFile(path, 'utf8')).toBe('SELECT mine')
    expect(store.sessionFile(restored.id)?.fileSha256).not.toBe(checkpoint.fileSha256)
    expect(await store.changedOnDisk(restored.id)).toBe(false)
  })
  it('warns with a legacy restored buffer of unknown origin and skips the warning when the file is gone', async () => {
    const store = new SqlFileStore(), path = join(directory, 'pinned.sql')
    await writeFile(path, 'SELECT original')
    const opened = await store.read(path)
    const checkpoint = store.sessionFile(opened.id)!
    store.release(opened.id)
    const matching = (await store.register(path, 'sql', { baseSha256: checkpoint.fileSha256 }))!
    expect(await store.changedOnDisk(matching.id)).toBe(false)
    store.release(matching.id)
    const legacy = (await store.register(path, 'sql', {}))!
    expect(await store.changedOnDisk(legacy.id)).toBe(true)
    await rm(path)
    expect(await store.changedOnDisk(legacy.id)).toBe(false)
    expect(await store.check()).toEqual([{ fileId: legacy.id, change: 'deleted' }])
    expect(await store.changedOnDisk(legacy.id)).toBe(false)
  })
  it('verifies restored file bytes on save when a later external edit preserves the size and timestamp', async () => {
    const store = new SqlFileStore(), path = join(directory, 'pinned.sql'), time = new Date('2026-01-01T00:00:00Z')
    await writeFile(path, 'SELECT 1')
    await utimes(path, time, time)
    const opened = await store.read(path)
    const { fileSha256 } = store.sessionFile(opened.id)!
    store.release(opened.id)
    const restored = (await store.register(path, 'sql', { baseSha256: fileSha256 }))!
    const original = await stat(path)
    await writeFile(path, 'SELECT 2')
    await utimes(path, time, time)
    expect(await stat(path)).toMatchObject({ size: original.size, mtimeMs: original.mtimeMs })
    expect(await store.changedOnDisk(restored.id)).toBe(true)
  })
})
