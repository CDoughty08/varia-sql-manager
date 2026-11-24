import type { AlertOperatorDocumentService } from '../agent/AlertOperatorDocumentService'
import { testBlocked } from '../agent/OperatorDocument'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf } from '../menus/targets'
import { serverItems } from './query'

/**
 * SQL Server Agent's alert and operator commands (AG-7, docs/sql-server-agent.md › Alerts and operators). New Alert…, New Operator… and the grid open on the server of the Object Explorer node
 * their menu runs on, else the active document's, else the selected node's, else the one live connection or the one picked from several.
 * Each document's verbs act on the document whose header runs them (`tabId`), else the active one.
 */
export function agentObjectsContribution({ commands, documents, connections, explorer, quickInput, alertDocuments, operatorDocuments, operatorsDocuments }:
  Pick<Workbench, 'commands' | 'documents' | 'connections' | 'explorer' | 'quickInput' | 'alertDocuments' | 'operatorDocuments' | 'operatorsDocuments'>): Disposable {
  const live = (id: string | undefined) => id !== undefined && connections.isLiveSqlServer(id) ? id : undefined
  const target = (args?: CommandArgs): string | undefined => {
    const node = explorerNodeOf(args)
    if (node) return node.lost ? undefined : live(node.connectionId)
    return live(documents.active?.connectionId) ?? live(explorer.menuNode(explorer.getSnapshot().selected)?.connectionId)
  }
  const report = (run: () => void, fallback: string) => { try { run() } catch (error) { commands.reportError(error instanceof Error ? error.message : fallback) } }
  const withServer = (args: CommandArgs | undefined, title: string, then: (connectionId: string) => void) => {
    const connectionId = target(args)
    if (connectionId) return then(connectionId)
    const choices = connections.liveSqlServer()
    if (choices.length === 1) return then(choices[0].id)
    if (!choices.length) { commands.reportError('Connect to a SQL Server first.'); return }
    quickInput.show({ ariaLabel: title, placeholder: 'Select a server', noun: 'servers', items: serverItems(choices), onDidAccept: item => then(item.id) })
  }
  const onServer = { when: (args?: CommandArgs) => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) } }
  /** The document a verb acts on: the one whose header runs it, else the active one, if it is this service's. */
  const docOf = <M, D>(service: AlertOperatorDocumentService<M, D>, args?: CommandArgs) => { const id = args?.tabId ?? documents.getSnapshot().activeId; return id && service.get(id) ? id : undefined }
  const on = <M, D>(service: AlertOperatorDocumentService<M, D>, when: (id: string) => boolean, run: (id: string) => unknown) => ({
    when: (args?: CommandArgs) => { const id = docOf(service, args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = docOf(service, args); if (id && when(id)) await run(id) }
  })
  /** Open Alert… and Open Operator…: the node's object, else one picked from the server's. */
  const openNamed = (kind: 'agentAlert' | 'agentOperator', args: CommandArgs | undefined) => {
    const service = kind === 'agentAlert' ? alertDocuments : operatorDocuments
    const noun = kind === 'agentAlert' ? 'alert' : 'operator'
    const node = explorerNodeOf(args)
    if (node?.ref.type === 'object' && node.ref.object.kind === kind && node.ref.object.name !== undefined) {
      const name = node.ref.object.name
      return report(() => service.open(node.connectionId, { kind, name }), `The ${noun} could not be opened.`)
    }
    withServer(args, kind === 'agentAlert' ? 'Open Alert' : 'Open Operator', connectionId => quickInput.show({
      ariaLabel: kind === 'agentAlert' ? 'Open Alert' : 'Open Operator', placeholder: `Select an ${noun}`, noun: `${noun}s`,
      items: async signal => (await operatorsDocuments.names(connectionId, kind, signal)).map(name => ({ id: name, label: name, icon: kind === 'agentAlert' ? 'bell' as const : 'agent-operator' as const })),
      onDidAccept: item => report(() => service.open(connectionId, { kind, name: item.id }), `The ${noun} could not be opened.`)
    }))
  }
  const openGrid = (connectionId: string) => { let id = ''; report(() => { id = operatorsDocuments.open(connectionId, { kind: 'agent' }) }, 'Operators and notifications could not open.'); return id }
  const registrations = [
    commands.register('agent.newAlert', { ...onServer, run: args => withServer(args, 'New Alert', connectionId => report(() => alertDocuments.openNew(connectionId), 'New Alert could not open.')) }),
    commands.register('agent.newAlertOnAgent', { ...onServer, run: args => withServer(args, 'New Alert', connectionId => report(() => alertDocuments.openNew(connectionId), 'New Alert could not open.')) }),
    commands.register('agent.openAlert', { ...onServer, run: args => openNamed('agentAlert', args) }),
    commands.register('agent.newOperator', { ...onServer, run: args => withServer(args, 'New Operator', connectionId => report(() => operatorDocuments.openNew(connectionId), 'New Operator could not open.')) }),
    commands.register('agent.newOperatorOnAgent', { ...onServer, run: args => withServer(args, 'New Operator', connectionId => report(() => operatorDocuments.openNew(connectionId), 'New Operator could not open.')) }),
    commands.register('agent.openOperator', { ...onServer, run: args => openNamed('agentOperator', args) }),
    commands.register('agent.operators', { ...onServer, run: args => withServer(args, 'Operators and Notifications', openGrid) }),
    // Add recommended alerts: the grid, with its dialog open once the grid has read the server.
    commands.register('agent.addRecommendedAlerts', { ...onServer, run: args => withServer(args, 'Add Recommended Alerts', connectionId => { const id = openGrid(connectionId); if (id) operatorsDocuments.setAsk(id, 'recommended') }) }),
    commands.register('agentAlert.save', on(alertDocuments, id => alertDocuments.canSave(id), id => alertDocuments.save(id))),
    commands.register('agentAlert.reload', on(alertDocuments, id => alertDocuments.canReload(id), id => alertDocuments.reload(id))),
    commands.register('agentOperator.save', on(operatorDocuments, id => operatorDocuments.canSave(id), id => operatorDocuments.save(id))),
    commands.register('agentOperator.reload', on(operatorDocuments, id => operatorDocuments.canReload(id), id => operatorDocuments.reload(id))),
    commands.register('agentOperator.sendTest', on(operatorDocuments, id => {
      const state = operatorDocuments.get(id)
      return !!state?.model && state.draft !== undefined && operatorDocuments.canReload(id) && testBlocked(state.model, state.draft, state.changes) === undefined
    }, id => { const operator = operatorDocuments.get(id)?.model?.operator; return operator ? operatorDocuments.sendTest(id, operator) : undefined })),
    commands.register('agentOperators.save', on(operatorsDocuments, id => operatorsDocuments.canSave(id), id => operatorsDocuments.save(id))),
    commands.register('agentOperators.reload', on(operatorsDocuments, id => operatorsDocuments.canReload(id), id => operatorsDocuments.reload(id)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
