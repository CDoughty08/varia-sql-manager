import type { SettingDef } from './types'

/** Environment pages. Later environment settings (documents, AutoRecover, the status bar) get area files of their own. */
export const environmentSettings = [
  {
    key: 'environment.fonts.editorFontSize', page: 'environment.fontsAndColors', group: 'Text Editor', label: 'Size', type: 'integer', min: 8, max: 72, default: 13, unit: 'px',
    // SSMS 21 and 22 run on the Visual Studio 2022 shell, whose editor default could not be verified from Microsoft's docs.
    ssmsDefault: '10 pt Consolas (SSMS 18–20; SSMS 22 not verified)', keywords: ['font', 'zoom', 'text size'],
    description: 'The query editor\'s font size, in CSS pixels.'
  }
] as const satisfies readonly SettingDef[]
