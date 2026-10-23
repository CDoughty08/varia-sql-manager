import { documentKind, type QueryTab } from './documents'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { useCommandEnabled, useKeybindingLabel } from './core/useCommand'
import type { CommandArgs, CommandId } from './core/types'
import type { IconId } from '../../shared/icons'
import Icon from './Icon'

/** Tooltip text with the command's key on this platform, such as "Open File… (Ctrl+O)". */
export function withKey(text: string, label: { text: string } | undefined): string { return label ? `${text} (${label.text})` : text }
export const lostHint = "This query's connection was lost when the SQL backend restarted. Reconnect to run queries."

/**
 * The header's search box (the command centre): it opens Search, which finds open queries, commands and the Object
 * Explorer objects already loaded. Its key is SSMS's Ctrl+Q on Windows; F1 still opens the command palette.
 */
export function CommandCentre() {
  const { commands } = useWorkbench()
  const key = useKeybindingLabel('workbench.search')
  return <button type="button" className="command-centre" aria-label="Search" aria-keyshortcuts={key?.aria} title={withKey('Search open queries, commands and loaded objects', key)}
    onClick={() => void commands.execute('workbench.search', undefined, 'toolbar')}>
    <Icon name="search" /><span className="command-centre-text">Search commands, queries and objects</span>{key && <kbd>{key.text}</kbd>}
  </button>
}

function ToolButton({ id, icon, name, title, className, args }: { id: CommandId; icon: IconId; name: string; title: string; className?: string; args?: CommandArgs }) {
  const { commands } = useWorkbench()
  const enabled = useCommandEnabled(id, args)
  const key = useKeybindingLabel(id)
  return <button type="button" className={className ? `icon-button ${className}` : 'icon-button'} aria-label={name} title={withKey(title, key)} disabled={!enabled}
    onClick={() => void commands.execute(id, args, 'toolbar')}><Icon name={icon} /></button>
}

/**
 * The Standard toolbar: Connect, the file commands, and the active query's server, database, Execute and Cancel. In the
 * header it is icon buttons; the classic variant (Options › Environment › General, kept for one release) is the text
 * toolbar from before the header row, on a row of its own. Every button runs a catalogue command.
 */
export default function StandardToolbar({ variant }: { variant: 'header' | 'classic' }) {
  const workbench = useWorkbench()
  const { documents, commands, targets } = workbench
  const { documents: tabs, activeId, busy } = useServiceSnapshot(documents)
  const queryState = useServiceSnapshot(workbench.queries)
  const connections = useServiceSnapshot(workbench.connections)
  const databaseLists = useServiceSnapshot(workbench.databaseList)
  const enabled = {
    connect: useCommandEnabled('connection.connect'), newQuery: useCommandEnabled('file.new'), open: useCommandEnabled('file.open'), save: useCommandEnabled('file.save'), saveAll: useCommandEnabled('file.saveAll'),
    execute: useCommandEnabled('query.execute'), cancel: useCommandEnabled('query.cancel')
  }
  const keys = { open: useKeybindingLabel('file.open'), save: useKeybindingLabel('file.save'), saveAll: useKeybindingLabel('file.saveAll'), execute: useKeybindingLabel('query.execute') }
  const run = (id: CommandId) => { void commands.execute(id, undefined, 'toolbar') }
  const active: QueryTab | undefined = tabs.find(tab => tab.id === activeId)
  // A value opened from the results has no server or database; a table designer's are its own, which these never change.
  const isQuery = !!active && documentKind(active) === 'sql'
  const connection = connections.find(value => value.id === active?.connectionId)
  const live = connection?.lost ? undefined : connection
  const running = !!active && !!queryState[active.id]?.running
  const database = active?.database ?? 'master'
  const listed = live ? databaseLists.get(live.id) ?? [] : []
  const databases = listed.some(value => value.name === database) ? listed : [{ name: database, isSystem: false }, ...listed]
  const classic = variant === 'classic'
  const pickers = <>
    {classic && <label className="context-field" htmlFor="query-server">Server</label>}
    <select id="query-server" aria-label="Query server" title={classic ? undefined : 'The active query\'s server'} disabled={!active || !isQuery || running || busy} value={connection?.id ?? ''}
      onChange={event => { if (active) void targets.changeConnection(active.id, event.target.value || undefined) }}>
      <option value="">Disconnected</option>
      {connections.filter(value => !value.lost || value === connection).map(value => <option key={value.id} value={value.id} disabled={value.lost}>{value.displayName ? `${value.displayName} (${value.server})` : value.server}{value.lost ? ' (connection lost)' : ''}</option>)}
    </select>
    {classic && <label className="context-field" htmlFor="query-database">Database</label>}
    <select id="query-database" aria-label="Query database" title={classic ? undefined : 'The active query\'s database'} disabled={!isQuery || !live || running || busy} value={database}
      onChange={event => { if (active) targets.changeDatabase(active.id, event.target.value) }}>
      {databases.map(value => <option key={value.name}>{value.name}</option>)}
    </select>
  </>
  const execute = <button type="button" className={classic ? 'execute' : 'execute primary'} aria-label={classic ? undefined : 'Execute'} disabled={!enabled.execute} title={connection?.lost ? lostHint : withKey('Execute', keys.execute)} onClick={() => run('query.execute')}>
    <Icon name="play" /><span className="execute-label">Execute</span>{classic && keys.execute && <kbd>{keys.execute.text}</kbd>}</button>

  if (classic) return <div className="toolbar" role="toolbar" aria-label="Standard">
    <div className="toolbar-actions">
      <button className="primary" disabled={!enabled.connect} onClick={() => run('connection.connect')}><Icon name="add" />Connect</button>
      <span className="toolbar-divider" />
      <button disabled={!enabled.newQuery} onClick={() => run('file.new')}><Icon name="add" />New query</button>
      <button disabled={!enabled.open} onClick={() => run('file.open')} title={withKey('Open SQL files', keys.open)}><Icon name="folder-opened" />Open</button>
      <button disabled={!enabled.save} onClick={() => run('file.save')} title={withKey('Save SQL query', keys.save)}><Icon name="save" />Save</button>
      <button disabled={!enabled.saveAll} onClick={() => run('file.saveAll')} title={withKey('Save all queries with unsaved changes', keys.saveAll)}><Icon name="save" />Save All</button>
      <span className="toolbar-divider" />
      {execute}
      <button disabled={!enabled.cancel} onClick={() => run('query.cancel')}><Icon name="debug-stop" />Cancel</button>
      <span className="toolbar-divider" />
      <button onClick={() => run('layout.load')} title="Save, load, or reset panel layouts"><Icon name="layout" />Layouts</button>
    </div>
    <div className="toolbar-context">{pickers}</div>
  </div>

  return <div className="header-toolbar" role="toolbar" aria-label="Standard">
    <ToolButton id="connection.connect" icon="plug" name="Connect" title="Connect to Server…" />
    <ToolButton id="file.new" icon="new-file" name="New query" title="New Query" />
    <ToolButton id="file.open" icon="folder-opened" name="Open" title="Open File…" />
    <ToolButton id="file.save" icon="save" name="Save" title="Save" />
    <ToolButton id="file.saveAll" icon="save-all" name="Save All" title="Save All" />
    <span className="toolbar-divider" />
    <span className="header-context">{pickers}</span>
    {execute}
    <ToolButton id="query.cancel" icon="debug-stop" name="Cancel" title="Cancel Executing Query" />
  </div>
}
