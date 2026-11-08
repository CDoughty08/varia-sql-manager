import { useId, useState } from 'react'
import Icon from '../../Icon'
import { Sheet } from './ConflictSheet'
import type { ImportSummary } from './shortcut-draft'

export type ImportMode = 'merge' | 'replace'
interface Props {
  readonly summary: ImportSummary
  /** What main reported while reading the file (fixed words, never its content). */
  readonly problems: readonly string[]
  readonly onImport: (mode: ImportMode) => void
  readonly onCancel: () => void
}

const plural = (count: number, one: string, many = one + 's') => `${count} ${count === 1 ? one : many}`

/**
 * What an imported file would change, before anything is staged: its counts, the keys it would take from other
 * commands, and Merge or Replace. Imported shortcuts are staged like any edit; OK saves them.
 */
export default function ImportPreview({ summary, problems, onImport, onCancel }: Props) {
  const [mode, setMode] = useState<ImportMode>('merge')
  const name = useId()
  // Either mode can be over main's limits (Replace keeps the draft's unreadable records too), so each is checked.
  const blocked = !summary.fits[mode]
  return <Sheet title="Import shortcuts" role="dialog" onCancel={onCancel} className="shortcuts-import">
    <dl className="shortcuts-facts">
      <div><dt>Shortcuts</dt><dd>{summary.shortcuts}</dd></div>
      <div><dt>New</dt><dd>{summary.added}</dd></div>
      <div><dt>Same as yours</dt><dd>{summary.same}</dd></div>
      <div><dt>Conflicts</dt><dd>{summary.conflicts.length ? <ul>{summary.conflicts.map((conflict, index) => <li key={index}>{conflict.label.text} for {conflict.command} takes it from {conflict.with.join(', ')}</li>)}</ul> : 0}</dd></div>
      {summary.clashes > 0 && <div><dt>Same keys</dt><dd>{plural(summary.clashes, 'entry', 'entries')} {summary.clashes === 1 ? 'takes' : 'take'} a key another of the file's entries has; they will show as problems.</dd></div>}
      {summary.ignored > 0 && <div><dt>Ignored removals</dt><dd>{plural(summary.ignored, 'removal')} of a locked key or one no command has here; they will show as problems.</dd></div>}
      <div><dt>Not understood</dt><dd>{summary.unknown ? `${summary.unknown} (kept in the file)` : 0}</dd></div>
      <div><dt>Gestures</dt><dd>{summary.gestures}</dd></div>
    </dl>
    {problems.length > 0 && <div className="shortcuts-banner" data-kind="warning" role="status"><Icon name="warning" /><div>
      <strong>{plural(problems.length, 'entry', 'entries')} of the file could not be read and will not be imported.</strong>
      <ul>{problems.slice(0, 5).map((problem, index) => <li key={index}>{problem}</li>)}</ul></div></div>}
    <fieldset className="shortcuts-import-mode">
      <legend className="visually-hidden">How to import</legend>
      <label><input type="radio" name={name} checked={mode === 'merge'} onChange={() => setMode('merge')} /><span><strong>Merge</strong>
        <span className="shortcuts-muted">Add the file's shortcuts to yours. Where they conflict, the file's take the key.</span></span></label>
      <label><input type="radio" name={name} checked={mode === 'replace'} onChange={() => setMode('replace')} /><span><strong>Replace</strong>
        <span className="shortcuts-muted">{summary.yours ? `Remove your ${plural(summary.yours, 'change')} first, then apply the file.` : 'Apply the file as it is.'}</span></span></label>
    </fieldset>
    {blocked && <p className="shortcuts-message" data-kind="refused" role="alert">{mode === 'merge' ? 'Together they' : 'The file and your unreadable records'} would be more than a shortcuts file may hold.{mode === 'merge' && summary.fits.replace ? ' Choose Replace, or remove some first.' : ' Remove some first.'}</p>}
    <p className="shortcuts-muted">Imported shortcuts are staged like any change: review them, then choose OK.</p>
    <div className="shortcuts-sheet-actions">
      <button type="button" className="primary" autoFocus disabled={blocked} onClick={() => onImport(mode)}>Import</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </Sheet>
}
