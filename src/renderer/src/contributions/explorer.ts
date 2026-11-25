import type { ApiResult, BigQueryProject, VariaApi } from '../../../shared/contracts'
import { bigQueryProjectSchema } from '../../../shared/connections'
import { insertTextFor } from '../../../shared/explorer/refs.ts'
import { bigQueryPath } from '../../../shared/bigquery/names.ts'
import { bigQueryPreviewRows } from '../../../shared/bigquery/objects'
import { mergeProjects } from '../bigquery-connect-form'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, filterable, objectNodeOf, peekPropertiesOf, type ExplorerMenuNode } from '../menus/targets'
import type { QuickPickItem } from '../quickinput/QuickInputService'
import type { LiveConnection } from '../services/connections'
import { windows } from '../core/windows'
import { serverItems } from './query'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const frame = (callback: () => void) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback); else callback() }
const maxProjectPages = 10
const bigQueryPrincipalOf = (connection: LiveConnection | undefined): string | undefined => {
  if (!connection || connection.options.provider !== 'bigquery') return undefined
  if (connection.authentication?.principal.provider === 'bigquery') return connection.authentication.principal.principal
  return connection.principalId?.startsWith('bigquery:') ? connection.principalId : undefined
}

/**
 * Object Explorer's commands (Script As's are in contributions/scripting.ts, Select Top, Rename and Delete in contributions/actions.ts). Each acts on the node its context menu was opened for (`CommandArgs.target`; none for the
 * empty area), otherwise on the selected node, so F5, the toolbar, and the palette act on the selection. Nodes must be
 * on a server that is still connected (not lost with a backend restart, even when the backend restarted while the menu
 * was open or the command was waiting).
 */
export function explorerContribution({ commands, documents, connections, explorer, explorerStatus, settings, peek, peekTabs, dependencies, queries, bigQueryProperties, objectSearch, quickInput, bigQueryStarred }: Pick<Workbench, 'commands' | 'documents' | 'connections' | 'explorer'>
  & { queries?: Pick<Workbench['queries'], 'execute'>; bigQueryProperties?: Pick<Workbench['bigQueryProperties'], 'canOpen' | 'open'> }
  & { objectSearch?: Pick<Workbench['objectSearch'], 'refreshNode'> & Partial<Pick<Workbench['objectSearch'], 'refreshBigQuery'>> }
  & { quickInput?: Pick<Workbench['quickInput'], 'show' | 'setAnswer' | 'hide' | 'setMessage'>; bigQueryStarred?: Pick<Workbench['bigQueryStarred'], 'starredFor' | 'isStarred' | 'setStarred'> }
  & { explorerStatus?: Pick<Workbench['explorerStatus'], 'refresh'>; settings?: Pick<Workbench['settings'], 'toggle'>; peek?: Pick<Workbench['peek'], 'canPeek' | 'peek' | 'getSnapshot' | 'close' | 'refresh'>
    peekTabs?: Pick<Workbench['peekTabs'], 'canOpen' | 'open' | 'view'>; dependencies?: Pick<Workbench['dependencies'], 'canOpen' | 'open'> },
  api: Pick<VariaApi, 'writeClipboardText'> & Partial<Pick<VariaApi, 'bigQueryConnectionProjects' | 'explorerChildren' | 'explorerCancel'>>): Disposable {
  const nodeOf = (args?: CommandArgs): ExplorerMenuNode | undefined => args?.target && args.target.kind !== 'explorerTools' ? explorerNodeOf(args) : explorer.menuNode(explorer.getSnapshot().selected)
  const live = (node: ExplorerMenuNode | undefined): node is ExplorerMenuNode => !!node && !node.lost && connections.isLive(node.connectionId)
  const queryNode = (args?: CommandArgs) => { const node = nodeOf(args); return live(node) && (node.kind === 'server' || node.kind === 'database') ? node : undefined }
  // A BigQuery Search Objects result: New Query opens on its connection.
  const bigQueryHit = (args?: CommandArgs) => {
    const node = args?.target?.kind === 'searchHit' ? objectNodeOf(args) : undefined
    return node && !node.lost && connections.isLive(node.connectionId) && node.ref.type === 'object' && node.ref.object.project !== undefined ? node : undefined
  }
  // From the node's identity, so it works while the node is being reloaded; only a Columns folder needs its loaded rows.
  const copyText = (args?: CommandArgs) => {
    const node = nodeOf(args)
    if (!live(node)) return undefined
    if (node.kind === 'server') return connections.get(node.connectionId)?.server
    return node.kind === 'folder' ? explorer.insertText(node.id) : insertTextFor(node.ref)
  }
  // A BigQuery table (or snapshot, or clone): the rows tabledata.list can list.
  // A Search Objects result's menu previews its table too.
  const previewNode = (args?: CommandArgs) => {
    const node = args?.target?.kind === 'searchHit' ? objectNodeOf(args) : nodeOf(args)
    return node && !node.lost && connections.isLive(node.connectionId) && node.ref.type === 'object' && node.ref.object.kind === 'bqTable' && !!queries ? node : undefined
  }
  const filterNode = (args?: CommandArgs) => { const node = nodeOf(args); return live(node) && filterable(node) ? node : undefined }
  const registrations = [
    // Refresh also samples the server's live status at once, so its chips match the reloaded rows.
    // A BigQuery node's Refresh also re-reads its project or dataset in the Search Objects index.
    commands.register('explorer.refresh', { run: args => { const node = nodeOf(args); explorer.refresh(node?.id); explorerStatus?.refresh(node?.connectionId); if (live(node)) objectSearch?.refreshNode(node.connectionId, node.ref) } }),
    commands.register('explorer.stop', { run: () => explorer.stop() }),
    commands.register('explorer.filter', { when: args => !!filterNode(args), run: args => { const node = filterNode(args); if (node) explorer.openFilter(node.id) } }),
    commands.register('explorer.removeFilter', {
      when: args => !!filterNode(args)?.filtered,
      run: args => { const node = filterNode(args); if (node) explorer.setFilter(node.id, undefined) }
    }),
    commands.register('explorer.collapseAll', { run: () => explorer.collapseAll() }),
    // Lost servers move too: the order is the workspace's, not the connection's.
    ...([['explorer.moveServerUp', -1], ['explorer.moveServerDown', 1]] as const).map(([id, step]) => {
      const place = (args?: CommandArgs) => { const node = nodeOf(args); const at = node && explorer.serverPlace(node.id); return node && at && at.index + step >= 0 && at.index + step < at.count ? { node, to: at.index + step } : undefined }
      return commands.register(id, { when: args => !!place(args), run: args => { const move = place(args); if (move) explorer.moveServer(move.node.id, move.to) } })
    }),
    // The setting is the state: ExplorerService follows it, and its context key checks the button and the palette entry.
    commands.register('explorer.groupBySchema', { when: () => !!settings, run: () => settings?.toggle('objectExplorer.groupBySchema') }),
    commands.register('explorer.newQuery', {
      when: args => args?.target?.kind === 'searchHit' ? !!bigQueryHit(args) : !!queryNode(args),
      run: args => {
        const hit = bigQueryHit(args)
        const node = hit ?? (args?.target?.kind === 'searchHit' ? undefined : queryNode(args)), connection = node && connections.get(node.connectionId)
        if (!node || !connection || node.ref.type !== 'object') return
        const object = node.ref.object
        // A BigQuery object's dataset is the new query's when it is in the billing project, as Preview Rows' is.
        const dataset = object.kind === 'bqDataset' ? object.name : object.dataset
        const database = hit ? (object.project === connection.server && dataset !== undefined ? dataset : connection.database)
          : object.kind === 'database' ? object.name : undefined
        documents.newQuery('', undefined, connection.id, database ?? connection.database)
        // The menu returned focus to the tree; the new query's editor may mount only on a later frame.
        frame(() => documents.boundEditor?.focus())
      }
    }),
    // The context menu's Peek focuses the card; Alt+F12 and the palette open it on the selection, focused too.
    commands.register('explorer.peek', {
      when: args => !!peek?.canPeek(nodeOf(args)),
      run: args => peek?.peek(nodeOf(args), args?.target ? 'menu' : 'keyboard')
    }),
    // Open Peek as Tab: the open card's object (on the tab it shows, and the card closes), otherwise the node a menu, a Ctrl+click
    // or the selection names.
    commands.register('explorer.openPeekTab', {
      when: args => !args?.target && !!peek?.getSnapshot().open || !!peekTabs?.canOpen(nodeOf(args)),
      run: args => {
        const card = args?.target ? undefined : peek?.getSnapshot().open
        if (card) { peek?.close(); peekTabs?.open(card.node, card.tab) } else peekTabs?.open(nodeOf(args))
      }
    }),
    // View Dependencies on the menu's node or the selection; the dialog takes focus.
    commands.register('explorer.viewDependencies', {
      when: args => !!dependencies?.canOpen(nodeOf(args)),
      run: args => { peek?.close(); dependencies?.open(nodeOf(args)) }
    }),
    // F5 in the card refreshes the card; elsewhere it refreshes the active Peek tab.
    commands.register('peek.refresh', {
      when: () => !!peek?.getSnapshot().open || !!peekTabs?.view(documents.getSnapshot().activeId),
      run: () => {
        const inCard = typeof document !== 'undefined' && !!windows.activeElement()?.closest('[data-peek-card]')
        if (inCard || !peekTabs?.view(documents.getSnapshot().activeId)) peek?.refresh()
        else peekTabs.view(documents.getSnapshot().activeId)?.refresh()
      }
    }),
    // Preview Rows (docs/bigquery.md): a new query tab whose text is the SELECT the preview stands for, filled through tabledata.list,
    // which is free. Its dataset is the table's when the table is in the billing project.
    commands.register('explorer.previewRows', {
      when: args => !!previewNode(args),
      run: async args => {
        const node = previewNode(args), connection = node && connections.get(node.connectionId)
        if (!node || !connection || node.ref.type !== 'object') return
        const { project, dataset, name } = node.ref.object
        if (project === undefined || dataset === undefined || name === undefined) return
        const sql = `-- Preview Rows read the first ${bigQueryPreviewRows.toLocaleString('en-US')} rows with tabledata.list, which is free and runs no job.\n`
          + `-- Execute runs this query instead, which BigQuery bills.\nSELECT *\nFROM ${bigQueryPath(project, dataset, name)}\nLIMIT ${bigQueryPreviewRows};\n`
        const document = documents.newQuery(sql, undefined, connection.id, project === connection.server ? dataset : connection.database)
        frame(() => documents.boundEditor?.focus())
        await queries?.execute(document.id, { project, dataset, table: name })
      }
    }),
    commands.register('explorer.bigQueryProperties', {
      when: args => !!bigQueryProperties?.canOpen(nodeOf(args)) && live(nodeOf(args)),
      run: args => { bigQueryProperties?.open(nodeOf(args)) }
    }),
    // Star a Project…: lists accessible projects on the BigQuery handle AND accepts typing any valid project ID (e.g. bigquery-public-data).
    commands.register('bigquery.starProjectPrompt', {
      when: args => {
        if (!quickInput || !bigQueryStarred) return false
        if (args?.target && args.target.kind !== 'explorerTools') {
          const node = explorerNodeOf(args)
          return live(node) && connections.isLiveBigQuery(node.connectionId)
        }
        return connections.liveBigQuery().length > 0
      },
      run: args => {
        if (!quickInput || !bigQueryStarred) return
        const openPicker = (connection: LiveConnection) => {
          const principal = bigQueryPrincipalOf(connection)
          const billing = connection.options.provider === 'bigquery' ? connection.options.project : connection.server
          if (!principal) { commands.reportError('The BigQuery account could not be verified.'); return }
          const loadedIds = new Set<string>()
          let currentValue = ''
          let loadNote: string | undefined
          let closed = false
          let verifySeq = 0
          let activeVerify: { readonly project: string; readonly requestId: string } | undefined
          const cancelVerify = () => {
            verifySeq++
            if (activeVerify) {
              const id = activeVerify.requestId
              activeVerify = undefined
              void api.explorerCancel?.([id]).catch(() => {})
            }
          }
          const updateAnswer = (value: string, busy = false) => {
            currentValue = value
            const trimmed = value.trim()
            if (trimmed && bigQueryProjectSchema.safeParse(trimmed).success && !loadedIds.has(trimmed)) {
              const item: QuickPickItem = trimmed === billing
                ? {
                    id: trimmed, label: trimmed, icon: 'project', disabled: true, group: 'By project ID',
                    description: 'Billing project', disabledHint: 'The billing project is always shown in Object Explorer.'
                  }
                : bigQueryStarred.isStarred(principal, trimmed)
                  ? {
                      id: trimmed, label: trimmed, icon: 'star-full', disabled: true, group: 'By project ID',
                      description: 'Already starred', disabledHint: 'This project is already starred.'
                    }
                  : { id: trimmed, label: trimmed, description: 'Star project by ID', icon: 'star-empty', group: 'By project ID' }
              quickInput.setAnswer({ items: [item], ...busy ? { busy: true } : {} })
              return
            }
            quickInput.setAnswer({ items: [], ...busy ? { busy: true } : {}, ...loadNote && !trimmed ? { message: { text: loadNote, severity: 'info' } } : {} })
          }
          const refreshPrincipalProject = (projectId: string) => {
            if (!objectSearch?.refreshBigQuery) return
            for (const candidate of connections.liveBigQuery()) {
              if (bigQueryPrincipalOf(candidate) === principal && (candidate.options.provider !== 'bigquery' || candidate.options.project !== projectId)) {
                objectSearch.refreshBigQuery(candidate.id, { scope: { project: projectId } })
              }
            }
          }
          const starAndRefresh = async (projectId: string) => {
            const result = await bigQueryStarred.setStarred(connection.id, principal, projectId, true)
            if (!result.ok) commands.reportError(result.error)
            else refreshPrincipalProject(projectId)
          }
          quickInput.show<QuickPickItem>({
            ariaLabel: 'Star a BigQuery project',
            title: `Star a Project — ${connection.displayName || connection.server}`,
            placeholder: 'Select a project or type a project ID (e.g., bigquery-public-data)',
            noun: 'projects',
            matchOnDescription: true,
            hideOnAccept: false,
            items: async signal => {
              if (!api.bigQueryConnectionProjects) return []
              let listed: BigQueryProject[] = [], pageToken: string | undefined, pages = 0
              do {
                if (signal.aborted) return []
                const result = await api.bigQueryConnectionProjects({ connectionId: connection.id, ...pageToken ? { pageToken } : {} })
                if (signal.aborted) return []
                if (!result.ok) {
                  loadNote = `Could not list projects: ${result.error} Type a project ID to star it.`
                  updateAnswer(currentValue, !!activeVerify)
                  return []
                }
                listed = mergeProjects(listed, result.value.projects)
                pageToken = result.value.nextPageToken
              } while (pageToken && ++pages < maxProjectPages)
              for (const project of listed) loadedIds.add(project.id)
              if (pageToken) loadNote = `Showing the first ${listed.length.toLocaleString('en-US')} projects. Type a project ID to star another.`
              updateAnswer(currentValue, !!activeVerify)
              return listed.map((project): QuickPickItem => {
                if (project.id === billing) {
                  return {
                    id: project.id, label: project.id, icon: 'project', disabled: true,
                    description: project.friendlyName ? `${project.friendlyName} · Billing project` : 'Billing project',
                    disabledHint: 'The billing project is always shown in Object Explorer.'
                  }
                }
                if (bigQueryStarred.isStarred(principal, project.id)) {
                  return {
                    id: project.id, label: project.id, icon: 'star-full', disabled: true,
                    description: project.friendlyName ? `${project.friendlyName} · Already starred` : 'Already starred',
                    disabledHint: 'This project is already starred.'
                  }
                }
                return { id: project.id, label: project.id, icon: 'star-empty', ...project.friendlyName ? { description: project.friendlyName } : {} }
              })
            },
            onDidChangeValue: value => {
              cancelVerify()
              updateAnswer(value)
            },
            onDidHide: () => {
              closed = true
              cancelVerify()
            },
            onDidAccept: async item => {
              if (loadedIds.has(item.id)) {
                quickInput.hide('accept')
                await starAndRefresh(item.id)
                return
              }
              if (activeVerify?.project === item.id) return
              if (!api.explorerChildren) {
                quickInput.setMessage({ text: `Could not verify “${item.id}”.`, severity: 'error' })
                return
              }
              cancelVerify()
              const seq = verifySeq
              const requestId = crypto.randomUUID()
              activeVerify = { project: item.id, requestId }
              updateAnswer(currentValue, true)
              quickInput.setMessage({ text: `Checking access to “${item.id}”…`, severity: 'info' })
              let check: ApiResult<Awaited<ReturnType<NonNullable<typeof api.explorerChildren>>> extends ApiResult<infer T> ? T : never>
              try {
                check = await api.explorerChildren({
                  connectionId: connection.id,
                  requestId,
                  node: { type: 'object', object: { kind: 'bqProject', name: item.id } },
                  pageSize: 1
                })
              } catch (error) {
                check = { ok: false, error: error instanceof Error ? error.message : 'The verification request failed.' }
              } finally {
                if (activeVerify?.requestId === requestId) activeVerify = undefined
              }
              if (closed || seq !== verifySeq) return
              updateAnswer(currentValue, false)
              if (!check.ok) {
                quickInput.setMessage({ text: `Could not verify “${item.id}”: ${check.error}`, severity: 'error' })
                return
              }
              if (check.value.error) {
                quickInput.setMessage({ text: `Could not star “${item.id}”: ${check.value.error.message}`, severity: 'error' })
                return
              }
              quickInput.hide('accept')
              await starAndRefresh(item.id)
            }
          })
        }
        const targetNode = nodeOf(args)
        const targetConnection = live(targetNode) && connections.isLiveBigQuery(targetNode.connectionId) ? connections.get(targetNode.connectionId) : undefined
        if (targetConnection) { openPicker(targetConnection); return }
        const choices = connections.liveBigQuery()
        if (choices.length === 1) { openPicker(choices[0]); return }
        if (!choices.length) { commands.reportError('Connect to BigQuery first.'); return }
        quickInput.show({
          ariaLabel: 'Star a Project', placeholder: 'Select a BigQuery connection', noun: 'connections', items: serverItems(choices),
          onDidAccept: item => {
            if (!connections.isLiveBigQuery(item.id)) { commands.reportError('That BigQuery connection is no longer open.'); return }
            const chosen = connections.get(item.id)
            if (chosen) openPicker(chosen)
          }
        })
      }
    }),
    ...([['bigquery.starProject', true, 'session'], ['bigquery.unstarProject', false, 'starred']] as const).map(([id, wantStarred, requiredRole]) =>
      commands.register(id, {
        when: args => {
          const node = nodeOf(args)
          return live(node) && node.kind === 'bqProject' && node.bigQueryProjectRole === requiredRole && !!bigQueryStarred
        },
        run: async args => {
          const node = nodeOf(args)
          if (!live(node) || node.kind !== 'bqProject' || node.ref.type !== 'object' || !node.ref.object.name || !bigQueryStarred) return
          const connection = connections.get(node.connectionId), principal = bigQueryPrincipalOf(connection), project = node.ref.object.name
          if (explorer.isBigQueryProjectBilling(node.connectionId, project)) return
          if (!principal) { commands.reportError('The BigQuery account could not be verified.'); return }
          if (!wantStarred) explorer.removeBigQuerySessionProject(node.connectionId, project)
          const result = await bigQueryStarred.setStarred(node.connectionId, principal, project, wantStarred)
          if (!result.ok) commands.reportError(result.error)
          else if (wantStarred && objectSearch?.refreshBigQuery) {
            for (const candidate of connections.liveBigQuery()) {
              if (bigQueryPrincipalOf(candidate) === principal && (candidate.options.provider !== 'bigquery' || candidate.options.project !== project)) {
                objectSearch.refreshBigQuery(candidate.id, { scope: { project } })
              }
            }
          }
        }
      })
    ),
    commands.register('bigquery.removeSessionProject', {
      when: args => {
        const node = nodeOf(args)
        return live(node) && node.kind === 'bqProject' && node.bigQueryProjectRole === 'session'
      },
      run: args => {
        const node = nodeOf(args)
        if (!live(node) || node.kind !== 'bqProject' || node.ref.type !== 'object' || !node.ref.object.name) return
        explorer.removeBigQuerySessionProject(node.connectionId, node.ref.object.name)
      }
    }),
    // A server's name as connected to, or the quoted object name.
    commands.register('explorer.copyName', {
      when: args => copyText(args) !== undefined,
      run: async args => { const text = copyText(args); if (text !== undefined) unwrap(await api.writeClipboardText(text)) }
    }),
    // Peek's Properties menu: the facts it read when it opened (the selected ones, else all).
    commands.register('peek.copyProperties', {
      when: args => !!peekPropertiesOf(args)?.text,
      run: async args => { const text = peekPropertiesOf(args)?.text; if (text) unwrap(await api.writeClipboardText(text)) }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
