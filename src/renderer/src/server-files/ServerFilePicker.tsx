import { useEffect, useId, useMemo, type KeyboardEvent } from 'react'
import { actionLimits, allFilesType, serverFileTypesLabel } from '../../../shared/actions/catalog.ts'
import { explorerLimits } from '../../../shared/explorer/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import SubDialog from '../dialogs/SubDialog'
import Icon from '../Icon'
import {
  defaultTags, formatFree, formatModified, formatSize, pickerMessages, pickerRows, pickerStatus, selectedFolder, type OpenServerFilePicker, type PickerRow, type ServerFilePickerService
} from './ServerFilePickerService'

/** The open server file picker, if any (ServerFilePickerService.pick opens it from a dialog's "…" button). */
export default function ServerFilePicker() {
  const { serverFiles } = useWorkbench()
  const { open } = useServiceSnapshot(serverFiles)
  return open ? <PickerDialog key={open.id} open={open} service={serverFiles} /> : null
}

type ItemRow = Extract<PickerRow, { type: 'item' }>

/**
 * SSMS's Locate Backup File and its siblings: a "Select the file" tree of the server's drives and default folders with
 * Size and Modified columns, then Selected path, Files of type and File name. Enter on a folder expands it and on a file
 * chooses it; a typed path (or a share) goes there on OK. Escape cancels, and focus returns to the "…" button.
 */
function PickerDialog({ open, service }: { open: OpenServerFilePicker; service: ServerFilePickerService }) {
  const id = useId()
  const treeId = `${id}-tree`
  const rows = useMemo(() => pickerRows(open), [open])
  const items = useMemo(() => rows.flatMap((row, index) => row.type === 'item' ? [{ row, index }] : []), [rows])
  const active = items.findIndex(item => item.row.path === open.selected)
  const rowId = (index: number) => `${id}-row-${index}`
  const busy = !!open.rootsSlow || rows.some(row => row.type === 'note' && row.tone === 'busy' && row.slow)
  const types = serverFileTypesLabel(open.purpose)

  useEffect(() => {
    if (active >= 0) document.getElementById(`${id}-row-${items[active].index}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, items, id])

  const move = (to: number) => { const item = items[Math.max(0, Math.min(items.length - 1, to))]; if (item) service.select(item.row.path) }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = active >= 0 ? items[active].row : undefined
    switch (event.key) {
      case 'ArrowDown': move(active + 1); break
      case 'ArrowUp': move(active < 0 ? 0 : active - 1); break
      case 'Home': move(0); break
      case 'End': move(items.length - 1); break
      case 'ArrowRight':
        if (!current?.directory) break
        if (!current.expanded) service.toggle(current.path)
        else if (items[active + 1]?.row.level > current.level) move(active + 1)
        break
      case 'ArrowLeft': {
        if (!current) break
        if (current.directory && current.expanded) { service.toggle(current.path); break }
        const parent = items.slice(0, active).reverse().find(item => item.row.level < current.level)
        if (parent) service.select(parent.row.path)
        break
      }
      case 'Enter':
        // Here rather than SubDialog's OK: a folder opens, and a file is chosen.
        if (!current) break
        if (current.directory) service.toggle(current.path)
        else void service.ok()
        break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  return <SubDialog title={open.title} className="server-file-picker" initialFocus={treeId} okDisabled={!open.separator || !!open.busy || (!open.fileName && !open.selected && !open.disconnected)}
    onOk={() => { void service.ok() }} onCancel={() => service.cancel()} status={<span className="server-files-status" role="status">{pickerStatus(open)}</span>}>
    <div className="server-files-banner"><Icon name="info" /><span>{pickerMessages.banner(open.server)}</span></div>
    {open.error && <div className="object-dialog-message" role="alert"><Icon name="error" /><span>{open.error.message}</span></div>}
    <span className="server-files-label" id={`${id}-label`}>Select the file</span>
    <div className="server-files-table">
      <div className="server-files-head" aria-hidden="true"><span>Name</span><span className="server-files-size">Size</span><span className="server-files-modified">Modified</span></div>
      <div id={treeId} className="server-files-tree" role="tree" aria-labelledby={`${id}-label`} tabIndex={0} aria-busy={busy || undefined}
        aria-activedescendant={active >= 0 ? rowId(items[active].index) : undefined} onKeyDown={keyDown}>
        {!open.roots && <div className="server-files-row server-files-note" role="none">{open.rootsSlow && <Icon name="loading" spin />}<span>{pickerMessages.listing}</span></div>}
        {rows.map((row, index) => row.type === 'note'
          ? <div key={row.key} className={`server-files-row server-files-note ${row.tone}`} role="none"><span className="server-files-name"><span style={{ width: (row.level - 1) * explorerLimits.indent }} className="server-files-indent" />
            {row.tone === 'busy' && row.slow && <Icon name="loading" spin />}<span className="server-files-text">{row.text}</span></span></div>
          : <Item key={row.path} id={rowId(index)} row={row} selected={row.path === open.selected} service={service} />)}
      </div>
    </div>
    <div className="property-row"><label htmlFor={`${id}-selected`}>Selected path</label><input id={`${id}-selected`} readOnly value={selectedFolder(open) ?? ''} spellCheck={false} /></div>
    {types && <div className="property-row"><label htmlFor={`${id}-types`}>Files of type</label>
      <select id={`${id}-types`} value={open.allFiles ? 'all' : 'purpose'} onChange={event => service.setAllFiles(event.target.value === 'all')}>
        <option value="purpose">{types}</option><option value="all">{allFilesType}</option>
      </select></div>}
    <div className="property-row"><label htmlFor={`${id}-name`}>{open.purpose === 'folder' ? 'Folder name' : 'File name'}</label>
      <input id={`${id}-name`} value={open.fileName} maxLength={actionLimits.serverPath} spellCheck={false} autoComplete="off" onChange={event => service.setFileName(event.target.value)} /></div>
  </SubDialog>
}

function Item({ id, row, selected, service }: { id: string; row: ItemRow; selected: boolean; service: ServerFilePickerService }) {
  const loading = row.listing?.status === 'loading'
  const slow = row.listing?.status === 'loading' && row.listing.slow
  const icon = row.root ? (row.root.kind === 'drive' ? 'drive' : 'folder-library') : row.directory ? (row.expanded ? 'folder-opened' : 'folder') : 'file'
  const tags = row.root ? defaultTags(row.root) : []
  const size = row.root?.freeMb !== undefined ? formatFree(row.root.freeMb) : row.entry?.sizeBytes !== undefined ? formatSize(row.entry.sizeBytes) : ''
  const modified = row.entry?.modified ? formatModified(row.entry.modified) : ''
  const description = [...tags, size, modified && `modified ${modified}`].filter(Boolean).join(', ')
  return <div id={id} className="server-files-row" role="treeitem" aria-level={row.level} aria-selected={selected} aria-expanded={row.directory ? row.expanded : undefined}
    aria-busy={slow || undefined} aria-label={row.name} aria-description={description || undefined} data-path={row.path}
    onClick={() => service.select(row.path)} onDoubleClick={() => { if (row.directory) service.toggle(row.path); else void service.ok() }}>
    <span className="server-files-name">
      <span style={{ width: (row.level - 1) * explorerLimits.indent }} className="server-files-indent" />
      <span className="server-files-twisty" onClick={event => { if (!row.directory) return; event.stopPropagation(); service.select(row.path); service.toggle(row.path) }}>
        {row.directory && (slow ? <Icon name="loading" spin /> : <Icon name={row.expanded && !loading ? 'chevron-down' : 'chevron-right'} />)}
      </span>
      <Icon name={icon} />
      <bdi className="server-files-text">{row.name}</bdi>
      {tags.map(tag => <span key={tag} className="server-files-tag">{tag}</span>)}
    </span>
    <span className="server-files-size">{size}</span>
    <span className="server-files-modified">{modified}</span>
  </div>
}
