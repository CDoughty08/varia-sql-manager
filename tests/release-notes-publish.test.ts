import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { releaseNotesMarkdown, releaseNotesSchema, type ReleaseNotes } from '../src/shared/releases/schema'
import { releaseRecord } from './fixtures/releases'
// @ts-expect-error The publishing script is plain JavaScript without declarations.
import { loadReleaseArchive, loadReleaseNotes, releaseNotesFileBytes, syncPublishedChangelog } from '../scripts/release-notes.mjs'

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function project(record: ReleaseNotes = releaseRecord()) {
  await mkdir('artifacts', { recursive: true })
  const folder = await mkdtemp(join(resolve('artifacts'), 'release-publish-test-'))
  folders.push(folder)
  await mkdir(join(folder, 'release-notes'))
  await writeFile(join(folder, 'package.json'), JSON.stringify({ version: record.version }))
  await writeFile(join(folder, 'release-notes', `${record.version}.json`), JSON.stringify(record))
  return folder
}
const changelog = (record: ReleaseNotes) => '# Changelog\n\n## [Unreleased]\n\n- A pending change.\n\n' +
  `## [${record.version}] - ${record.releasedOn}\n\nOld prose.\n\n## Earlier releases\n\nOlder history.\n\n[Unreleased]: old\n`

describe('curated release publication', () => {
  it('regenerates published changelog content while preserving Unreleased and the older-history link', async () => {
    const record = releaseRecord(), root = await project(record)
    const prefix = '# Changelog\n\n## [Unreleased]\n\n- A pending change.\n'
    await writeFile(join(root, 'CHANGELOG.md'), changelog(record))
    await syncPublishedChangelog(root)
    const output = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
    expect(output.startsWith(prefix)).toBe(true)
    expect(output).toContain('Older history.')
    expect(output).not.toContain('Old prose.')
    expect(output).toContain(releaseNotesMarkdown(record, 'changelog').trimEnd())
    await syncPublishedChangelog(root)
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toBe(output)
  })
  it('reads exactly the requested tag using version-independent fixtures', async () => {
    const record = releaseRecord()
    expect(await loadReleaseNotes(`v${record.version}`, await project(record))).toEqual(record)
  })
  it('cuts a subsequent release using data and package metadata while preserving history and Unreleased', async () => {
    const previous = releaseRecord(), next = { ...releaseRecord('2.0.0'), summary: 'Different highlights for a subsequent release.' }
    const root = await project(previous), previousPath = join(root, 'release-notes', `${previous.version}.json`)
    const previousBytes = await readFile(previousPath)
    await writeFile(join(root, 'CHANGELOG.md'), changelog(previous))
    await writeFile(join(root, 'release-notes', `${next.version}.json`), JSON.stringify(next))
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: next.version }))
    await syncPublishedChangelog(root)
    expect(await loadReleaseNotes(`v${next.version}`, root)).toEqual(next)
    expect(await loadReleaseArchive(root)).toEqual([next, previous])
    expect(await readFile(previousPath)).toEqual(previousBytes)
    const output = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
    expect(output).toContain('- A pending change.')
    for (const record of [next, previous]) expect(output).toContain(releaseNotesMarkdown(record, 'changelog').trimEnd())
    expect(output).toContain(`/compare/v${next.version}...HEAD`)
  })
  it('rejects swapped filenames even when the filename and internal-version sets still match', async () => {
    const first = releaseRecord(), second = releaseRecord('2.0.0'), root = await project(first)
    await writeFile(join(root, 'release-notes', `${first.version}.json`), JSON.stringify(second))
    await writeFile(join(root, 'release-notes', `${second.version}.json`), JSON.stringify(first))
    await expect(loadReleaseArchive(root)).rejects.toThrow('record must match')
  })
  it('applies the publishing byte limit to valid JSON in the archive', async () => {
    const record = releaseRecord(), root = await project(record)
    const padded = JSON.stringify(record) + ' '.repeat(releaseNotesFileBytes + 1)
    expect(releaseNotesSchema.safeParse(JSON.parse(padded)).success).toBe(true)
    await writeFile(join(root, 'release-notes', `${record.version}.json`), padded)
    await expect(loadReleaseArchive(root)).rejects.toThrow('size limit')
  })
  it('refuses package/tag mismatch, missing notes, version mismatch, HTML and oversized files', async () => {
    const record = releaseRecord(), root = await project(record), tag = `v${record.version}`, path = join(root, 'release-notes', `${record.version}.json`)
    await expect(loadReleaseNotes('v2.0.0', root)).rejects.toThrow('tag must match')
    await expect(loadReleaseNotes('../../private', root)).rejects.toThrow()
    await writeFile(path, JSON.stringify({ ...record, version: '2.0.0' }))
    await expect(loadReleaseNotes(tag, root)).rejects.toThrow('record must match')
    await writeFile(path, JSON.stringify({ ...record, summary: '<script>bad()</script>' }))
    await expect(loadReleaseNotes(tag, root)).rejects.toThrow('plain text')
    await writeFile(path, 'x'.repeat(releaseNotesFileBytes + 1))
    await expect(loadReleaseNotes(tag, root)).rejects.toThrow('size limit')
    await rm(path)
    await expect(loadReleaseNotes(tag, root)).rejects.toThrow()
  })
})
