import type { Platform } from '../../../shared/commands/keybindings'
import type { UpdateState } from '../../../shared/updates'
import { productName } from '../../../shared/product'
import { formatBytes } from '../results/status'

export type AboutUpdateCommand = 'help.checkForUpdates' | 'help.downloadUpdate' | 'help.restartToUpdate' | 'help.releaseNotes' | 'help.openDownloads'
export interface AboutUpdatePresentation {
  readonly title: string
  readonly detail: string
  readonly action?: { readonly command: AboutUpdateCommand; readonly label: string }
  readonly busy?: boolean
  readonly percent?: number
}

export const platformName = (platform: Platform): string => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[platform]
const check = { command: 'help.checkForUpdates', label: 'Check for Updates' } as const
const downloads = { command: 'help.openDownloads', label: 'Open Release Downloads' } as const

/** The dialog projects the same updater state as the status bar; it never starts a check merely by opening. */
export function aboutUpdate(state: UpdateState, platform: Platform): AboutUpdatePresentation {
  if (!state.currentVersion) return { title: 'Version information unavailable', detail: 'Varia has not received its application version and update status.' }
  if (!state.enabled) return { title: 'Development build', detail: 'This copy does not check for updates.' }
  switch (state.status) {
    case 'checking': return { title: 'Checking for updates…', detail: 'You can keep working while Varia checks for a newer release.', busy: true }
    case 'downloading': return {
      title: `Downloading ${state.version}`, detail: `${formatBytes(state.received)} of ${formatBytes(state.total)}. It installs only when you choose Restart to Update.`, busy: true,
      percent: state.total > 0 ? Math.min(100, Math.max(0, Math.floor(state.received / state.total * 100))) : undefined
    }
    case 'preparing': return { title: 'Preparing update…', detail: `Version ${state.version} is verified and is being prepared so restarting to update is quicker.`, busy: true }
    case 'ready': return { title: `Version ${state.version} is ready`, detail: 'Restart closes Varia and asks you to save any unsaved work before installing.', action: { command: 'help.restartToUpdate', label: 'Restart to Update' } }
    case 'available': return state.size !== undefined
      ? { title: `Version ${state.version} is available`, detail: `${formatBytes(state.size)} to download. It installs only when you choose Restart to Update.`, action: { command: 'help.downloadUpdate', label: 'Download Update' } }
      : { title: `Version ${state.version} is available`, detail: platform === 'darwin' ? 'Current macOS builds use manual downloads while they are not code signed.' : 'This release must be downloaded and installed manually for this copy of Varia.', action: downloads }
    case 'error': return { title: state.during === 'check' ? 'Could not check for updates' : state.during === 'download' ? 'Could not download the update' : 'Could not install the update', detail: `${state.message} ${state.hint}`, action: { ...check, label: 'Try Again' } }
    case 'upToDate': return { title: 'No newer version was found at the last check', detail: `You are running ${productName} ${state.currentVersion}.`, action: check }
    case 'idle': return { title: 'Check for a newer version', detail: platform === 'darwin' ? 'This copy can check for releases. Current macOS builds use manual downloads.' : 'You can check for a newer release at any time.', action: check }
  }
}

/** Only application facts: no queries, server names, connection settings, paths or environment variables. */
export function versionDetails(state: UpdateState, platform: Platform): string {
  const installation = !state.currentVersion ? 'Unavailable' : !state.enabled ? 'Development build' : state.kind === 'nsis' ? 'Windows installer' : state.kind === 'portable' ? 'Windows portable' : state.kind === 'appimage' ? 'Linux AppImage' : 'Manual updates'
  return [`${productName} ${state.currentVersion || '(version unavailable)'}`, `Platform: ${platformName(platform)}`, `Build: ${installation}`, `Update status: ${state.currentVersion ? state.status : 'unavailable'}`].join('\n')
}
