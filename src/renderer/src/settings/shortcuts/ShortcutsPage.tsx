import { useMemo, useState, type KeyboardEvent } from 'react'
import type { ApiResult } from '../../../../shared/contracts'
import type { CommandId } from '../../../../shared/commands/catalog'
import { effectiveRules } from '../../../../shared/commands/effective'
import { platforms as allPlatforms, type Platform } from '../../../../shared/commands/keybindings'
import { shortcutSchemes } from '../../../../shared/commands/schemes'
import { shortcutFileSchema, type ShortcutFile } from '../../../../shared/commands/shortcut-schema'
import Icon from '../../Icon'
import { Chip, ChipGroup } from '../../kit/Chip'
import Segmented from '../../kit/Segmented'
import CaptureField, { KeyCaps, type CaptureSource } from './CaptureField'
import { Sheet } from './ConflictSheet'
import { gestureRows } from './gesture-rows'
import ImportPreview, { type ImportMode } from './ImportPreview'
import Inspector, { captureFieldId } from './Inspector'
import MouseView from './MouseView'
import {
  commandRows, draftProblems, importSummary, mergeImport, removeEntries, replaceImport, resetAll, resetAllCounts, resetRow, stagedChanges, type CommandRow, type ImportSummary
} from './shortcut-draft'
import { chipCounts, chipTokens, commandCount, filterShortcutRows, hasToken, isEmptyQuery, parseShortcutQuery, shortcutSearchChars, showsKind, toggleToken, type ChipToken } from './shortcuts-search'
import ShortcutTable, { platformTitles, selectionKey, type ShortcutSelection } from './ShortcutTable'

/** Main's file dialogs, through `ShortcutsService`: Import reads and validates a file without saving it; Export writes one. */
export interface ShortcutsFileApi {
  importFile(): Promise<ApiResult<{ readonly cancelled: true } | { readonly file: ShortcutFile; readonly problems: readonly string[] }>>
  exportFile(file: ShortcutFile): Promise<ApiResult<{ readonly cancelled: boolean }>>
}
export type ShortcutsView = 'all' | 'keyboard' | 'mouse'

interface Props {
  /** The staged file: every edit here makes a new one, which OK saves. */
  readonly draft: ShortcutFile
  /** Main's file, for the staged count. */
  readonly stored: ShortcutFile
  readonly onChange: (next: ShortcutFile) => void
  readonly platform: Platform
  readonly files: ShortcutsFileApi
  readonly capture?: CaptureSource
  /** Main set part of the file aside when it read it: the fixed notice to show once. */
  readonly salvaged?: string
}

const chipTitles: Readonly<Record<ChipToken, string>> = { modified: 'Modified', conflicts: 'Conflicts', unbound: 'Unbound' }
const plural = (count: number, one: string, many = one + 's') => `${count} ${count === 1 ? one : many}`
const salvageText = 'Some shortcuts could not be read. Varia kept the valid ones and moved the original file aside. Nothing else changed.'

type SheetState =
  | { readonly kind: 'resetAll'; readonly everywhere: boolean }
  | { readonly kind: 'import'; readonly file: ShortcutFile; readonly summary: ImportSummary; readonly problems: readonly string[] }
  | { readonly kind: 'refused'; readonly message: string }

/**
 * Tools › Options › Environment › Shortcuts: SSMS's Keyboard page with Varia's mouse gestures. A segmented control shows
 * All, Keyboard or Mouse; the scheme row holds Import, Export and Reset All; the search box takes words, `@` tokens and
 * Record Keys; the table lists every command with its shortcuts, and the inspector below edits the selected one.
 * Every change is staged in `draft` until OK.
 */
export default function ShortcutsPage({ draft, stored, onChange, platform, files, capture, salvaged }: Props) {
  const [view, setView] = useState<ShortcutsView>('all')
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState(false)
  const [record, setRecord] = useState<readonly string[]>([])
  const [byPlatform, setByPlatform] = useState(false)
  const [builtInOpen, setBuiltInOpen] = useState(false)
  const [selected, setSelected] = useState<ShortcutSelection>()
  const [sheet, setSheet] = useState<SheetState>()
  const [notice, setNotice] = useState<{ readonly kind: 'info' | 'error'; readonly text: string }>()
  const [showSalvage, setShowSalvage] = useState(true)
  const [busy, setBusy] = useState(false)

  const effective = effectiveRules(platform, draft)
  const rows = useMemo(() => commandRows(draft, platform, effective), [draft, platform, effective])
  const parsed = parseShortcutQuery(query)
  const groups = filterShortcutRows(rows, query, recording && record.length ? record : undefined)
  const gestures = view === 'all' && showsKind(parsed, 'mouse') && !(recording && record.length) && !parsed.tokens.some(token => token.name !== 'kind') ? gestureRows(draft, platform, query) : []
  const platformRows = useMemo(() => byPlatform ? Object.fromEntries(allPlatforms.map(item => [item, new Map(commandRows(draft, item).map(row => [row.id, row]))])) as unknown as Record<Platform, ReadonlyMap<CommandId, CommandRow>> : undefined, [byPlatform, draft])
  const counts = chipCounts(rows)
  const problems = draftProblems(draft, platform, effective)
  const shownCommands = commandCount(groups)
  const order = groups.flatMap(group => group.rows)
  const current = (selected && order.find(match => selectionKey({ command: match.row.id, index: match.binding ? match.row.bindings.indexOf(match.binding) : -1 }) === selectionKey(selected))) ?? order[0]
  const filtering = !isEmptyQuery(parsed) || (recording && record.length > 0)

  const clearFilters = () => { setQuery(''); setRecord([]); setRecording(false) }
  const searchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // As in Options' own search box: Escape clears the text first, and Enter or Down goes to the results.
    if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery('') }
    else if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault(); event.stopPropagation()
      document.querySelector<HTMLElement>('.shortcuts-table [data-row][tabindex="0"]')?.focus()
    }
  }
  const startImport = async () => {
    if (busy) return
    setBusy(true); setNotice(undefined)
    try {
      const result = await files.importFile()
      if (!result.ok) { setSheet({ kind: 'refused', message: result.error }); return }
      if ('cancelled' in result.value) return
      const checked = shortcutFileSchema.safeParse(result.value.file)
      if (!checked.success) { setSheet({ kind: 'refused', message: 'It is not a Varia shortcuts file.' }); return }
      const file = checked.data as ShortcutFile
      setSheet({ kind: 'import', file, summary: importSummary(draft, file, platform), problems: result.value.problems })
    } finally { setBusy(false) }
  }
  const finishImport = (file: ShortcutFile, mode: ImportMode) => {
    onChange(mode === 'merge' ? mergeImport(draft, file, platform) : replaceImport(draft, file))
    setSheet(undefined)
  }
  const startExport = async () => {
    if (busy) return
    setBusy(true); setNotice(undefined)
    try {
      const result = await files.exportFile(draft)
      if (!result.ok) setNotice({ kind: 'error', text: `The shortcuts could not be exported: ${result.error.replace(/\.$/, '')}.` })
      else if (!result.value.cancelled) setNotice({ kind: 'info', text: `Exported ${plural(draft.bindings.length, 'shortcut')} and ${plural(Object.keys(draft.gestures).length, 'gesture')} to the file you chose. Defaults are not written: the file holds only your changes and its scheme.` })
    } finally { setBusy(false) }
  }
  const reset = resetAllCounts(draft, platform)
  const staged = stagedChanges(draft, stored)

  return <div className="shortcuts-page">
    <div className="shortcuts-head">
      <div><h4 className="shortcuts-title">Keyboard and mouse shortcuts</h4><p className="shortcuts-muted">Changes apply when you choose OK. A shortcut works in its scope; a narrower scope wins over Global.</p></div>
      <span id="shortcuts-view-label" className="visually-hidden">Show</span>
      <Segmented id="shortcuts-view" labelledBy="shortcuts-view-label" value={view} onChange={value => setView(value as ShortcutsView)}
        segments={[{ value: 'all', label: 'All' }, { value: 'keyboard', label: 'Keyboard' }, { value: 'mouse', label: 'Mouse' }]} />
    </div>
    {salvaged !== undefined && showSalvage && <div className="shortcuts-banner" data-kind="info" role="status"><Icon name="info" /><div>{salvaged || salvageText}</div>
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setShowSalvage(false)}><Icon name="close" /></button></div>}
    {problems.length > 0 && <div className="shortcuts-banner" data-kind="warning" role="status"><Icon name="warning" /><div>
      <strong>{problems.length === 1 ? '1 shortcut no longer applies.' : `${problems.length} shortcuts no longer apply.`}</strong> They stay in the file until you remove them.
      <ul>{problems.slice(0, 5).map(problem => <li key={problem.index}>{problem.label ? <KeyCaps label={problem.label} /> : <code>{problem.binding.key}</code>} for {problem.binding.command}: {problem.message}</li>)}</ul>
    </div><button type="button" onClick={() => onChange(removeEntries(draft, problems.map(problem => problem.index)))}>Remove</button></div>}
    {notice && <div className="shortcuts-banner" data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}><Icon name={notice.kind === 'error' ? 'error' : 'pass'} /><div>{notice.text}</div>
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNotice(undefined)}><Icon name="close" /></button></div>}
    <div className="shortcuts-scheme">
      <label htmlFor="shortcuts-scheme">Mapping scheme:</label>
      <select id="shortcuts-scheme" value={draft.scheme} onChange={event => onChange({ ...draft, scheme: event.target.value })}>
        {shortcutSchemes.map(scheme => <option key={scheme.id} value={scheme.id}>{scheme.title}</option>)}
        {!shortcutSchemes.some(scheme => scheme.id === draft.scheme) && <option value={draft.scheme}>{draft.scheme} (not in this version)</option>}
      </select>
      <span />
      <button type="button" disabled={busy} onClick={() => void startImport()}><Icon name="folder-opened" />Import…</button>
      <button type="button" disabled={busy} onClick={() => void startExport()}><Icon name="export" />Export…</button>
      <button type="button" disabled={!reset.here && !reset.elsewhere && !reset.gestures} onClick={() => setSheet({ kind: 'resetAll', everywhere: false })}><Icon name="discard" />Reset All…</button>
    </div>
    <div className="shortcuts-toolbar">
      <div className="shortcuts-search" data-recording={recording || undefined}>
        <Icon name="search" />
        {recording
          ? <CaptureField id="shortcuts-record" platform={platform} value={record} onChange={setRecord} capture={capture} label="Record keys" autoFocus className="shortcuts-search-input"
            placeholder="Press a shortcut… (Escape and Enter are recorded too; Tab leaves)" />
          : <input type="search" className="shortcuts-search-input" aria-label="Search shortcuts" maxLength={shortcutSearchChars} value={query}
            placeholder="Search shortcuts: try @modified, @scope:editor, @source:user" onChange={event => setQuery(event.target.value)} onKeyDown={searchKeyDown} />}
      </div>
      <button type="button" aria-pressed={recording} title="Record Keys: filter by the exact shortcut you press" onClick={() => { setRecording(!recording); setRecord([]) }}><Icon name="record-keys" />Record Keys</button>
    </div>
    {view !== 'mouse' && <div className="shortcuts-toolbar">
      <ChipGroup label="Filters">
        {chipTokens.map(token => <Chip key={token} label={chipTitles[token]} count={counts[token]} pressed={hasToken(query, token)} onToggle={() => setQuery(toggleToken(query, token))} />)}
      </ChipGroup>
      <label className="shortcuts-check"><input type="checkbox" checked={byPlatform} onChange={event => setByPlatform(event.target.checked)} />Show other platforms</label>
      <span className="shortcuts-count" role="status">{plural(shownCommands, 'command')}{byPlatform ? ` · ${allPlatforms.map(item => platformTitles[item]).join(', ')}` : ''}</span>
    </div>}
    {view === 'mouse'
      ? <MouseView draft={draft} onChange={onChange} platform={platform} search={query} />
      : <>
        <ShortcutTable groups={groups} platform={platform} gestures={gestures} onShowMouse={() => setView('mouse')}
          selected={current ? { command: current.row.id, index: current.binding ? current.row.bindings.indexOf(current.binding) : -1 } : undefined}
          onSelect={setSelected} onActivate={() => document.getElementById(captureFieldId)?.focus()} onReset={binding => onChange(resetRow(draft, binding))}
          builtIn={filtering ? undefined : { open: builtInOpen, onToggle: () => setBuiltInOpen(!builtInOpen) }}
          byPlatform={platformRows}
          empty={<><div>{recording && record.length ? 'No shortcut uses those keys.' : 'No shortcuts match.'}</div><button type="button" className="shortcuts-link" onClick={clearFilters}>Clear filters</button></>} />
        {current && <Inspector key={current.row.id} row={current.row} draft={draft} platform={platform} onChange={onChange} capture={capture} />}
      </>}
    <span className="visually-hidden" role="status">{staged ? `${plural(staged, 'shortcut change')} staged` : ''}</span>
    {sheet?.kind === 'resetAll' && <Sheet title="Reset all shortcuts?" onCancel={() => setSheet(undefined)}>
      <p>This removes your {plural(reset.here, 'change')} on {platformTitles[platform]} and restores SSMS's defaults.{reset.gestures ? ' Mouse gestures reset too.' : ''}{reset.elsewhere && !sheet.everywhere ? ` ${plural(reset.elsewhere, 'entry', 'entries')} for other platforms stay in the file.` : ''}</p>
      {reset.elsewhere > 0 && <label className="shortcuts-check"><input type="checkbox" checked={sheet.everywhere} onChange={event => setSheet({ kind: 'resetAll', everywhere: event.target.checked })} />Also remove entries for other platforms</label>}
      <p className="shortcuts-muted">Nothing changes until you choose OK in Options.</p>
      <div className="shortcuts-sheet-actions">
        <button type="button" className="primary" autoFocus onClick={() => { onChange(resetAll(draft, platform, sheet.everywhere)); setSheet(undefined) }}>Reset All</button>
        <button type="button" onClick={() => setSheet(undefined)}>Cancel</button>
      </div>
    </Sheet>}
    {sheet?.kind === 'import' && <ImportPreview summary={sheet.summary} problems={sheet.problems} onImport={mode => finishImport(sheet.file, mode)} onCancel={() => setSheet(undefined)} />}
    {sheet?.kind === 'refused' && <Sheet title="This file cannot be imported" onCancel={() => setSheet(undefined)}>
      <p className="shortcuts-message" data-kind="refused"><Icon name="error" /><span>{sheet.message} Nothing was changed.</span></p>
      <div className="shortcuts-sheet-actions"><button type="button" className="primary" autoFocus onClick={() => setSheet(undefined)}>OK</button></div>
    </Sheet>}
  </div>
}
