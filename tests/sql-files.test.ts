import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileKinds, saveFileSchema, SqlFileStore } from '../src/main/sql-files'

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
    await expect(store.save('replacement', opened.id, directory)).rejects.toThrow()
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
