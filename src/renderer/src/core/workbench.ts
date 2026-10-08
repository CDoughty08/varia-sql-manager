import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { VariaApi } from '../../../shared/contracts'
import { DocumentService } from '../services/documents'
import { QueryService } from '../services/queries'
import { ConnectionService } from '../services/connections'
import { FileService } from '../services/files'
import { queryContribution } from '../contributions/query'
import { filesContribution } from '../contributions/files'
import { CommandService } from './commands'
import { EventBus } from './events'
import type { Disposable } from './types'

export interface Workbench extends Disposable {
  readonly monaco: typeof Monaco
  readonly events: EventBus
  readonly commands: CommandService
  readonly documents: DocumentService
  readonly queries: QueryService
  readonly connections: ConnectionService
  readonly files: FileService
}
export function createWorkbench(api: VariaApi, monaco: typeof Monaco): Workbench {
  const events = new EventBus(), commands = new CommandService(), connections = new ConnectionService()
  const documents = new DocumentService((sql, uri) => monaco.editor.createModel(sql, 'sql', monaco.Uri.parse(uri)), api, events)
  const queries = new QueryService(documents, api, id => connections.get(id), events)
  const files = new FileService(documents, queries, api)
  const cleanup = events.subscribe(event => { if (event.type === 'documents.closed') queries.forget(event.tabId) })
  let disposed = false
  const workbench: Workbench = { monaco, events, commands, documents, queries, connections, files, dispose: () => {
    if (disposed) return
    disposed = true
    fileCommands.dispose(); contribution.dispose(); cleanup.dispose(); commands.dispose(); files.dispose(); queries.dispose(); documents.dispose(); connections.dispose(); events.dispose()
  } }
  const contribution = queryContribution(workbench)
  const fileCommands = filesContribution(workbench)
  documents.create('SQLQuery1.sql', '-- Connect this query to a server and press F5 to execute.\n\nSELECT\n    @@SERVERNAME AS server_name,\n    DB_NAME() AS database_name,\n    SYSDATETIME() AS server_time;\n', 'master')
  return workbench
}
