import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { bundledReleaseNotes, releaseNotesFor } from '../src/shared/releases/catalog'
import { releaseNotesMarkdown, releaseNotesSchema } from '../src/shared/releases/schema'
import { ReleaseNotesService } from '../src/renderer/src/release-notes/ReleaseNotesService'
import ReleaseNotes from '../src/renderer/src/release-notes/ReleaseNotes'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { documentFixture } from './fixtures/documents'
import { workbenchFixture } from './fixtures/workbench'
import { releaseRecord } from './fixtures/releases'
// @ts-expect-error The publishing script is plain JavaScript without declarations.
import { loadReleaseArchive, loadReleaseNotes } from '../scripts/release-notes.mjs'

describe('published release content', () => {
  it('validates the checked-in archive through the publishing loader and bundles the same records', async () => {
    const archive = await loadReleaseArchive()
    expect(archive).toEqual(bundledReleaseNotes)
    expect(new Set(bundledReleaseNotes.map(record => record.version)).size).toBe(archive.length)
    const changelog = readFileSync('CHANGELOG.md', 'utf8')
    for (const record of bundledReleaseNotes) expect(changelog).toContain(releaseNotesMarkdown(record, 'changelog').trimEnd())
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(await loadReleaseNotes(`v${version}`)).toEqual(releaseNotesFor(version))
    expect(releaseNotesFor('Unreleased')).toBeUndefined()
    expect(releaseNotesFor('99.0.0')).toBeUndefined()
    expect(releaseNotesFor(undefined)).toBeUndefined()
  })
  it('refuses HTML, control characters, unknown fields, invalid dates and duplicate titles', () => {
    const record = releaseRecord(), change = record.changes[0]
    for (const text of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'bad\u0000text', 'x'.repeat(1601)])
      expect(releaseNotesSchema.safeParse({ ...record, changes: [{ ...change, text }] }).success).toBe(false)
    for (const value of [{ ...record, url: 'https://example.com' }, { ...record, releasedOn: '2026-02-30' }, { ...record, version: '../../private' }, { ...record, changes: [change, change] }])
      expect(releaseNotesSchema.safeParse(value).success).toBe(false)
  })
  it('exports the same reviewed content and escapes Markdown links and formatting', () => {
    const record = releaseRecord()
    const markdown = releaseNotesMarkdown(record)
    expect(markdown).toContain(`# Varia SQL Manager ${record.version}`)
    expect(markdown).toContain('An update for everyday work\\.')
    const injected = releaseNotesSchema.parse({ ...record, changes: [{ ...record.changes[0], text: '[Open](javascript:alert(1)) **bold**' }] })
    expect(releaseNotesMarkdown(injected)).toContain('\\[Open\\]\\(javascript:alert\\(1\\)\\) \\*\\*bold\\*\\*')
  })
})

describe('read-only release document', () => {
  it('preserves the selected section on same-version requests and resets it when switching versions or reopening a closed tab', async () => {
    const fixture = documentFixture(), service = new ReleaseNotesService(fixture.documents, () => '0.8.0', vi.fn())
    service.open()
    const id = service.getSnapshot().documentId!, frame = { ...service.getSnapshot().frame, section: 'limits' }
    service.setFrame(frame)
    service.open()
    expect(service.getSnapshot().frame).toBe(frame)
    service.open('0.8.0')
    expect(service.getSnapshot().frame).toBe(frame)
    service.select('0.7.0')
    expect(service.getSnapshot().frame.section).toBe('added')
    service.setFrame({ ...service.getSnapshot().frame, section: 'limits' })
    await fixture.documents.close(id)
    service.open('0.7.0')
    expect(service.getSnapshot().frame.section).toBe('added')
    service.dispose(); fixture.documents.dispose()
  })
  it('preserves a section chosen after delayed running-version information arrives', () => {
    const fixture = documentFixture()
    let runningVersion = ''
    const service = new ReleaseNotesService(fixture.documents, () => runningVersion, vi.fn())
    service.open()
    runningVersion = '0.8.0'
    const frame = { ...service.getSnapshot().frame, section: 'limits' }
    service.setFrame(frame)
    service.open()
    expect(service.getSnapshot()).toMatchObject({ version: '0.8.0', frame })
    expect(service.getSnapshot().frame).toBe(frame)
    service.dispose(); fixture.documents.dispose()
  })
  it('reuses one tab with no SQL model, saving, connection or session and releases its selection on close', async () => {
    const fixture = documentFixture(), focus = vi.fn()
    const service = new ReleaseNotesService(fixture.documents, () => '0.8.0', focus)
    service.open()
    const id = service.getSnapshot().documentId!
    expect(fixture.documents.get(id)).toMatchObject({ kind: 'releaseNotes', dirty: false, connectionId: undefined })
    expect(fixture.models.size).toBe(0)
    expect(fixture.documents.savable(id)).toBe(false)
    expect(fixture.documents.inSaveAll(id)).toBe(false)
    expect(fixture.documents.follows(id, 'private-server')).toBe(false)
    service.select('0.7.0')
    expect(service.getSnapshot()).toMatchObject({ documentId: id, version: '0.7.0' })
    expect(fixture.documents.getSnapshot().documents).toHaveLength(1)
    await fixture.documents.close(id)
    expect(service.getSnapshot().documentId).toBeUndefined()
    expect(fixture.api.closeQuerySession).not.toHaveBeenCalled()
    service.open('99.0.0')
    expect(service.getSnapshot()).toMatchObject({ version: '99.0.0' })
    expect(service.getSnapshot().documentId).not.toBe(id)
    expect(() => service.open('../../private')).toThrow()
    service.dispose(); fixture.documents.dispose()
  })
  it('keeps missing running-version information distinct from a published release', () => {
    const fixture = documentFixture(), service = new ReleaseNotesService(fixture.documents, () => '', vi.fn())
    service.open()
    expect(service.getSnapshot().version).toBeUndefined()
    service.dispose(); fixture.documents.dispose()
  })
  it('renders exact-version notes and an honest unavailable state without substituting older content', async () => {
    const fixture = workbenchFixture()
    await Promise.resolve()
    const render = () => renderToStaticMarkup(createElement(WorkbenchProvider, { workbench: fixture as unknown as Workbench, children: createElement(ReleaseNotes, { documentId: fixture.releaseNotes.getSnapshot().documentId! }) }))
    fixture.api.pushUpdate({ currentVersion: '', kind: 'unsupported', enabled: false, status: 'idle' })
    fixture.releaseNotes.open()
    expect(render()).toContain('Version information unavailable')
    fixture.api.pushUpdate({ currentVersion: '0.8.0', kind: 'nsis', enabled: true, status: 'idle' })
    expect(render()).toContain('SQL IntelliSense')
    expect(render()).toContain('Installed version')
    fixture.api.pushUpdate({ currentVersion: '0.8.0', kind: 'unsupported', enabled: false, status: 'idle' })
    expect(render()).toContain('Development build: these notes describe the published release')
    fixture.releaseNotes.open('99.0.0')
    const unavailable = render()
    expect(unavailable).toContain('Notes for 99.0.0 are not bundled with this copy')
    expect(unavailable).toContain('Read installed version 0.8.0')
    expect(unavailable).not.toContain('SQL IntelliSense')
    fixture.dispose()
  })
})
