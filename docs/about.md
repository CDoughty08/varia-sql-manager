# About Varia

Open **Help > About Varia**, or find **About Varia** in the command palette. On macOS the application's **About Varia**
menu item opens the same dialog while a workbench window is open. After closing the last window on macOS, About
opens the system About panel with Varia's name and running version. It is available without a SQL Server connection
or a working SQL backend. About opens in a small fixed-size window of its own over the main window, which stays usable
beside it; Help › About Varia again brings it forward (see [dialog windows](popout-windows.md#dialog-windows)).

The dialog shows the running version, operating-system platform and the update state the status bar shows; opening it
does not start a check. Development builds say they do not check for updates. A last successful check is described as
the last check, not as proof that no newer release exists.

**Check for Updates**, **Download Update** and **Restart to Update** appear when appropriate. Download and preparation
states keep their progress visible. Current unsigned macOS builds and other copies that cannot self-update offer
manual release downloads instead. The updater owns all downloads, verification and installation; see [updates](updates.md).

Restart to Update closes About first so Varia's normal unsaved-work flow can run. Cancelling that flow installs
nothing. Checking or downloading can keep About open, and Escape or Done closes it and returns focus to the control
that opened it, or to the active document when that control has gone; a dialog opened over the main window meanwhile
takes focus instead.

**Copy Version Details** copies only the application version, platform, installation/update capability and update
phase. It includes no SQL text, server/database names, connection settings, paths or credentials. The **Version
details** disclosure shows the same text. A clipboard write failure is reported beside the Copy button.

**Project on GitHub** and **Report an Issue** open fixed destinations in the system browser. No issue is submitted
automatically. **Release Notes** closes About and opens the running version's bundled notes in a read-only workbench
tab; see [Release Notes](release-notes.md). Manual release downloads remain a separate browser action.

## Implementation

`help.about` emits a renderer event; App owns one About dialog. The dialog reads `UpdateService` and reuses existing
update commands rather than reading a second version source or creating another updater. Its own explicit controls
use the programmatic command source while the dialog is open, preserving command preconditions. Restart closes the
dialog synchronously and takes the ordinary toolbar command path so window-close handling is not suppressed. Navigating
to Release Notes also closes the dialog before the document takes focus.

The project/support IPC accepts only the names `project` and `issues`. Main validates that name and resolves a fixed
URL in `src/shared/product.ts`; it does not accept a URL from the renderer. Existing sender checks still apply.
Colours, dimensions and the brand glyph follow the shared theme, metric and icon catalogues.
