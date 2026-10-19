import { useEffect, useRef } from 'react'
import { useWorkbench } from './core/WorkbenchContext'
import { editorFontFamily } from './fonts'
import { bindExplorerDrop } from './explorer/drop'

export default function QueryEditor() {
  const workbench = useWorkbench(), container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const instance = workbench.monaco.editor.create(container.current!, {
      model: null,
      theme: 'varia',
      // Tools › Options: font size, word wrap, line numbers, drag and drop, current-line highlight. Indentation is the model's.
      ...workbench.editorOptions.monacoOptions(),
      fontFamily: editorFontFamily,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      padding: { top: 16 },
      // The workbench's editor menu (MenuService) replaces Monaco's; right-click still moves the caret first.
      contextmenu: false,
      // OVR (the Insert key) shows a block caret, as Visual Studio does.
      overtypeCursorStyle: 'block'
    })
    const binding = workbench.documents.bindEditor(instance)
    const options = workbench.editorOptions.bindEditor(instance)
    const status = workbench.editorStatus.bindEditor(instance)
    // Object Explorer rows dropped on the editor insert their names.
    const drop = bindExplorerDrop(instance)
    return () => { drop.dispose(); status.dispose(); options.dispose(); binding.dispose(); instance.dispose() }
  }, [workbench])
  return <div ref={container} style={{ width: '100%', height: '100%' }} />
}
