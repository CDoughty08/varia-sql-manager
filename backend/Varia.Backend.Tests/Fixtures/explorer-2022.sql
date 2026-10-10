-- Ledger tables (SQL Server 2022 and later): updatable, append-only, and a dropped one with its ledger view.
CREATE TABLE dbo.LedgerAccounts (Id int NOT NULL PRIMARY KEY, Balance money NULL) WITH (SYSTEM_VERSIONING = ON, LEDGER = ON);
GO
CREATE TABLE dbo.LedgerEvents (Id int NOT NULL, Note nvarchar(50) NULL) WITH (LEDGER = ON (APPEND_ONLY = ON));
GO
CREATE TABLE dbo.LedgerDropped (Id int NOT NULL) WITH (LEDGER = ON (APPEND_ONLY = ON));
GO
DROP TABLE dbo.LedgerDropped;
GO
