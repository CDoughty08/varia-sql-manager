import { formatBytes } from '../results/status'
import type { ToastAction, ToastInput } from '../core/notifications'
import type { UpdateState } from '../../../shared/updates'
import { unsupportedUpdateHint } from '../../../shared/updates'

export const updateToastKey = 'updates'
export interface UpdateToastActions {
  readonly restart: () => void
  readonly download: () => void
  readonly releaseNotes: () => void
  readonly retry: () => void
}

/**
 * The toast for an update state, or undefined when it has none: a ready update offers Restart to Update (Open installer
 * for the disk image), one waiting to download offers Download, one this copy cannot install points to the releases page,
 * and a failure says what to do about it, with Copy details. One key, so a later state replaces the earlier toast.
 */
export function updateToast(state: UpdateState, run: UpdateToastActions): ToastInput | undefined {
  const notes: ToastAction = { label: 'Release notes', run: run.releaseNotes }
  switch (state.status) {
    case 'upToDate': return { severity: 'info', key: updateToastKey, message: `Varia SQL Manager ${state.currentVersion} is the latest version.` }
    case 'ready': return state.kind === 'dmg'
      ? { severity: 'info', key: updateToastKey, message: `Varia SQL Manager ${state.version} is downloaded. Quit to open its disk image, then drag Varia SQL Manager to Applications.`, actions: [{ label: 'Quit and open', run: run.restart }, notes] }
      : { severity: 'info', key: updateToastKey, message: `Varia SQL Manager ${state.version} is ready to install. It installs when Varia restarts.`, actions: [{ label: 'Restart to update', run: run.restart }, notes] }
    case 'available': return state.size !== undefined
      ? { severity: 'info', key: updateToastKey, message: `Varia SQL Manager ${state.version} is available (${formatBytes(state.size)}).`, actions: [{ label: 'Download', run: run.download }, notes] }
      : { severity: 'info', key: updateToastKey, message: `Varia SQL Manager ${state.version} is available. ${state.kind === 'unsupported' ? unsupportedUpdateHint : 'This release has no download for this computer.'}`, actions: [{ label: 'Open releases page', run: run.releaseNotes }] }
    case 'error': return {
      severity: 'error', key: updateToastKey, message: `${state.message} ${state.hint}`,
      actions: [{ label: 'Try again', run: run.retry }, { label: 'Open releases page', run: run.releaseNotes }],
      report: { code: `UPDATE_${state.code.replace(/[A-Z]/g, letter => '_' + letter).toUpperCase()}`, context: state.during === 'check' ? 'Checking for updates' : state.during === 'download' ? `Downloading Varia SQL Manager ${state.version ?? ''}`.trim() : 'Installing the update', ...(state.detail ? { extra: `Detail: ${state.detail}` } : {}) }
    }
    default: return undefined
  }
}
