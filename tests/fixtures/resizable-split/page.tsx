// Standalone ResizableSplit fixture for AP-1 live Electron capture (hover/drag states in Dark and Light).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/renderer/src/styles.css'
import ResizableSplit from '../../../src/renderer/src/kit/ResizableSplit'
import { followReducedMotion, reducedMotionQuery } from '../../../src/renderer/src/services/reduced-motion'
import { colorKeys, cssVariable } from '../../../src/shared/theme/registry'
import { resolveBuiltin } from '../../../src/shared/theme/resolve'

function applyTheme(mode: 'dark' | 'light') {
  const theme = resolveBuiltin(mode)
  for (const key of colorKeys) document.documentElement.style.setProperty(cssVariable(key), theme.colors[key])
  document.documentElement.dataset.theme = theme.type
  document.documentElement.dataset.themeType = theme.type
  document.documentElement.style.colorScheme = theme.type
}

const params = new URLSearchParams(location.search)
applyTheme(params.get('theme') === 'light' ? 'light' : 'dark')
const reducedMotion = followReducedMotion(document.documentElement, { enabled: () => true, subscribe: () => () => {}, media: matchMedia(reducedMotionQuery) })
Object.assign(window, {
  __variaMotion: { refresh: () => reducedMotion.refresh() },
  __setFixtureTheme: (mode: 'dark' | 'light') => applyTheme(mode)
})

const steps = [
  { id: 1, name: 'Extract staging tables', subsystem: 'TSQL', onSuccess: 'Step 2', onFail: 'Quit failing' },
  { id: 2, name: 'Run SSIS warehouse load', subsystem: 'SSIS', onSuccess: 'Step 3', onFail: 'Quit failing' },
  { id: 3, name: 'Archive daily partitions', subsystem: 'PS', onSuccess: 'Quit succeeding', onFail: 'Quit failing' }
]

function Page() {
  const [selected, setSelected] = useState(2)
  const [width, setWidth] = useState(304)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--varia-editor-background)', color: 'var(--varia-foreground)' }}>
      <div style={{ padding: 'var(--varia-space-2) var(--varia-space-4)', borderBottom: '1px solid var(--varia-panel-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="agent-eyebrow" style={{ margin: 0 }}>ResizableSplit · agent.job.steps</span>
        <span className="agent-mono">{width} px</span>
      </div>
      <ResizableSplit
        side="left"
        defaultWidth={304}
        minWidth={252}
        maxWidth={480}
        minOtherWidth={360}
        label="Resize steps rail"
        railLabel="Steps"
        width={width}
        onWidthChange={setWidth}
        onWidthReset={() => setWidth(304)}
        rail={
          <div style={{ padding: 'var(--varia-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--varia-space-2)' }}>
            <h3 className="agent-eyebrow">Steps ({steps.length})</h3>
            {steps.map(step => (
              <button
                key={step.id}
                type="button"
                aria-pressed={selected === step.id}
                onClick={() => setSelected(step.id)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  textAlign: 'left',
                  padding: 'var(--varia-space-2)',
                  border: '1px solid var(--varia-panel-border)',
                  background: selected === step.id ? 'var(--varia-list-inactiveSelectionBackground)' : 'transparent',
                  color: selected === step.id ? 'var(--varia-list-inactiveSelectionForeground)' : 'inherit',
                  transition: 'none'
                }}
              >
                <span>{step.id} · {step.name}</span>
                <span className="agent-mono">{step.subsystem}</span>
              </button>
            ))}
          </div>
        }
      >
        <div style={{ padding: 'var(--varia-space-3) var(--varia-space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--varia-space-3)' }}>
          <h3 className="agent-eyebrow">Recent executions</h3>
          <table className="agent-table" aria-label="Step executions">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Step</th>
                <th scope="col">Subsystem</th>
                <th scope="col">On success</th>
                <th scope="col" className="num">Duration</th>
              </tr>
            </thead>
            <tbody>
              {steps.map(step => (
                <tr key={step.id} aria-selected={selected === step.id}>
                  <td className="num">{step.id}</td>
                  <td>{step.name}</td>
                  <td className="agent-mono">{step.subsystem}</td>
                  <td>{step.onSuccess}</td>
                  <td className="num">00:00:14</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ResizableSplit>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Page />)
