import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { bundledReleaseNotes } from '../src/shared/releases/catalog'
// @ts-expect-error The publishing script is plain JavaScript without declarations.
import { loadReleaseNotes, syncPublishedChangelog } from '../scripts/release-notes.mjs'

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function project(record: unknown = bundledReleaseNotes[0]) {
  await mkdir('artifacts', { recursive: true })
  const folder = await mkdtemp(join(resolve('artifacts'), 'release-publish-test-'))
  folders.push(folder)
  await mkdir(join(folder, 'release-notes'))
  await writeFile(join(folder, 'package.json'), JSON.stringify({ version: '0.8.0' }))
  await writeFile(join(folder, 'release-notes', '0.8.0.json'), JSON.stringify(record))
  return folder
}

describe('curated release publication', () => {
  it('regenerates published changelog content while preserving Unreleased and the older-history link', async () => {
    const root = await project()
    const prefix = '# Changelog\n\n## [Unreleased]\n\n- A pending change.\n'
    await writeFile(join(root, 'CHANGELOG.md'), prefix + '\n## [0.8.0] - 2026-11-10\n\nOld prose.\n\n## Earlier releases\n\nOlder history.\n\n[Unreleased]: old\n')
    await syncPublishedChangelog(root)
    const output = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
    expect(output.startsWith(prefix)).toBe(true)
    expect(output).toContain('Older history.')
    expect(output).not.toContain('Old prose.')
    expect(output).toContain('**SQL IntelliSense:**')
    await syncPublishedChangelog(root)
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toBe(output)
  })
  it('reads exactly the requested tag and the same validated record the application bundles', async () => {
    expect(await loadReleaseNotes('v0.8.0', await project())).toEqual(bundledReleaseNotes[0])
  })
  it('refuses package/tag mismatch, missing notes, version mismatch, HTML and oversized files', async () => {
    const root = await project()
    await expect(loadReleaseNotes('v0.9.0', root)).rejects.toThrow('tag must match')
    await expect(loadReleaseNotes('../../private', root)).rejects.toThrow()
    await writeFile(join(root, 'release-notes', '0.8.0.json'), JSON.stringify({ ...bundledReleaseNotes[0], version: '0.7.0' }))
    await expect(loadReleaseNotes('v0.8.0', root)).rejects.toThrow('record must match')
    await writeFile(join(root, 'release-notes', '0.8.0.json'), JSON.stringify({ ...bundledReleaseNotes[0], summary: '<script>bad()</script>' }))
    await expect(loadReleaseNotes('v0.8.0', root)).rejects.toThrow('plain text')
    await writeFile(join(root, 'release-notes', '0.8.0.json'), 'x'.repeat(131073))
    await expect(loadReleaseNotes('v0.8.0', root)).rejects.toThrow('size limit')
    await rm(join(root, 'release-notes', '0.8.0.json'))
    await expect(loadReleaseNotes('v0.8.0', root)).rejects.toThrow()
  })
})
