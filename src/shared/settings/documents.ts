import type { SettingDef } from './types'

/**
 * Environment › Documents, as SSMS 22 (the Visual Studio 2022 shell) names it, Environment › General's recently used
 * lists, and Environment › AutoRecover (on, every 5 minutes, kept 7 days, as in SSMS).
 */
export const documentSettings = [
  {
    key: 'environment.autoRecover.enabled', page: 'environment.autoRecover', label: 'Save AutoRecover information', type: 'boolean', default: true,
    keywords: ['autorecover', 'recover', 'recovery', 'crash', 'backup', 'unsaved'],
    description: 'Keeps a copy of each query with unsaved changes in Varia SQL Manager\'s profile folder, readable only by you, so a crash, a forced close or a power loss loses at most the last few minutes. The next start offers the copies in Recover Unsaved Queries. Turning it off deletes this window\'s copies; copies left by earlier runs are still offered.'
  },
  {
    key: 'environment.autoRecover.intervalMinutes', page: 'environment.autoRecover', label: 'Save AutoRecover information every', type: 'integer', min: 1, max: 60, default: 5, unit: 'minutes',
    enabledBy: 'environment.autoRecover.enabled', keywords: ['autorecover', 'interval', 'minutes'],
    description: 'How often AutoRecover saves the queries whose text changed since it last saved them.'
  },
  {
    key: 'environment.autoRecover.keepDays', page: 'environment.autoRecover', label: 'Keep AutoRecover information for', type: 'integer', min: 1, max: 90, default: 7, unit: 'days',
    enabledBy: 'environment.autoRecover.enabled', keywords: ['autorecover', 'retention', 'days', 'delete'],
    description: 'How long a copy that was not recovered is kept. Older copies are deleted when Varia SQL Manager starts.'
  },
  {
    key: 'environment.recentFiles.count', page: 'environment.general', label: 'Items shown in recently used file lists', type: 'integer', min: 1, max: 24, default: 10,
    keywords: ['recent', 'recently used', 'most recently used', 'mru', 'file menu'],
    description: 'How many files File › Recent Files lists. Varia SQL Manager remembers up to 50, so a larger number shows older files again.'
  },
  {
    key: 'environment.documents.detectExternalChanges', page: 'environment.documents', label: 'Detect when file is changed outside the environment', type: 'boolean', default: true,
    keywords: ['reload', 'external', 'modified', 'changed on disk', 'deleted'],
    description: 'When the window gets focus, checks whether another program changed or deleted an open file, and asks whether to reload a changed one. Save also asks before replacing such changes.'
  },
  {
    key: 'environment.documents.autoReload', page: 'environment.documents', label: 'Reload modified files unless there are unsaved changes', type: 'boolean', default: false,
    enabledBy: 'environment.documents.detectExternalChanges', keywords: ['reload', 'external', 'modified', 'automatic'],
    description: 'Reloads a file changed outside Varia SQL Manager without asking when its query has no unsaved changes. A query with unsaved changes still asks.'
  },
  {
    key: 'environment.documents.saveWithSpecificEncoding', page: 'environment.documents', label: 'Save files with a specific encoding', type: 'boolean', default: false,
    keywords: ['encoding', 'unicode', 'utf-8', 'utf-16', 'bom', 'signature', 'byte order mark'],
    description: 'Saves every file in Save encoding, converting files read in another encoding. While it is False, a file keeps the encoding it was opened in, and a new query is saved as UTF-8 without a byte order mark: SSMS 22 starts a new query from an empty template that has none.'
  },
  {
    key: 'environment.documents.saveEncoding', page: 'environment.documents', label: 'Save encoding', type: 'enum', default: 'utf8bom', enabledBy: 'environment.documents.saveWithSpecificEncoding',
    values: [
      { value: 'utf8bom', label: 'Unicode (UTF-8 with signature)' },
      { value: 'utf8', label: 'Unicode (UTF-8 without signature)' },
      { value: 'utf16le', label: 'Unicode' },
      { value: 'utf16be', label: 'Unicode (Big-Endian)' }
    ],
    keywords: ['encoding', 'unicode', 'utf-8', 'utf-16', 'bom', 'signature'],
    description: 'The encoding every file is saved in while Save files with a specific encoding is True. Unicode is UTF-16 little-endian.'
  }
] as const satisfies readonly SettingDef[]
