# Updates

Varia SQL Manager updates itself from this repository's [GitHub releases](https://github.com/CDoughty08/varia-sql-manager/releases).
Main does all of it (`src/main/updater.ts`, `src/main/update-install.ts`, `src/main/update-staging.ts`); the page only
shows the state main pushes (`UpdateState` in `src/shared/updates.ts`) and runs the Help commands.

## How a release is found

Every release carries `varia-update-v2.json`, written by the release job (`scripts/update-manifest.mjs`): the version and,
for each packaged file, its kind, architecture, size and SHA-512. Varia reads it from
`https://github.com/CDoughty08/varia-sql-manager/releases/latest/download/varia-update-v2.json`, which skips pre-releases and
drafts. That link is not the REST API, so many people behind one corporate address do not share the API's rate limit.

Builds up to 0.7.0 read `varia-update.json` and refuse a manifest with a kind of file or a field they do not know. The
release job therefore still writes that file in its first shape (schema 1, without the Windows archive), and it must keep
doing so for as long as those builds are to update. The current manifest is read tolerantly: fields a build does not
know, and files it cannot use (a kind or architecture it does not know, a name or size outside its bounds), are left
out, so nothing a release adds for one build stops another from updating, and adding a kind needs no third file. What
is kept is still fully checked. `scripts/update-manifest.mjs` refuses to write a manifest with a file outside the
bounds, so such a release fails in the packaging job.

Checks run 15 seconds after start-up and every four hours (30 minutes after a failed check), unless **Environment › Product
Updates › Automatically check for updates** is off. **Help › Check for Updates** checks at any time. A newer release
downloads at once unless **Automatically download updates** is off; then the status bar and **Help › Download Update** offer it.

## What each build does

| Build | How Varia tells | Where the download goes | Restart to Update |
| --- | --- | --- | --- |
| Windows Setup (installed), in a folder the user can write | `Uninstall Varia SQL Manager.exe` beside the app, and the update helper in its resources | The archive to `<profile>/updates`, then unpacked to `.<installation folder>.update` beside the installation | Swaps the staged folder in (below) and starts Varia. No installer runs. |
| Windows Setup (installed), anywhere else (for all users, in Program Files) | `Uninstall Varia SQL Manager.exe` beside the app | `<profile>/updates` | Runs the new Setup silently (`--updated /S --force-run`) into the same folder and mode; a per-machine installation asks for elevation. Varia starts again afterwards. |
| Windows Portable | `PORTABLE_EXECUTABLE_FILE` | A hidden `.…Portable.exe.update` beside the portable executable | Renames the running executable to `.old` (removed at the next start), moves the new one into its place, and starts it. |
| Linux AppImage | `APPIMAGE` | A hidden `.…AppImage.update` beside the AppImage | Replaces the AppImage (renamed to the new version when its name had the old one) and starts it. |
| macOS, and anything else (an unpacked folder, a development run) | — | — | Not offered: the toast and the status bar point to the releases page. Development builds never check. |

macOS builds are not code signed, so they do not update themselves: they check, say that a release exists, and open the
releases page. Self-update on macOS returns with code signing.

Nothing installs until **Restart to Update** (in the Help menu, the status bar or the toast). It closes Varia as File › Exit
does, so queries with unsaved changes ask first; cancelling that keeps Varia running and installs nothing. The update
installs only after the windows have closed and the SQL backend has stopped.

## Staged updates on Windows

Running the installer at restart means waiting, with nothing on screen, while it removes the old version and unpacks the
new one. An installed copy whose folder the user can write (the installer's default, "only for me") does that work while
Varia is still open instead:

1. The release's archive (`Varia-SQL-Manager-<version>-win-x64.zip`: the packaged application, without the files
   Setup adds) downloads and is verified like any other file. The status bar then shows **Preparing update…**, and
   Check for Updates waits.
2. The update helper (`resources/updater/Varia.Updater.exe`, built from `backend/Varia.Updater`) runs from the installation
   at below-normal priority. It checks the archive's SHA-512 again with the file held open, unpacks it to
   `<staging>/app`, refusing an entry that would land outside it or over another, copies in what Setup wrote and the
   archive lacks (the uninstaller, its icon where there is one, and `resources/elevate.exe`), and writes `staged.json`
   last. Only then is the update ready; the archive is deleted. Closing Varia meanwhile stops the helper and keeps the
   archive for the next run. One stage runs at a time: a helper left unpacking by a Varia that was ended is not
   unpacked over, and that run installs with Setup.
3. Restart to Update copies the helper into the staging folder and starts it there, detached. Once Varia has exited it
   renames the installation to `<staging>/old` and `<staging>/app` to the installation, starts Varia, updates the version
   that Apps & features shows, and deletes the old folder. After Varia's own exit, the restart costs two renames. The
   helper that swaps is the running version's, not the new release's; the uninstaller stays the one Setup last wrote.

The staging folder is `.<installation folder>.update` beside the installation: the same volume, so the renames are
atomic, and a name that does not start with the installation's, so Setup's "is Varia running" check never takes the
helper for the application. The helper works in no other folder (an installation at a drive's root has none and is not
staged), and the folder is not made until a release is staged. Uninstalling does not remove it yet.

That name can be guessed, and beside a custom installation (a shared `D:\Tools`) other people may be able to make
folders. So the helper makes the staging folder for this user alone (its own access rules: the user, SYSTEM and
Administrators, nothing inherited) and works only in a folder that is a real folder, owned by this user, with rules of
its own; one that somebody else made first is refused, and the release installs with Setup. Main believes nothing in
the folder by itself: whether a release is staged is the helper's answer (`check`), asked before Restart to Update is
offered and again when it is chosen. One consequence: after a staged update the installation's files carry the staging
folder's access rules, not the parent folder's, so only the user who installed it (and administrators) can read them.

A folder cannot be renamed while one of its files is open. The helper waits up to 30 seconds for Varia to exit and tries
the rename for up to 20 more. Half way through, if no Varia is running from the installation, it ends whatever else
still is (a backend or SQL language service that was left behind), as Setup does; a copy of Varia the user started
meanwhile, and its backend, are left alone. The second rename, and the move back when it fails, are each tried for
5 seconds. If the release cannot be put in place, the helper puts the installation back, starts the old version unless
it is already running, and writes `failed.json`.

A release that could not be staged or swapped in is remembered until it (or a newer one) is running: every later start
installs that release with Setup instead of staging it again. The helper's record is `<staging>/failed.json`; main's is
`update-failed.json` in the profile, written when an archive cannot be unpacked (the same run then falls back to Setup
without an error, and reuses that Setup in later runs), when a staged release is gone at Restart to Update, and, before
the helper is started, for every swap. That last one is never taken back (the new version ignores a record that is not
newer than itself), so a helper that cannot be started (Varia then starts again as it is) and one that is ended before
it can say anything, by security software for instance, both leave the release to Setup instead of leaving it "ready"
for a restart that fails the same way each time. The first start after a failed swap says so in the status bar
(**Update failed**), once. `<staging>/update.log` has a line for each step and is kept with the record.

Between the two renames there is no installation. Before the first, the helper writes `<staging>/swap.json` (the
installation's folder, the executable's name and the versions) and registers its copy in the staging folder under the
user's `RunOnce` key as `Varia.Updater.exe recover`; both are removed when the swap ends with an installation in
place, whichever version that is. If the helper is cut short in between (the power goes), the next sign-in runs it: it
reads the journal beside itself and, from where the folders are, moves the staged release into place, or the old
version back when the staged one is not whole, without starting Varia. An empty folder that something made where the
installation was is removed first; one that holds anything is left, with both versions, for Setup to repair. A journal
left after both renames only has the old version removed: the installation may be another version by then. When the
running version is the latest, main has the helper end any recovery still registered (`forget`) before it removes the
staging folder. The journal is flushed to disk, and the registry key too, before the first rename. A recovery that
fails (a scanner holding the folder for more than 20 seconds) registers itself again, for five sign-ins at most. Should
the swap's own move back fail as well, the journal and the registration are left for that sign-in. `RunOnce` runs at
most 260 characters, so an installation whose path makes the command longer is not registered and has no such recovery.

Nothing in this path asks for elevation, which is why an installation the user cannot write keeps the installer. (Varia
run as administrator can write a per-machine installation and stages it; a swap interrupted there is not recovered at
sign-in, which is not elevated.) Everything staging left is removed once the running version is the latest. A release staged by an earlier run is used again when
`staged.json` names the manifest's archive (its version and SHA-512) and the application is there.

## Integrity

A download is written beside a hidden `.partial` name and hashed as it arrives. It is kept only when its size and SHA-512
match the manifest; otherwise it is deleted and the failure says a proxy may have changed it. A file verified by an
earlier run is hashed again and reused, and Restart to Update hashes the file once more before it arms it (a staged
release: its marker and executable are looked for), since it is run from a folder other programs can write to. The
manifest's file names are release names only, sizes are bounded (1 GiB), and the manifest itself is at most 64 KiB. An
archive may unpack to at most 8 GiB and 200,000 files. The real feed must end on `https`.

The checksums come from the same place as the files, over TLS that trusts the operating system's certificate store, and
the builds are not code signed: the checks catch damage and substitution by anything that cannot also replace the
manifest.

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
| `integrity` | The file's size or SHA-512 differs from the manifest, or the file changed after it was verified. |
| `disk`, `notWritable` | No space, or the portable executable's or AppImage's folder is read-only. |
| `staged` | The last Restart to Update could not swap the staged release in; Varia is still the earlier version. |

An automatic check that fails shows only in the status bar (**Update check failed**, with the reason in its tooltip; select
it to try again), so a network that blocks GitHub does not raise a toast every few hours. A failure of Check for Updates, of
a download or of an install is a toast with **Try again** and **Open releases page**.

## Testing

`tests/updater.test.ts` drives the updater with streamed answers (progress, checksums, filter pages, proxy errors, stalls,
the schedule) and a stand-in for staging (the archive route, its fallbacks to Setup and how long they last, a failed
swap reported at the next start); `tests/update-install.test.ts` swaps real files in a temporary folder and checks how the helper is started and
what main keeps of a failure;
`tests/update-manifest.test.ts` checks the manifest script against the release job's file names, and the first manifest
against the schema 0.7.0 shipped. The helper's file work (staging, the swap, recovery, its refusals, and on Windows whose
staging folder it accepts) is the offline .NET suite `UpdaterChecks`; its process work (waiting for Varia, ending what
it left running, the sign-in entry, the uninstall entry, starting Varia) has no automated check. `scripts/updates-smoke.mjs` runs the app against a loopback feed (`VARIA_TEST_UPDATE_FEED`, honoured only
in unpackaged smoke runs, with `VARIA_TEST_UPDATE_KIND`), whose install writes `update-applied.json` in the profile instead
of running anything. Release builds run the helper for real, though not through main and without
starting the swapped application: `scripts/windows-installer-smoke.ps1` installs with Setup, has the installed helper
refuse another folder, stage that build's archive and swap it in, compares every packaged file's size with the result,
then interrupts a second swap by hand and runs the recovery.
