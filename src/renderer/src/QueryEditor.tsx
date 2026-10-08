import { useEffect, useRef } from 'react'
import { useWorkbench } from './core/WorkbenchContext'
import { bindQueryActions } from './contributions/query'

export default function QueryEditor() {
  const workbench = useWorkbench(), container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const instance = workbench.monaco.editor.create(container.current!, { model: null, theme: 'varia', fontSize: 14, fontFamily: "'Cascadia Code', Consolas, monospace", minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 16 }, tabSize: 4, wordWrap: 'off' })
    const binding = workbench.documents.bindEditor(instance)
    const actions = bindQueryActions(workbench, instance)
    return () => { actions.dispose(); binding.dispose(); instance.dispose() }
  }, [workbench])
  return <div ref={container} style={{ width: '100%', height: '100%' }} />
}
