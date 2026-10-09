import { useEffect, useRef } from 'react'
import { useWorkbench } from './core/WorkbenchContext'
import { editorFontFamily } from './fonts'
import { bindExplorerDrop } from './explorer/drop'

export default function QueryEditor() {
  const workbench = useWorkbench(), container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const instance = workbench.monaco.editor.create(container.current!, { model: null, theme: 'varia', fontSize: 14, fontFamily: editorFontFamily, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 16 }, tabSize: 4, wordWrap: 'off',
      // The workbench's editor menu (MenuService) replaces Monaco's; right-click still moves the caret first.
      contextmenu: false })
    const binding = workbench.documents.bindEditor(instance)
    const options = workbench.editorOptions.bindEditor(instance)
    // Object Explorer rows dropped on the editor insert their names.
    const drop = bindExplorerDrop(instance)
    return () => { drop.dispose(); options.dispose(); binding.dispose(); instance.dispose() }
  }, [workbench])
  return <div ref={container} style={{ width: '100%', height: '100%' }} />
}
