// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { agentPropertiesText, initialAgentPropertiesDraft, type AgentPropertiesModel } from '../src/shared/actions/agent-properties'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { OpenObjectDialog } from '../src/renderer/src/dialogs/ObjectDialogService'
import { AgentGeneralPage, AgentHistoryPage } from '../src/renderer/src/dialogs/pages/AgentPropertiesPages'

const model = (changes: Partial<AgentPropertiesModel> = {}): AgentPropertiesModel => ({
  settings: { sqlserverRestart: true, monitorAutostart: true, historyMaxRows: 1000, historyMaxRowsPerJob: 100 },
  serverNow: '2026-03-31T10:00:00', serverOffsetMinutes: 0, history: { total: 10, recent: 0, jobs: [], jobsTruncated: false, ages: [] }, ...changes
})
function draw(page: typeof AgentGeneralPage, described: AgentPropertiesModel): HTMLElement {
  const open = { id: 1, dialog: 'agentProperties', phase: 'ready', target: { kind: 'agent' }, server: 'box', connectionId: 'a', model: described, draft: initialAgentPropertiesDraft(described) } as unknown as OpenObjectDialog
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(createElement(WorkbenchProvider, { workbench: { dialogs: {} } as unknown as Workbench, children: createElement(page, { open, editable: true }) }))
  return host
}

describe('SQL Server Agent Properties pages', () => {
  it('on Linux show the settings read-only with the reason and keep Delete old history usable', () => {
    const linux = model({ settingsNote: agentPropertiesText.linux })
    const general = draw(AgentGeneralPage, linux), history = draw(AgentHistoryPage, linux)
    expect(general.textContent).toContain(agentPropertiesText.linux)
    expect([...general.querySelectorAll('fieldset')].every(set => set.disabled)).toBe(true)
    const sets = [...history.querySelectorAll('fieldset')]
    expect(history.textContent).toContain(agentPropertiesText.linux)
    expect(sets.find(set => set.textContent?.startsWith('Job history log'))?.disabled).toBe(true)
    expect(sets.find(set => set.textContent?.startsWith('Delete old history now'))?.disabled).toBe(false)
  })
  it('keeps the settings editable where they can change', () => {
    const history = draw(AgentHistoryPage, model())
    expect(history.textContent).not.toContain(agentPropertiesText.linux)
    expect([...history.querySelectorAll('fieldset')].find(set => set.textContent?.startsWith('Job history log'))?.disabled).toBe(false)
  })
  it('words its reasons as the backend sends them', () => {
    const backend = readFileSync('backend/Varia.Backend/Actions/AgentProperties.cs', 'utf8')
    for (const text of [agentPropertiesText.linux, agentPropertiesText.managedInstance, agentPropertiesText.notSysadmin, agentPropertiesText.historyHidden]) expect(backend).toContain(`"${text}"`)
  })
})
