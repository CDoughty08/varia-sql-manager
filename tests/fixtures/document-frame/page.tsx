// The document frame alone in a page, for scripts/document-frame-smoke.mjs: what React and real layout do with the
// frame's handlers (the section list's keys and scroll, a collapsed section chosen from the list, the drawer's splitter
// and its ways out), which the markup tests cannot reach. The frame holds no state, so this page keeps it as a
// document's service would and records what the frame asks for in window.__frameFixture. With wrap=clipped the frame
// runs past the bottom of an overflow: hidden box, as a document can inside a dock panel.
import { useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import * as monaco from 'monaco-editor/editor/editor.api.js'
// The codicon font face, as start.tsx loads it.
import 'monaco-editor/features/codicon/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import '../../../src/renderer/src/styles.css'
import { DocumentFrameView, type FrameSection, type HeaderVerb } from '../../../src/renderer/src/kit/DocumentFrame'
import { initialFrameState, type FrameState } from '../../../src/renderer/src/kit/document-frame'
import StatusPill from '../../../src/renderer/src/kit/StatusPill'
import type { ScriptDestination } from '../../../src/shared/scripting/catalog'
import { colorKeys, cssVariable } from '../../../src/shared/theme/registry'
import { resolveBuiltin } from '../../../src/shared/theme/resolve'

interface Fixture { frame?: FrameState; delivered: ScriptDestination[]; ran: string[]; setState?: (label: string) => void; setSubtitle?: (subtitle: string) => void }
const fixture: Fixture = { delivered: [], ran: [] }
;(window as unknown as { __frameFixture: Fixture }).__frameFixture = fixture

// Monaco writes the codicon glyph rules only once an editor registers with its theme service, as the app's first query
// editor does; without them every icon in the frame would draw nothing.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
const host = document.createElement('div')
host.hidden = true
document.body.append(host)
monaco.editor.create(host)

const params = new URLSearchParams(location.search)
const theme = resolveBuiltin(params.get('theme') === 'light' ? 'light' : 'dark')
for (const key of colorKeys) document.documentElement.style.setProperty(cssVariable(key), theme.colors[key])
document.documentElement.dataset.theme = theme.type

const rows = (count: number, prefix: string) => <table><tbody>{Array.from({ length: count }, (_, index) => <tr key={index}><td>{`${prefix} ${index + 1}`}</td><td>value</td></tr>)}</tbody></table>
// Database Properties' pages; Options and Permissions start collapsed. "many" gives a list longer than its box.
const sections: FrameSection[] = params.get('sections') === 'many'
  ? Array.from({ length: 40 }, (_, index) => ({ id: `s${index + 1}`, title: `Section ${index + 1}`, content: rows(6, `Row ${index + 1}.`) }))
  : [
    { id: 'general', title: 'General', content: rows(8, 'Fact') },
    { id: 'files', title: 'Files', problem: true, content: rows(30, 'File') },
    { id: 'filegroups', title: 'Filegroups', content: rows(6, 'Filegroup') },
    { id: 'options', title: 'Options', collapsible: true, content: rows(40, 'Option') },
    { id: 'tracking', title: 'Change Tracking', content: rows(12, 'Setting') },
    // Long enough to be cut where the list is narrow.
    { id: 'shipping', title: 'Transaction Log Shipping', content: rows(4, 'Shipping') },
    { id: 'permissions', title: 'Permissions', collapsible: true, content: rows(3, 'Permission') },
    { id: 'extended', title: 'Extended Properties', content: rows(2, 'Property') }
  ]
const script = Array.from({ length: 60 }, (_, index) => `ALTER DATABASE [AdventureWorks] SET OPTION_${index} = ON WITH NO_WAIT\nGO`).join('\n') + '\n'

function Page() {
  const [frame, setFrame] = useState<FrameState>(() => ({ ...initialFrameState(sections, { collapsed: ['options', 'permissions'] }), scriptOpen: true }))
  const [split, setSplit] = useState(true)
  const [notice, setNotice] = useState('')
  const [stateLabel, setStateLabel] = useState('Unsaved changes')
  const [subtitle, setSubtitle] = useState('Database Properties')
  fixture.frame = frame
  fixture.setState = setStateLabel
  fixture.setSubtitle = setSubtitle
  const verb = (label: string, extra: Partial<HeaderVerb>): HeaderVerb => ({ key: label, label, title: label, disabled: false, run: () => { fixture.ran.push(label) }, ...extra })
  const verbs = [
    verb('Stop', { emphasis: 'danger', icon: 'debug-stop' }),
    verb('Refresh', { emphasis: 'outline', icon: 'refresh' }),
    verb('Split View', { pressed: split, run: () => { fixture.ran.push('Split View'); setSplit(on => !on) } }),
    verb('Save', { emphasis: 'primary', title: 'Save (Ctrl+S)' })
  ]
  return <DocumentFrameView id="doc" title="AdventureWorks" subtitle={subtitle} crumbs={[{ label: 'sqlprod-cluster-node-01.corp.example.com\\INSTANCE2025' }, { label: 'Databases' }]}
    state={<StatusPill tone="warning" label={stateLabel} />} verbs={verbs} facts={[{ label: 'Owner', value: 'sa' }, { label: 'Status', value: 'Normal' }]}
    sections={sections} frame={frame} onFrame={setFrame}
    script={{ content: { state: 'ready', text: script }, notice, onDeliver: destination => { fixture.delivered.push(destination); setNotice(`Delivered to ${destination}.`) } }} />
}

const frame = <div style={{ display: 'flex', height: '100vh' }}><Page /></div>
const clipped = (children: ReactNode) => <div id="clip" style={{ height: '100vh', overflow: 'hidden' }}><div style={{ height: '50vh' }} />{children}</div>
createRoot(document.getElementById('root')!).render(params.get('wrap') === 'clipped' ? clipped(frame) : frame)
