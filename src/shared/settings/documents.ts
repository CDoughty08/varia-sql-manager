import type { SettingDef } from './types'

/**
 * Environment › Documents, as SSMS 22 (the Visual Studio 2022 shell) names it. Later document settings (changes outside
 * the environment, AutoRecover, recently used lists) join this file.
 */
export const documentSettings = [
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
