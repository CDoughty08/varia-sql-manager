import type { SettingDef } from './types'

/**
 * Environment › Product Updates: SSMS 22's page, which installs through the Visual Studio Installer; Varia checks its own
 * GitHub releases (src/shared/updates.ts). Main reads these values; nothing else follows them.
 */
export const updateSettings = [
  {
    key: 'environment.updates.checkAutomatically', page: 'environment.productUpdates', label: 'Automatically check for updates', type: 'boolean', default: true,
    keywords: ['update', 'upgrade', 'version', 'release', 'github', 'proxy'],
    description: 'Checks Varia SQL Manager\'s releases on GitHub shortly after start-up and every four hours while it runs. Help › Check for Updates checks at any time. The check reads one small file from github.com through the system\'s proxy settings and sends nothing about you or your servers.'
  },
  {
    key: 'environment.updates.downloadAutomatically', page: 'environment.productUpdates', label: 'Automatically download updates', type: 'boolean', default: true, enabledBy: 'environment.updates.checkAutomatically', varia: true,
    keywords: ['update', 'download', 'background', 'metered'],
    description: 'Downloads a new release in the background as soon as a check finds it, and verifies it against the release\'s checksum; the status bar shows its progress. Nothing installs until you choose Restart to Update. While it is False, the status bar offers the update and Help › Download Update downloads it.'
  }
] as const satisfies readonly SettingDef[]
