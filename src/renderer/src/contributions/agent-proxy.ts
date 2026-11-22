import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf } from '../menus/targets'
import { serverItems } from './query'

/**
 * The proxy and Credential documents' commands (AG-8b, docs/sql-server-agent.md › Proxies and credentials), registered only behind the release
 * gate (agentEnabled). New Proxy… opens on the server of the Object Explorer node its menu runs on (active to the subsystem when that node is a
 * subsystem's folder), else the active document's, else the one live SQL Server or the one picked from several; Proxy… in the SQL Server Agent
 * node's New submenu is the same document. New Credential… opens on the Credentials folder's or a credential's server. Each document's Save
 * and Reload act on the document whose header runs them (`tabId`), else the active one.
 */
export function agentProxyContribution({ commands, documents, connections, explorer, quickInput, proxyDocuments, credentialDocuments }: Pick<Workbench, 'commands' | 'documents' | 'connections' | 'explorer' | 'quickInput' | 'proxyDocuments' | 'credentialDocuments'>,
  options: { readonly agentEnabled?: boolean } = {}): Disposable {
  if (!options.agentEnabled) return { dispose: () => {} }
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
    if (explorerNodeOf(args)) { commands.reportError('Connect to the server first.'); return }
    const choices = connections.liveSqlServer()
    if (choices.length === 1) return then(choices[0].id)
    if (!choices.length) { commands.reportError('Connect to a SQL Server first.'); return }
    quickInput.show({ ariaLabel: title, placeholder: 'Select a server', noun: 'servers', items: serverItems(choices), onDidAccept: item => then(item.id) })
  }
  /** The subsystem a subsystem folder (or a proxy listed under one) stands for: New Proxy starts active to it. */
  const subsystemOf = (args?: CommandArgs): string | undefined => {
    const node = explorerNodeOf(args)
    return node?.ref.type === 'object' && node.ref.object.kind === 'agentProxySubsystem' ? node.ref.object.name : undefined
  }
  const newProxy = (args?: CommandArgs) => withServer(args, 'New Proxy', connectionId => report(() => proxyDocuments.newProxy(connectionId, subsystemOf(args)), 'New Proxy could not open.'))
  const nodeLive = (args?: CommandArgs) => { const node = explorerNodeOf(args); return !node || (!node.lost && connections.isLiveSqlServer(node.connectionId)) }
  const documentOf = (service: { get(id: string | undefined): unknown }, args?: CommandArgs): string | undefined => {
    const id = args?.tabId ?? documents.getSnapshot().activeId
    return id !== undefined && service.get(id) ? id : undefined
  }
  const on = (service: { get(id: string | undefined): unknown }, when: (id: string) => boolean, run: (id: string) => unknown) => ({
    when: (args?: CommandArgs) => { const id = documentOf(service, args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = documentOf(service, args); if (id && when(id)) await run(id) }
  })
  const proxies = { get: (id: string | undefined) => id === undefined ? undefined : proxyDocuments.get(id) }
  const credentials = { get: (id: string | undefined) => id === undefined ? undefined : credentialDocuments.get(id) }
  const registrations = [
    commands.register('agent.newProxy', { when: nodeLive, run: newProxy }),
    commands.register('agent.newProxyOnAgent', { when: nodeLive, run: newProxy }),
    commands.register('agentProxy.save', on(proxies, id => proxyDocuments.canSave(id), id => proxyDocuments.save(id))),
    commands.register('agentProxy.reload', on(proxies, id => proxyDocuments.canReload(id), id => proxyDocuments.reload(id))),
    commands.register('agent.newCredential', {
      when: nodeLive,
      run: args => withServer(args, 'New Credential', connectionId => report(() => credentialDocuments.newCredential(connectionId), 'New Credential could not open.'))
    }),
    commands.register('credential.save', on(credentials, id => credentialDocuments.canSave(id), id => credentialDocuments.save(id))),
    commands.register('credential.reload', on(credentials, id => credentialDocuments.canReload(id), id => credentialDocuments.reload(id)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
