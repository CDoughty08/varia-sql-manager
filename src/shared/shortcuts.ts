import type { AppMenu, WorkbenchCommand } from './contracts'

export function fileShortcut(key: string, shift: boolean): WorkbenchCommand | undefined {
  const normalized = key.toLowerCase()
  if (normalized === 's') return shift ? 'file.saveAs' : 'file.save'
  if (shift) return undefined
  switch (normalized) {
    case 'n': return 'file.new'
    case 'o': return 'file.open'
    case 'w': return 'file.close'
    default: return undefined
  }
}

export function menuShortcut(key: string): AppMenu | undefined {
  switch (key.toLowerCase()) {
    case 'f': return 'file'
    case 'e': return 'edit'
    case 'v': return 'view'
    case 'w': return 'window'
    default: return undefined
  }
}
