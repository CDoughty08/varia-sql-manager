import { bundledReleaseNotes, releaseNotesFor } from '../../../shared/releases/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import DocumentFrame, { type FrameSection } from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import { initialFrameState } from '../kit/document-frame'
import { releaseSections } from './ReleaseNotesService'

export default function ReleaseNotes({ documentId }: { readonly documentId: string }) {
  const { releaseNotes, updates, commands } = useWorkbench()
  const { version: requestedVersion, frame } = useServiceSnapshot(releaseNotes), update = useServiceSnapshot(updates)
  const version = requestedVersion ?? (update.currentVersion || undefined)
  const record = releaseNotesFor(version), installed = update.currentVersion
  const sections: FrameSection[] = releaseSections(version).map(section => ({ ...section, content: <div className="release-note-list">
    {record?.changes.filter(change => change.category === section.id).map(change => <section key={change.title} className="release-note"><h3>{change.title}</h3><p>{change.text}</p></section>)}
  </div> }))
  const options = [...new Set([version, installed, ...bundledReleaseNotes.map(note => note.version)].filter((value): value is string => !!value))]
  const installedNotes = installed && releaseNotesFor(installed)
  return <DocumentFrame key={version ?? 'unavailable'} id={documentId} title="Release Notes" subtitle={version ? `Version ${version}` : 'Version unavailable'}
    attributes={{ 'data-release-notes': documentId }}
    tools={<label className="release-note-picker">Release<select aria-label="Release version" value={version ?? ''} onChange={event => releaseNotes.select(event.target.value)}>
      {!version && <option value="">Choose a release</option>}
      {options.map(option => <option key={option} value={option}>{option}{option === installed ? ' — installed' : ''}{releaseNotesFor(option) ? '' : ' — notes unavailable'}</option>)}
    </select></label>}
    verbs={[{ command: 'help.openDownloads', label: 'Release Downloads', icon: 'link-external' }]}
    facts={record ? [{ label: 'Released', value: record.releasedOn }, { label: 'Reading', value: version === installed ? 'Installed version' : 'Release history' }] : []}
    banner={record && <div className="release-note-intro"><p>{record.summary}</p>{!update.enabled && installed && <p className="release-note-build">Development build: these notes describe the published release. Changes made since that release are not included.</p>}</div>}
    sections={record ? sections : undefined} frame={frame.section ? frame : initialFrameState(sections)} onFrame={next => releaseNotes.setFrame(next)}>
    {!record && <EmptyState icon="info" title={version ? `Notes for ${version} are not bundled with this copy` : 'Version information unavailable'}
      detail="You can read bundled releases offline. Missing notes do not affect checking for, downloading or installing an update."
      actions={[
        ...installedNotes ? [{ label: `Read installed version ${installed}`, run: () => releaseNotes.select(installed) }] : [],
        { label: 'Open Release Downloads', run: () => { void commands.execute('help.openDownloads', undefined, 'toolbar') } }
      ]} />}
  </DocumentFrame>
}
