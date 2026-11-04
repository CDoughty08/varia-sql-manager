// Help › Check for Updates: the release feed, how each build installs an update, and the states and failures the page
// shows. Main alone fetches, verifies and installs (src/main/updater.ts); the page only sees `UpdateState`.
import { z } from 'zod'

/** The public repository whose GitHub releases are the update feed. */
export const updateRepository = { owner: 'CDoughty08', repo: 'varia-sql-manager' } as const
/** The manifest every release carries (`scripts/update-manifest.mjs` writes it in the release job). */
export const updateManifestName = 'varia-update.json'
const releases = `https://github.com/${updateRepository.owner}/${updateRepository.repo}/releases`
/**
 * GitHub's "latest release" download link, which skips pre-releases and drafts and redirects to its asset host. It is not
 * the REST API, so many users behind one corporate address never meet the API's per-address rate limit.
 */
export const updateFeedUrl = `${releases}/latest/download/${updateManifestName}`
/** Where people download a release by hand: the page a blocked or unsupported build points to. */
export const releasesPageUrl = `${releases}/latest`
/** The hosts a network must allow for updates; the error hints name them. */
export const updateHosts = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'] as const

export const updateLimits = {
  /** The manifest, read whole into memory. */
  manifestBytes: 65_536,
  /** One downloaded file; a manifest naming a bigger one is refused. */
  assetBytes: 1_073_741_824,
  assets: 32,
  nameChars: 128,
  /** The manifest's whole request. */
  manifestTimeoutMs: 30_000,
  /** A download fails when no byte arrives for this long; a slow one keeps going. */
  stallTimeoutMs: 60_000,
  /** At most one progress state a this often while a download runs. */
  progressIntervalMs: 250,
  /** The first automatic check, after start-up has settled. */
  firstCheckMs: 15_000,
  /** Between automatic checks. */
  checkIntervalMs: 4 * 3_600_000,
  /** After an automatic check failed (a laptop that was offline, a VPN not yet up). */
  retryMs: 30 * 60_000
} as const

/** How this build installs an update; main decides from how it was started (`installKindFor`). */
export type InstallKind = 'nsis' | 'portable' | 'appimage' | 'dmg' | 'unsupported'
export type AssetKind = 'win-setup' | 'win-portable' | 'linux-appimage' | 'mac-dmg' | 'mac-zip'
export type AssetArch = 'x64' | 'arm64'
export const assetKindFor: Readonly<Record<Exclude<InstallKind, 'unsupported'>, AssetKind>> = { nsis: 'win-setup', portable: 'win-portable', appimage: 'linux-appimage', dmg: 'mac-dmg' }

const version = z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Not a version.')
// Release file names only: no separators or dots that could leave the download folder.
export const assetNamePattern = /^Varia-SQL-Manager-[0-9A-Za-z._-]+\.(?:exe|AppImage|dmg|zip)$/
const sha512 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'Not a base64 SHA-512.')
export const updateManifestSchema = z.strictObject({
  schema: z.literal(1),
  version,
  releasedAt: z.iso.datetime().optional(),
  assets: z.array(z.strictObject({
    name: z.string().max(updateLimits.nameChars).regex(assetNamePattern),
    kind: z.enum(['win-setup', 'win-portable', 'linux-appimage', 'mac-dmg', 'mac-zip']),
    arch: z.enum(['x64', 'arm64']),
    size: z.int().min(1).max(updateLimits.assetBytes),
    sha512
  })).max(updateLimits.assets)
})
export type UpdateManifest = z.infer<typeof updateManifestSchema>
export type UpdateAsset = UpdateManifest['assets'][number]

/** The tagged release's download link for one of its files. */
export const assetUrl = (manifestVersion: string, name: string) => `${releases}/download/v${encodeURIComponent(manifestVersion)}/${encodeURIComponent(name)}`

/** The file this build installs from, if the release has one for its kind and architecture. */
export function assetFor(manifest: UpdateManifest, kind: InstallKind, arch: string): UpdateAsset | undefined {
  if (kind === 'unsupported') return undefined
  return manifest.assets.find(asset => asset.kind === assetKindFor[kind] && asset.arch === arch)
}

const parts = (text: string) => {
  const [core, pre] = text.split('-', 2) as [string, string | undefined]
  return { core: core.split('.').map(Number), pre: pre === undefined ? [] : text.slice(core.length + 1).split('.') }
}
/** Semantic version order: negative when `a` is older. A pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a), y = parts(b)
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0)
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    if (p === q) continue
    const numeric = /^\d+$/.test(p) && /^\d+$/.test(q)
    if (numeric) return Number(p) - Number(q)
    if (/^\d+$/.test(p) !== /^\d+$/.test(q)) return /^\d+$/.test(p) ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

export type UpdateErrorCode = 'offline' | 'dns' | 'proxy' | 'proxyAuth' | 'tls' | 'blocked' | 'timeout' | 'server' | 'notFound' | 'invalidFeed' | 'integrity' | 'disk' | 'notWritable' | 'install' | 'unknown'
const allow = `Ask your IT team to allow ${updateHosts.slice(0, 2).join(' and ')}, or download the update from the releases page.`
/**
 * What each failure means and what to do about it, in the words the toast and the status bar's tooltip show. The network
 * ones are the corporate cases: proxies, TLS inspection and filters that block or replace GitHub's answers.
 */
export const updateErrors: { readonly [C in UpdateErrorCode]: { readonly message: string; readonly hint: string } } = {
  offline: { message: 'Varia could not check for updates: this computer appears to be offline.', hint: 'Updates are checked again once you are back online.' },
  dns: { message: 'Varia could not reach github.com: its name did not resolve.', hint: `A DNS filter may block it. ${allow}` },
  proxy: { message: 'Your network\'s proxy refused the connection to GitHub.', hint: `Varia uses the system proxy settings. ${allow}` },
  proxyAuth: { message: 'Your network\'s proxy asked for a sign-in that Varia cannot supply.', hint: `Varia signs in to proxies with your Windows or Kerberos account only. ${allow}` },
  tls: { message: 'The connection to GitHub was not trusted: its certificate is not one this computer trusts.', hint: 'A network that inspects HTTPS needs its certificate in the system\'s certificate store. Ask your IT team, or download the update from the releases page.' },
  blocked: { message: 'Your network blocked the connection to GitHub.', hint: allow },
  timeout: { message: 'GitHub did not answer in time.', hint: `The network may be slow or may silently drop the connection. ${allow}` },
  server: { message: 'GitHub could not answer the update check right now.', hint: 'Updates are checked again later.' },
  notFound: { message: 'No release with an update manifest has been published yet.', hint: 'Updates are checked again later.' },
  invalidFeed: { message: 'The update check got an answer that is not Varia\'s release manifest.', hint: `A proxy or content filter may have replaced GitHub's answer. ${allow}` },
  integrity: { message: 'The downloaded update did not match the release\'s checksum, so it was discarded.', hint: `A proxy or content filter may have changed it. ${allow}` },
  disk: { message: 'There is not enough disk space to download the update.', hint: 'Free some space, then check for updates again.' },
  notWritable: { message: 'Varia cannot write the update next to the application.', hint: 'Move Varia to a folder you can write to, or download the update from the releases page.' },
  install: { message: 'The update could not be started.', hint: 'Download the update from the releases page and install it by hand.' },
  unknown: { message: 'The update failed.', hint: 'Check for updates again, or download the update from the releases page.' }
}

/** What the update check is doing, as the page shows it; every state names the running version and how it installs. */
export type UpdatePhase =
  | { readonly status: 'idle' }
  | { readonly status: 'checking'; readonly manual: boolean }
  | { readonly status: 'upToDate'; readonly checkedAt: number }
  /** A newer release that this build cannot install itself (or that waits for Download Update). */
  | { readonly status: 'available'; readonly version: string; readonly size?: number }
  | { readonly status: 'downloading'; readonly version: string; readonly received: number; readonly total: number }
  /** Downloaded and verified: Restart to Update installs it. */
  | { readonly status: 'ready'; readonly version: string }
  | { readonly status: 'error'; readonly code: UpdateErrorCode; readonly during: 'check' | 'download' | 'install'; readonly manual: boolean; readonly message: string; readonly hint: string; readonly detail?: string; readonly version?: string }
export type UpdateState = UpdatePhase & {
  readonly currentVersion: string
  readonly kind: InstallKind
  /** Whether updates are checked at all: packaged builds, and smoke runs with a test feed. */
  readonly enabled: boolean
}

/** The phase's words for the status bar; undefined hides it (nothing to say). */
export function updateStatusText(state: UpdateState): string | undefined {
  switch (state.status) {
    case 'downloading': return `Downloading update ${state.total ? Math.floor(state.received / state.total * 100) : 0}%`
    case 'ready': return state.kind === 'dmg' ? `Update ${state.version} downloaded` : `Restart to update to ${state.version}`
    case 'available': return `Update ${state.version} available`
    case 'error': return state.during === 'check' ? 'Update check failed' : 'Update failed'
    case 'checking': return state.manual ? 'Checking for updates…' : undefined
    default: return undefined
  }
}

/** The checks that Help › Check for Updates offers once this build cannot install, said once in the tooltip and docs. */
export const unsupportedUpdateHint = 'This copy of Varia cannot update itself (it was not installed with the Windows installer, nor run as the portable app, the AppImage or from the disk image). Download new releases from the releases page.'
