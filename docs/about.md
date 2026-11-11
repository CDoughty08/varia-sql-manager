# About Varia

Open **Help > About Varia**, or find **About Varia** in the command palette. On macOS the application's **About Varia**
menu item opens the same dialog. It is available without a SQL Server connection or a working SQL backend.

The dialog shows the running application version, operating-system platform and current update state. Opening it
does not start an update check; it follows the same state as the status bar. Development builds say that they do not
check for updates. A last successful check is described as the last check, not as proof the computer is still online
or no newer release has since appeared.

**Check for Updates**, **Download Update** and **Restart to Update** appear when appropriate. Download and preparation
states keep their progress visible. Current unsigned macOS builds and other copies that cannot self-update offer
manual release downloads instead. The updater owns all downloads, verification and installation; see [updates](updates.md).

Restart to Update closes About first so Varia's normal unsaved-work flow can run. Cancelling that flow installs
nothing. Checking or downloading can keep About open, and Escape or Done closes it and returns focus to the control
that opened it, or to the active document when that control has gone.

**Copy Version Details** copies only the application version, platform, installation/update capability and update
phase. It includes no SQL text, server/database names, connection settings, paths or credentials. The **Version
details** disclosure shows the same text. A clipboard write failure is reported beside the Copy button.

**Project on GitHub**, **Report an Issue** and **Release Notes** open the fixed project, issue-composition and release
destinations in the system browser. No issue is submitted automatically. Release Notes remains external in this
first implementation; the in-app release-note reader is a separate change.

## Implementation

`help.about` emits a renderer event; App owns one About dialog. The dialog reads `UpdateService` and reuses existing
update commands rather than reading a second version source or creating another updater. Its own explicit controls
use the programmatic command source while the modal is open, preserving command preconditions. Restart closes the
modal synchronously and takes the ordinary toolbar command path so window-close handling is not suppressed.

The project/support IPC accepts only the names `project` and `issues`. Main validates that name and resolves a fixed
URL in `src/shared/product.ts`; it does not accept a URL from the renderer. Existing sender checks still apply.
Colours, dimensions and the brand glyph follow the shared theme, metric and icon catalogues.
