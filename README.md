# Varia SQL Manager

Varia is a cross-platform desktop workbench for Microsoft SQL Server. It combines a SQL editor, query results, and database management tools in one application. It is under active development and currently runs from source; packaged installers are not yet available.

## Features

- Connect to multiple servers using SQL Server, Windows, or Microsoft Entra ID authentication.
- Write and execute T-SQL in a Monaco-based editor, with separate connections and sessions for query tabs. `GO` batches and repetitions are supported.
- Browse databases and server objects in Object Explorer, generate scripts, and perform supported object actions.
- View, copy, and export query results as CSV, tab-delimited text, or JSON.
- Use the Table Designer, Activity Monitor, live data views, and Integration Services Catalog tools.
- Customize themes and workspace layouts, and access commands through the command palette.

Varia targets SQL Server 2016 through 2025 and runs on Windows, Linux, and macOS. Some features require specific server versions or permissions; see the [documentation](#documentation) for details.

## Getting started

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

- SQLCMD mode, schema-aware IntelliSense, graphical execution plans, backup and restore, security management, and job management are not yet available.
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

## Architecture

The Electron application uses React, TypeScript, Monaco, and Dockview. A .NET sidecar handles SQL connections and management through Microsoft.Data.SqlClient and SQL Management Objects (SMO). The processes communicate over a MessagePack-based protocol; see the [IPC reference](docs/ipc.md).

## Documentation

- [Commands and shortcuts](docs/commands.md)
- [Object Explorer](docs/object-explorer.md) and [object actions](docs/object-actions.md)
- [Scripting](docs/scripting.md) and [Table Designer](docs/table-designer.md)
- [Activity Monitor](docs/activity-monitor.md), [live data](docs/live.md), and [Integration Services](docs/integration-services.md)
- [Settings](docs/settings.md) and [themes](docs/themes/README.md)
- [IPC and benchmarks](docs/ipc.md)
