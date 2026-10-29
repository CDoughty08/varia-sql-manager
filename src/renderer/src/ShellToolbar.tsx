import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { useCommandEnabled, useKeybindingLabel } from './core/useCommand'
import type { CommandArgs, CommandId } from './core/types'
import type { IconId } from '../../shared/icons'
import Icon from './Icon'
import { QueryPickers, useQueryContext } from './QueryBar'
import { lostHint, withKey } from './query-context'

/**
 * The header's search box (the command centre): it opens Search, which finds open queries, commands and the Object
 * Explorer objects already loaded, in a widget that opens below it. Its key is SSMS's Ctrl+Q on Windows; F1 still opens
 * the command palette.
 */
export function CommandCentre() {
  const { commands } = useWorkbench()
  const key = useKeybindingLabel('workbench.search')
  return <button type="button" className="command-centre" aria-label="Search" aria-keyshortcuts={key?.aria} title={withKey('Search open queries, commands and loaded objects', key)}
    onClick={event => void commands.execute('workbench.search', { anchor: event.currentTarget }, 'toolbar')}>
    <Icon name="search" /><span className="command-centre-text">Search commands, queries and objects</span><span className="command-centre-short">Search</span>{key && <kbd>{key.text}</kbd>}
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
 * The Standard toolbar: Connect, New query, the file commands and Activity Monitor. In the header it is icon buttons, and each query's own
 * bar has Execute, Cancel and its server and database. The classic variant (Options › Environment › General, kept for one
 * release) is the text toolbar from before the header row, on a row of its own, with Execute, Cancel and Layouts and the
 * active query's Server and Database lists; query tabs then show no bar of their own. Every button runs a catalogue command.
 */
export default function StandardToolbar({ variant }: { variant: 'header' | 'classic' }) {
  const workbench = useWorkbench()
  const { commands } = workbench
  const connections = useServiceSnapshot(workbench.connections)
  const { tab } = useQueryContext()
  const enabled = {
    connect: useCommandEnabled('connection.connect'), newQuery: useCommandEnabled('file.new'), open: useCommandEnabled('file.open'), save: useCommandEnabled('file.save'), saveAll: useCommandEnabled('file.saveAll'),
    execute: useCommandEnabled('query.execute'), cancel: useCommandEnabled('query.cancel'), monitor: useCommandEnabled('activity.open')
  }
  const keys = { open: useKeybindingLabel('file.open'), save: useKeybindingLabel('file.save'), saveAll: useKeybindingLabel('file.saveAll'), execute: useKeybindingLabel('query.execute'), monitor: useKeybindingLabel('activity.open') }
  const run = (id: CommandId) => { void commands.execute(id, undefined, 'toolbar') }
  const lost = !!connections.find(value => value.id === tab?.connectionId)?.lost

  if (variant === 'classic') return <div className="toolbar" role="toolbar" aria-label="Standard">
    <div className="toolbar-actions">
      <button className="primary" disabled={!enabled.connect} onClick={() => run('connection.connect')}><Icon name="add" />Connect</button>
      <span className="toolbar-divider" />
      <button disabled={!enabled.newQuery} onClick={() => run('file.new')}><Icon name="add" />New query</button>
      <button disabled={!enabled.open} onClick={() => run('file.open')} title={withKey('Open SQL files', keys.open)}><Icon name="folder-opened" />Open</button>
      <button disabled={!enabled.save} onClick={() => run('file.save')} title={withKey('Save SQL query', keys.save)}><Icon name="save" />Save</button>
      <button disabled={!enabled.saveAll} onClick={() => run('file.saveAll')} title={withKey('Save all queries with unsaved changes', keys.saveAll)}><Icon name="save" />Save All</button>
      <span className="toolbar-divider" />
      <button className="execute" disabled={!enabled.execute} title={lost ? lostHint : withKey('Execute', keys.execute)} onClick={() => run('query.execute')}>
        <Icon name="play" />Execute{keys.execute && <kbd>{keys.execute.text}</kbd>}</button>
      <button disabled={!enabled.cancel} onClick={() => run('query.cancel')}><Icon name="debug-stop" />Cancel</button>
      <span className="toolbar-divider" />
      {/* SSMS's toolbar button: the server of the active query, else the one selected in Object Explorer. */}
      <button disabled={!enabled.monitor} onClick={() => run('activity.open')} aria-label="Activity Monitor" title={withKey('Activity Monitor', keys.monitor)}><Icon name="pulse" /></button>
      <button onClick={() => run('layout.load')} title="Save, load, or reset panel layouts"><Icon name="layout" />Layouts</button>
    </div>
    <div className="toolbar-context"><QueryPickers variant="classic" /></div>
  </div>

  return <div className="header-toolbar" role="toolbar" aria-label="Standard">
    <ToolButton id="connection.connect" icon="plug" name="Connect" title="Connect to Server…" />
    <ToolButton id="file.new" icon="new-file" name="New query" title="New Query" />
    <ToolButton id="file.open" icon="folder-opened" name="Open" title="Open File…" />
    <ToolButton id="file.save" icon="save" name="Save" title="Save" />
    <ToolButton id="file.saveAll" icon="save-all" name="Save All" title="Save All" />
    {/* SSMS's toolbar button: the server of the active query, else the one selected in Object Explorer. */}
    <ToolButton id="activity.open" icon="pulse" name="Activity Monitor" title="Activity Monitor" />
  </div>
}
