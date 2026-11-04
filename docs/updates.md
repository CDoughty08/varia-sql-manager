# Updates

Varia SQL Manager updates itself from this repository's [GitHub releases](https://github.com/CDoughty08/varia-sql-manager/releases).
Main does all of it (`src/main/updater.ts`, `src/main/update-install.ts`); the page only shows the state main pushes
(`UpdateState` in `src/shared/updates.ts`) and runs the Help commands.

## How a release is found

Every release carries `varia-update.json`, written by the release job (`scripts/update-manifest.mjs`): the version and,
for each packaged file, its kind, architecture, size and SHA-512. Varia reads it from
`https://github.com/CDoughty08/varia-sql-manager/releases/latest/download/varia-update.json`, which skips pre-releases and drafts.
That link is not the REST API, so many people behind one corporate address do not share the API's rate limit.

Checks run 15 seconds after start-up and every four hours (30 minutes after a failed check), unless **Environment › Product
Updates › Automatically check for updates** is off. **Help › Check for Updates** checks at any time. A newer release
downloads at once unless **Automatically download updates** is off; then the status bar and **Help › Download Update** offer it.

## What each build does

| Build | How Varia tells | Where the download goes | Restart to Update |
| --- | --- | --- | --- |
| Windows Setup (installed) | `Uninstall Varia SQL Manager.exe` beside the app | `<profile>/updates` | Runs the new Setup silently (`--updated /S --force-run`) into the same folder and mode; a per-machine installation asks for elevation. Varia starts again afterwards. |
| Windows Portable | `PORTABLE_EXECUTABLE_FILE` | A hidden `.…Portable.exe.update` beside the portable executable | Renames the running executable to `.old` (removed at the next start), moves the new one into its place, and starts it. |
| Linux AppImage | `APPIMAGE` | A hidden `.…AppImage.update` beside the AppImage | Replaces the AppImage (renamed to the new version when its name had the old one) and starts it. |
| macOS (DMG or ZIP) | A packaged `.app` bundle | `<profile>/updates` | Quits and opens the new disk image; drag the app to Applications. Builds are unsigned, so they cannot replace themselves. |
| Anything else (an unpacked folder, a development run) | — | — | Not offered: the toast points to the releases page. Development builds never check. |

Nothing installs until **Restart to Update** (in the Help menu, the status bar or the toast). It closes Varia as File › Exit
does, so queries with unsaved changes ask first; cancelling that keeps Varia running and installs nothing. The update
installs only after the windows have closed and the SQL backend has stopped.

## Integrity

A download is written beside a hidden `.partial` name and hashed as it arrives. It is kept only when its size and SHA-512
match the manifest; otherwise it is deleted and the failure says a proxy may have changed it. A file verified by an
earlier run is hashed again and reused. Manifests are strict (`updateManifestSchema`): file names are release names only,
sizes are bounded (1 GiB), and the manifest itself is at most 64 KiB. The real feed must end on `https`.

## Networks

Requests go through Chromium's network stack in a session of their own (no cookies or cache): the system proxy settings
(PAC files included), Windows or Kerberos sign-in to proxies, and the operating system's certificate store, so networks that
inspect HTTPS work once their certificate is installed. A network must allow `github.com` and
`release-assets.githubusercontent.com` (older releases may redirect to `objects.githubusercontent.com`).

Failures are named for what can be done about them, with the remedy in the toast and Copy details giving Chromium's error
or the HTTP status:

| Code | Typical cause |
| --- | --- |
| `offline` | No network. |
| `dns` | `github.com` does not resolve (a DNS filter). |
| `proxy` | The proxy refused the tunnel (`ERR_TUNNEL_CONNECTION_FAILED`, a PAC failure). |
| `proxyAuth` | The proxy wants credentials Varia cannot supply (HTTP 407, Basic authentication). |
| `tls` | The certificate is not trusted (HTTPS inspection without its root installed). |
| `blocked` | The network refused or reset the connection, HTTP 403/451, or a block page in place of the file. |
| `invalidFeed` | A captive portal's or filter's page in place of the manifest. |
| `timeout` | No answer in 30 seconds (the manifest), or no byte for 60 seconds (a download). |
| `integrity` | The file's size or SHA-512 differs from the manifest. |
| `disk`, `notWritable` | No space, or the portable executable's or AppImage's folder is read-only. |

An automatic check that fails shows only in the status bar (**Update check failed**, with the reason in its tooltip; select
it to try again), so a network that blocks GitHub does not raise a toast every few hours. A failure of Check for Updates, of
a download or of an install is a toast with **Try again** and **Open releases page**.

## Testing

`tests/updater.test.ts` drives the updater with streamed answers (progress, checksums, filter pages, proxy errors, stalls,
the schedule); `tests/update-install.test.ts` swaps real files in a temporary folder; `tests/update-manifest.test.ts`
checks the manifest script against the release job's file names. `scripts/updates-smoke.mjs` runs the app against a
loopback feed (`VARIA_TEST_UPDATE_FEED`, honoured only in unpackaged smoke runs, with `VARIA_TEST_UPDATE_KIND`), whose
install writes `update-applied.json` in the profile instead of running anything.
