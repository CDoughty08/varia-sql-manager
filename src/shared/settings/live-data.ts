import type { SettingDef } from './types'

/**
 * Environment › Live Data: how live views (the Activity Monitor, SSIS monitoring) behave while nobody can see them, and
 * how much history they keep. SSMS has no such page; its Activity Monitor keeps querying until a pane is collapsed. A
 * view's own refresh intervals belong to the view's settings, bounded by its probes in the live catalogue.
 */
export const liveDataSettings = [
  {
    key: 'liveData.pauseWhenHidden', page: 'environment.liveData', label: 'Pause live views that are hidden', type: 'boolean', default: true, varia: true,
    keywords: ['live', 'pause', 'hidden', 'background', 'minimized', 'activity monitor', 'server load'],
    description: 'Stops a live view\'s queries on the server while its tab is not the one showing, or the window is minimized or hidden, and starts them again as soon as it shows. Charts show the gap. While it is False, hidden views keep querying at their usual intervals.'
  },
  {
    key: 'liveData.pauseAfterSeconds', page: 'environment.liveData', label: 'Pause after hidden for', type: 'integer', min: 1, max: 60, default: 2, unit: 'seconds', varia: true,
    enabledBy: 'liveData.pauseWhenHidden', keywords: ['live', 'pause', 'hidden', 'delay', 'seconds'],
    description: 'How long a live view stays hidden before its queries stop, so switching tabs for a moment loses no samples.'
  },
  {
    key: 'liveData.stopAfterHiddenMinutes', page: 'environment.liveData', label: 'Stop after hidden for', type: 'integer', min: 1, max: 60, default: 5, unit: 'minutes', varia: true,
    enabledBy: 'liveData.pauseWhenHidden', keywords: ['live', 'stop', 'hidden', 'session', 'minutes', 'dormant'],
    description: 'How long a paused, hidden live view keeps its subscription before it ends it and frees what the backend holds for it. Showing the view again starts a new subscription; its history is kept.'
  },
  {
    key: 'liveData.historyMinutes', page: 'environment.liveData', label: 'Keep chart history for', type: 'integer', min: 5, max: 120, default: 60, unit: 'minutes', varia: true,
    keywords: ['live', 'history', 'chart', 'minutes', 'memory'],
    description: 'How far back each live view\'s charts reach. History is kept in memory only (at most 7,200 samples a chart, 4 MiB a view and 32 MiB in all; the newest samples are kept), never on disk, and is lost when the window reloads.'
  }
] as const satisfies readonly SettingDef[]
