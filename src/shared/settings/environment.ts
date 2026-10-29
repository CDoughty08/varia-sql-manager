import type { SettingDef } from './types'

/**
 * Environment pages. Later environment settings (documents, AutoRecover, the status bar) get area files of their own. The
 * classic toolbar keeps the layout from before the header row and the query bar for one release.
 */
export const environmentSettings = [
  {
    key: 'environment.fonts.editorFontSize', page: 'environment.fontsAndColors', group: 'Text Editor', label: 'Size', type: 'integer', min: 8, max: 72, default: 13, unit: 'px',
    // SSMS 21 and 22 run on the Visual Studio 2022 shell, whose editor default could not be verified from Microsoft's docs.
    ssmsDefault: '10 pt Consolas (SSMS 18–20; SSMS 22 not verified)', keywords: ['font', 'zoom', 'text size'],
    description: 'The query editor\'s font size, in CSS pixels.'
  },
  {
    key: 'environment.layout.classicToolbar', page: 'environment.general', label: 'Show the classic toolbar', type: 'boolean', default: false, varia: true,
    keywords: ['toolbar', 'standard', 'classic', 'legacy', 'server', 'database', 'execute', 'layouts'],
    description: 'Shows the text toolbar of earlier versions below the header: Connect, New query, Open, Save, Save All, Execute, Cancel and Layouts, with the active query\'s Server and Database boxes. The header then keeps only the menus and the search box, and query tabs show no query bar of their own. This option will be removed in a later release.'
  },
  {
    key: 'environment.layout.panelTabs', page: 'environment.general', label: 'Show panel tabs', type: 'boolean', default: false, varia: true, hidden: true,
    keywords: ['panel', 'tab', 'dock', 'header', 'drag'],
    description: 'Window › Panel Tabs: a panel that is alone in its dock group shows its tab, which can be dragged to dock the panel elsewhere. Without it such a panel shows no tab and moves through its ⋯ menu. Panels that share a group, and floating panels, always show their tabs.'
  }
] as const satisfies readonly SettingDef[]
