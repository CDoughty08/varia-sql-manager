# Varia SQL Manager

Varia is a cross-platform desktop workbench for Microsoft SQL Server. It combines a SQL editor, query results, and database management tools in one application. It is under active development.

## Features

- Connect to multiple servers using SQL Server, Windows, or Microsoft Entra ID authentication.
- Write and execute T-SQL in a Monaco-based editor, with separate connections and sessions for query tabs. `GO` batches and repetitions are supported.
- Browse databases and server objects in Object Explorer, generate scripts, and perform supported object actions.
- Search every object on a server by name or inside definitions, with Match Case, Whole Word and regular expressions.
- View, copy, and export query results as CSV, tab-delimited text, or JSON.
- Use the Table Designer, Activity Monitor, live data views, and Integration Services Catalog tools.
- Customize themes and workspace layouts, and access commands through the command palette.

Varia targets SQL Server 2016 through 2025 and runs on Windows, Linux, and macOS. Some features require specific server versions or permissions; see the [documentation](#documentation) for details.

## Getting started

Download a build from [GitHub Releases](https://github.com/CDoughty08/varia-sql-manager/releases): the Windows x64 Setup or Portable executable, Linux x64 AppImage, or macOS DMG or ZIP for Apple Silicon or Intel. These builds include the .NET backend and do not require the SDK. They are currently unsigned; macOS builds are also not notarized, so the operating system may warn or block them. On Linux, the AppImage requires FUSE and an available desktop/keyring for encrypted remembered passwords.

The Windows Setup opens a wizard where you choose installation for your account or all users and confirm the installation. For unattended deployment, run `Varia-SQL-Manager-<version>-Windows-x64-Setup.exe --silent` (the standard NSIS `/S` flag also works). Silent installations default to the current user for a fresh install; `/allusers` requests an all-users installation and may require elevation. The Portable executable runs without an installation; it extracts the application to a temporary directory and uses the normal user profile for settings and saved connections. The Linux AppImage and extracted macOS ZIP can likewise run without an installer.

To run from source:

Prerequisites: Node.js 24 or newer and the .NET 10 SDK. The SDK version is configured in `global.json`.

```sh
npm ci
npm run dev
```

The development command builds the backend and starts Electron with renderer hot reload. Restart it after changing C# code. To build and run the application without the development server:

```sh
npm run build
npm start
```

On Ubuntu 24.04 and later, AppArmor may block the unprivileged user namespaces needed by Electron's Chromium sandbox. Configure AppArmor to permit them if Electron cannot start.

## Connecting and running queries

1. Select **Connect**, enter a server and database, and choose an authentication method.
2. Open a new query, write SQL, and select **Execute** or press **F5**. A selection runs instead of the full document.
3. Inspect the results and messages, or browse and script objects in Object Explorer.

Certificate validation is enabled by default. For a trusted server with a self-signed certificate, enable **Trust server certificate** in the connection dialog. On Linux and macOS, Windows authentication requires the system Kerberos library, a valid ticket from `kinit`, and a server name or SPN configured for Kerberos. Entra Integrated authentication is available on Windows only. Remembered passwords are encrypted using the operating system's credential storage; on Linux this requires an available keyring.

Press **F1** or **Ctrl+Shift+P** (**⌘Shift+P** on macOS) for the command palette. See the [command reference](docs/commands.md) for shortcuts and available commands.

## Current limitations

- SQLCMD mode, schema-aware IntelliSense, graphical execution plans, backup, security management, and job management are not yet available. Restore Database restores from backups already taken.
- Results are held in memory and subject to size limits; truncation is indicated in the application. Results to Text and Results to File are not yet available, though grid results can be exported.
- Review generated scripts before executing them. Some management and Integration Services operations are still limited; see the relevant documentation below.

## Development and testing

```sh
npm run check          # Typecheck, backend and UI tests, production UI build
npm run test:smoke     # Electron smoke tests; run check first
npm run test:electron  # check followed by smoke tests
npm run bench          # IPC benchmarks; run check first
```

The default checks do not require a database. On headless Linux, run the smoke tests under a virtual display:

```sh
xvfb-run -a -s "-screen 0 1600x1000x24" npm run test:smoke
```

To run optional live tests, set `VARIA_TEST_SQL_SERVER` and, for SQL authentication, `VARIA_TEST_SQL_USER` and `VARIA_TEST_SQL_PASSWORD`, then run `npm run backend:test`. The smoke tests also use these settings. Use a disposable development server: live tests can create and remove test objects, and `VARIA_TEST_SQL_SCRATCH=1` enables additional tests that create and drop databases and server objects. `VARIA_TEST_SSIS_CREATE=1` enables a destructive SSIS Catalog creation test; see the [Integration Services documentation](docs/integration-services.md) before using it.

## Creating a release

Release builds run on pull requests and can also be run manually from the **Release builds** Actions workflow. Their installers are available as workflow artifacts for seven days. After merging the desired changes, update the version in `package.json` and `package-lock.json` together, then push a matching tag (for example, `v0.1.0` for version `0.1.0`). The tag triggers all platform builds; once they and their packaged-app smoke checks pass, the workflow publishes a GitHub Release with the installers and GitHub-generated release notes. A version with a prerelease suffix (such as `v0.2.0-beta.1`) is published as a prerelease. Existing releases are not overwritten: resolve or remove an existing release before rerunning its release job.

## Architecture

The Electron application uses React, TypeScript, Monaco, and Dockview. A .NET sidecar handles SQL connections and management through Microsoft.Data.SqlClient and SQL Management Objects (SMO). The processes communicate over a MessagePack-based protocol; see the [IPC reference](docs/ipc.md).

## Documentation

- [Commands and shortcuts](docs/commands.md)
- [Object Explorer](docs/object-explorer.md), [object actions](docs/object-actions.md) and [Search Objects](docs/object-search.md)
- [Scripting](docs/scripting.md) and [Table Designer](docs/table-designer.md)
- [Activity Monitor](docs/activity-monitor.md), [live data](docs/live.md), and [Integration Services](docs/integration-services.md)
- [Settings](docs/settings.md) and [themes](docs/themes/README.md)
- [IPC and benchmarks](docs/ipc.md)
