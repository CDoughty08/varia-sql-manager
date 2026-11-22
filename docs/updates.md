# Updates

Varia SQL Manager updates itself from this repository's [GitHub releases](https://github.com/CDoughty08/varia-sql-manager/releases).
Main does all of it (`src/main/updater.ts`, `src/main/update-install.ts`, `src/main/update-staging.ts`); the page only
shows the state main pushes (`UpdateState` in `src/shared/updates.ts`) and runs the Help commands.

**Help > Release Notes** reads bundled, curated notes. A notification's **Release notes** action asks for that exact
version; if its notes are not bundled, the reader says so and offers the installed version's. **Open Release Downloads**
opens the fixed GitHub releases page for manual installation. Missing notes never block an update. See
[Release Notes](release-notes.md).

## Installing

The Windows Setup opens a wizard that installs for the current user or for all users. For unattended deployment, run
`Varia-SQL-Manager-<version>-Windows-x64-Setup.exe --silent`; the standard NSIS `/S` also works (`build/installer.nsh`).
A fresh silent installation defaults to the current user; `/allusers` requests an all-users installation and may need
elevation. The Portable executable runs without installing: it extracts the application to a temporary directory and
uses the normal user profile for settings and saved connections. The Linux AppImage and the extracted macOS ZIP also
run without installing.

## How a release is found

Every release carries `varia-update-v2.json`, written by the release job (`scripts/update-manifest.mjs`): the version and,
per packaged file, its kind, architecture, size and SHA-512. Varia reads it from
`https://github.com/CDoughty08/varia-sql-manager/releases/latest/download/varia-update-v2.json`, which skips pre-releases and
drafts and is not subject to the REST API's per-address rate limit.

- Builds up to 0.7.0 read `varia-update.json` and refuse unknown kinds or fields, so the release job must keep writing
  that file in its first shape (schema 1, without the Windows archive) for as long as those builds are to update.
- The current manifest is read tolerantly: unknown fields, and files a build cannot use (unknown kind or architecture, a
  name or size out of bounds), are skipped, so adding a kind needs no third file. What is kept is fully checked.
  `scripts/update-manifest.mjs` refuses to write a file outside the bounds, failing the packaging job.

Checks run 15 seconds after start-up and every four hours (30 minutes after a failed check), unless **Environment ›
Product Updates › Automatically check for updates** is off. **Help › Check for Updates** checks at any time. A newer
release downloads at once unless **Automatically download updates** is off; then the status bar and **Help › Download
Update** offer it.

## What each build does

| Build | How Varia tells | Where the download goes | Restart to Update |
| --- | --- | --- | --- |
| Windows Setup (installed), in a folder the user can write | `Uninstall Varia SQL Manager.exe` beside the app, and the update helper in its resources | The archive to `<profile>/updates`, then unpacked to `.<installation folder>.update` beside the installation | Swaps the staged folder in (below) and starts Varia. No installer runs. |
| Windows Setup (installed), anywhere else (for all users, in Program Files) | `Uninstall Varia SQL Manager.exe` beside the app | `<profile>/updates` | Runs the new Setup silently (`--updated /S --force-run`) into the same folder and mode; a per-machine installation asks for elevation. Varia starts again afterwards. |
| Windows Portable | `PORTABLE_EXECUTABLE_FILE` | A hidden `.…Portable.exe.update` beside the portable executable | Renames the running executable to `.old` (removed at the next start), moves the new one into its place, and starts it. |
| Linux AppImage | `APPIMAGE` | A hidden `.…AppImage.update` beside the AppImage | Keeps the AppImage as a hidden `.…AppImage.old` (a hard link, or moved aside where links are not possible), puts the new one in its place (renamed to the new version when its name had the old one) and starts it. The new copy removes the previous one when it starts; if it cannot start or exits before then, within 30 seconds, the previous AppImage is put back and Restart to Update reports the failure. After that the previous one stays, hidden, until the new copy or a later start removes it. |
| macOS, and anything else (an unpacked folder, a development run) | — | — | Not offered: the toast and the status bar point to the releases page. Development builds never check. |

macOS builds are not code signed, so they only check, say a release exists and open the releases page.

Nothing installs until **Restart to Update** (Help menu, status bar or toast). It closes Varia as File › Exit does, so
unsaved queries ask first and cancelling installs nothing. The update installs only after the windows have closed and
the SQL backend has stopped.

## Staged updates on Windows

An installed copy whose folder the user can write (the installer's default, "only for me") prepares the update while
Varia is still open, so the restart is two renames instead of a silent installer run.

1. **Download.** The release archive (`Varia-SQL-Manager-<version>-win-x64.zip`: the packaged application without the
   files Setup adds) downloads and is verified like any file. The status bar shows **Preparing update…** and Check for
   Updates waits.
2. **Stage.** The update helper (`resources/updater/Varia.Updater.exe`, from `backend/Varia.Updater`) runs from the
   installation at below-normal priority. It re-checks the SHA-512 with the file held open, unpacks to `<staging>/app`
   (refusing entries outside it or over another), copies in what Setup wrote and the archive lacks (the uninstaller, its
   icon if any, `resources/elevate.exe`), and writes `staged.json` last; the archive is then deleted. Closing Varia stops
   the helper and keeps the archive for next time. One stage runs at a time: a helper left unpacking by a Varia that was
   ended is not unpacked over, and that run installs with Setup.
3. **Swap.** Restart to Update copies the helper into the staging folder and starts it detached. Once Varia exits it
   renames the installation to `<staging>/old` and `<staging>/app` to the installation, starts Varia, updates the version
   Apps & features shows, and deletes the old folder. The swapping helper is the running version's; the uninstaller stays
   the one Setup last wrote.

A release staged by an earlier run is reused when `staged.json` names the manifest's archive (version and SHA-512) and the
application is there. Everything staging left is removed once the running version is the latest.

### The staging folder

- `.<installation folder>.update` beside the installation: the same volume, so renames are atomic, and a name not
  starting with the installation's, so Setup's "is Varia running" check ignores the helper. The helper works in no other
  folder (an installation at a drive's root is not staged); the folder is made only when a release is staged.
- Uninstalling runs the installation's helper (`uninstall`) before removing the application's files; it removes the
  staging folder, and any registered recovery, when the folder is this user's alone. The profile's record stays with the
  profile.
- The name is guessable and others may be able to create folders beside a custom installation (a shared `D:\Tools`), so
  the helper creates it for this user alone (the user, SYSTEM and Administrators, nothing inherited) and works only in a
  real folder owned by this user with its own rules; one made by somebody else is refused and Setup installs. Whether a
  release is staged is the helper's answer (`check`), asked before Restart to Update is offered and again when chosen.
- After a staged update the installation's files carry the staging folder's access rules, so only the installing user
  and administrators can read them.

### Timing and failures

- The helper waits up to 30 seconds for Varia to exit and tries the rename for up to 20 more. Half way, if no Varia runs
  from the installation, it ends what still does (a left-behind backend or SQL language service), as Setup does; a copy
  the user started meanwhile is left alone. The second rename, and the move back when it fails, get 5 seconds each.
- If the release cannot be put in place, the helper restores the installation, starts the old version unless it is
  running, and writes `failed.json`.
- A release that could not be staged or swapped is installed with Setup on every later start until it (or a newer one)
  runs. Records: the helper's `<staging>/failed.json`, and main's `update-failed.json` in the profile, written when an
  archive cannot be unpacked (that run falls back to Setup silently and reuses it later), when a staged release is gone
  at Restart to Update, and before starting the helper for every swap. That last record is never withdrawn (the new
  version ignores a record not newer than itself), so a helper that cannot start, or is ended by security software,
  leaves the release to Setup instead of a restart that fails the same way each time.
- The first start after a failed swap shows **Update failed** in the status bar once. `<staging>/update.log` has a line
  per step and is kept with the record.

### Recovery between the renames

Between the two renames there is no installation. Before the first, the helper writes `<staging>/swap.json` (installation
folder, executable name, versions), flushed to disk, and registers its staging copy under the user's `RunOnce` key as
`Varia.Updater.exe recover`; both are removed when the swap ends with any version in place.

- If the helper is cut short (power loss), the next sign-in runs it: from where the folders are, it moves the staged
  release into place, or the old version back when the staged one is not whole, without starting Varia. An empty folder
  where the installation was is removed first; one holding anything is left, with both versions, for Setup to repair.
- A journal left after both renames only removes the old version.
- A failed recovery (a scanner holding the folder over 20 seconds) re-registers itself, for five sign-ins at most. If the
  swap's own move back fails too, journal and registration are left for that sign-in.
- When the running version is the latest, main has the helper drop any registered recovery (`forget`) before removing
  the staging folder.
- `RunOnce` runs at most 260 characters; a longer command is not registered and has no recovery.

Nothing here asks for elevation, which is why an installation the user cannot write keeps the installer. Varia run as
administrator can stage a per-machine installation, but an interrupted swap there is not recovered at (unelevated)
sign-in.

## Integrity

- A download is written to a hidden `.partial` name and hashed as it arrives; it is kept only when its size and SHA-512
  match the manifest, else deleted with a failure saying a proxy may have changed it.
- A file verified by an earlier run is hashed again and reused, and Restart to Update hashes it once more before arming
  it (for a staged release, its marker and executable are looked for), since its folder is writable by other programs.
- Manifest file names are release names only; sizes are at most 1 GiB; the manifest at most 64 KiB. An archive may unpack
  to at most 8 GiB and 200,000 files. The real feed must use `https`.
- Checksums come from the same place as the files, over TLS trusting the OS certificate store, and builds are not code
  signed: the checks catch damage and substitution by anything that cannot also replace the manifest.

## Networks

Requests use Chromium's network stack in their own session (no cookies or cache): system proxy settings (PAC included),
Windows or Kerberos proxy sign-in, and the OS certificate store, so HTTPS-inspecting networks work once their certificate
is installed. Allow `github.com` and `release-assets.githubusercontent.com` (older releases may redirect to
`objects.githubusercontent.com`).

Failures carry a remedy in the toast; Copy details gives Chromium's error or the HTTP status:

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
| `integrity` | The file's size or SHA-512 differs from the manifest, or the file changed after it was verified. |
| `disk`, `notWritable` | No space, or the portable executable's or AppImage's folder is read-only. |
| `staged` | The last Restart to Update could not swap the staged release in; Varia is still the earlier version. |

A failed automatic check shows only in the status bar (**Update check failed**, reason in the tooltip, select to retry),
so a network blocking GitHub does not raise a toast every few hours. A failed Check for Updates, download or install is a
toast with **Try again** and **Open releases page**.

## Testing

| Check | Covers |
| --- | --- |
| `tests/updater.test.ts` | Streamed answers (progress, checksums, filter pages, proxy errors, stalls, the schedule) and a staging stand-in (archive route, fallbacks to Setup and their duration, a failed swap reported at next start). |
| `tests/update-install.test.ts` | Real file swaps in a temporary folder, how the helper starts, what main keeps of a failure. |
| `tests/update-manifest.test.ts` | The manifest script against the release job's file names, and the first manifest against the schema 0.7.0 shipped. |
| .NET `UpdaterChecks` (offline) | The helper's file work: staging, swap, recovery, refusals, and on Windows which staging folders it accepts. Its process work (waiting for Varia, ending leftovers, the sign-in and uninstall entries, starting Varia) has no automated check. |
| `scripts/updates-smoke.mjs` | The app against a loopback feed (`VARIA_TEST_UPDATE_FEED`, only in unpackaged smoke runs, with `VARIA_TEST_UPDATE_KIND`); its install writes `update-applied.json` in the profile instead. |
| `scripts/windows-installer-smoke.ps1` | Release builds: installs with Setup, has the installed helper refuse another folder, stage the build's archive and swap it in, compares every packaged file's size, interrupts a second swap and runs recovery, then uninstalls with a release staged and checks the application and staging folder are gone. Not through main, and without starting the swapped app. |
