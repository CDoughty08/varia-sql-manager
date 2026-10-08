import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { SqlFileStore } from '../src/main/sql-files'

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
})
