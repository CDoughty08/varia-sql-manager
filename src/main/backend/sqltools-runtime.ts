import { join } from 'node:path'

/** The trusted app installation, never a path or command supplied by a renderer. Each release includes its own runtime.
 *  Source builds prepare the matching RID under artifacts; installed builds keep it beside the .NET backend. */
export function sqlToolsEnvironment(options: { packaged: boolean; root: string; resourcesPath: string; platform: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const env = { ...options.env ?? process.env }
  if (env.VARIA_SQLTOOLS_SERVICE_PATH?.trim()) {
    env.VARIA_SQLTOOLS_SERVICE_SOURCE = 'override'
    return env
  }
  const platform = options.platform === 'win32' ? 'win' : options.platform === 'darwin' ? 'osx' : options.platform
  const executable = options.platform === 'win32' ? 'MicrosoftSqlToolsServiceLayer.exe' : 'MicrosoftSqlToolsServiceLayer'
  const directory = options.packaged ? join(options.resourcesPath, 'sqltools-service')
    : join(options.root, 'artifacts', 'sqltools-service', `${platform}-${options.arch ?? process.arch}`)
  return { ...env, VARIA_SQLTOOLS_SERVICE_PATH: join(directory, executable), VARIA_SQLTOOLS_SERVICE_SOURCE: 'bundled' }
}
