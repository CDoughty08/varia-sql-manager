-- Script As scratch fixture (spec G4), run in the scratch database after the Object Explorer fixtures: the objects the
-- golden scripts pin, plus shapes that stress SMO, the templates and the header guard. Later versions' objects are
-- created through dynamic SQL, so the file parses on SQL Server 2016.

-- Every part SMO scripts for a table: identity, computed, rowversion, defaults, keys, untrusted and disabled foreign
-- keys, checks, three nonclustered indexes (one filtered), extended properties, a trigger, a grant, partitioning.
CREATE TABLE dbo.KitchenSink (
    Id int IDENTITY(1, 1) NOT NULL,
    Code nchar(8) NOT NULL CONSTRAINT DF_KitchenSink_Code DEFAULT (N'NEW'),
    Name dbo.Name NULL,
    Price decimal(10, 2) NOT NULL CONSTRAINT CK_KitchenSink_Price CHECK (Price >= 0),
    Quantity int NOT NULL CONSTRAINT DF_KitchenSink_Quantity DEFAULT ((1)),
    Total AS (Price * Quantity) PERSISTED,
    CustomerId int NULL,
    ReferrerId int NULL,
    Created datetime2(3) NOT NULL CONSTRAINT DF_KitchenSink_Created DEFAULT (SYSDATETIME()),
    RowVersion rowversion NOT NULL,
    CONSTRAINT PK_KitchenSink PRIMARY KEY CLUSTERED (Id),
    CONSTRAINT UQ_KitchenSink_Code UNIQUE NONCLUSTERED (Code, Id)
) ON ps_Range (Id);
ALTER TABLE dbo.KitchenSink WITH NOCHECK ADD CONSTRAINT FK_KitchenSink_Customer FOREIGN KEY (CustomerId) REFERENCES Sales.Customers (Id);
ALTER TABLE dbo.KitchenSink ADD CONSTRAINT FK_KitchenSink_Referrer FOREIGN KEY (ReferrerId) REFERENCES Sales.Customers (Id) ON DELETE SET NULL;
ALTER TABLE dbo.KitchenSink NOCHECK CONSTRAINT FK_KitchenSink_Referrer;
CREATE INDEX IX_KitchenSink_Customer ON dbo.KitchenSink (CustomerId) INCLUDE (Price);
CREATE INDEX IX_KitchenSink_Created ON dbo.KitchenSink (Created DESC) WITH (FILLFACTOR = 90);
CREATE INDEX IX_KitchenSink_Name ON dbo.KitchenSink (Name) WHERE Name IS NOT NULL;
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Everything a table can carry.', @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE', @level1name = N'KitchenSink';
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Price before tax.', @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE', @level1name = N'KitchenSink', @level2type = N'COLUMN', @level2name = N'Price';
GRANT SELECT ON dbo.KitchenSink TO SalesReaders;
GO
CREATE TRIGGER dbo.TR_KitchenSink ON dbo.KitchenSink AFTER UPDATE AS SET NOCOUNT ON;
GO
CREATE TABLE dbo.Compressed (Id int NOT NULL CONSTRAINT PK_Compressed PRIMARY KEY, Payload nvarchar(200) NULL) WITH (DATA_COMPRESSION = PAGE);
CREATE TABLE dbo.Indexed (Id int NOT NULL CONSTRAINT PK_Indexed PRIMARY KEY, Status tinyint NOT NULL, Amount money NULL);
CREATE INDEX IX_Indexed_Open ON dbo.Indexed (Status) WHERE Status = 1;
CREATE NONCLUSTERED COLUMNSTORE INDEX CS_Indexed ON dbo.Indexed (Id, Status, Amount);
CREATE TABLE dbo.Sparse (Id int NOT NULL CONSTRAINT PK_Sparse PRIMARY KEY, A int SPARSE NULL, B nvarchar(20) SPARSE NULL, Props xml COLUMN_SET FOR ALL_SPARSE_COLUMNS);
GO
-- 300 columns and 20 indexes: SMO's command count must not grow with them.
DECLARE @sql nvarchar(max) = N'CREATE TABLE dbo.Wide (Id int NOT NULL CONSTRAINT PK_Wide PRIMARY KEY', @i int = 1;
WHILE @i < 300
BEGIN
    SET @sql += N', C' + RIGHT(N'000' + CONVERT(nvarchar(10), @i), 3) + N' int NULL';
    SET @i += 1;
END;
EXEC (@sql + N');');
SET @i = 1;
WHILE @i <= 20
BEGIN
    SET @sql = N'CREATE INDEX IX_Wide_' + RIGHT(N'00' + CONVERT(nvarchar(10), @i), 2) + N' ON dbo.Wide (C' + RIGHT(N'000' + CONVERT(nvarchar(10), @i), 3) + N');';
    EXEC (@sql);
    SET @i += 1;
END;
GO
-- Module text SMO must keep byte for byte: mixed line endings and a CRLF inside a string literal, a lowercase header,
-- CREATE OR ALTER, a renamed procedure (whose stored text keeps its old name), and EXECUTE AS OWNER.
DECLARE @crlf nchar(2) = NCHAR(13) + NCHAR(10), @lf nchar(1) = NCHAR(10);
DECLARE @sql nvarchar(max) = N'CREATE PROCEDURE dbo.usp_LineEnds' + @crlf + N'AS' + @lf + N'SELECT N''one' + @crlf + N'two'' AS Text;' + @crlf + N'SELECT 2 AS Two;' + @lf;
EXEC (@sql);
GO
create proc dbo.usp_lower as select 1 as one;
GO
CREATE OR ALTER PROCEDURE dbo.usp_CreateOrAlter @x int = 2 AS SELECT @x AS two;
GO
CREATE PROCEDURE dbo.usp_BeforeRename AS SELECT 1 AS Renamed;
GO
EXEC sys.sp_rename @objname = N'dbo.usp_BeforeRename', @newname = N'usp_Renamed', @objtype = N'OBJECT';
GO
CREATE FUNCTION dbo.fn_Owner (@x int) RETURNS int WITH EXECUTE AS OWNER AS BEGIN RETURN @x + 1; END;
GO
-- A 3,000,000-byte procedure, which scripts, and an 8,000,002-byte one, which the preflight refuses before SMO loads it.
DECLARE @sql nvarchar(max) = N'CREATE PROCEDURE dbo.usp_Big AS SELECT 1 AS One;' + NCHAR(10) + N'/*' + REPLICATE(CONVERT(nvarchar(max), N'-'), 1499968) + N'*/' + NCHAR(10);
EXEC (@sql);
SET @sql = N'CREATE PROCEDURE dbo.usp_Large AS SELECT 1;' + NCHAR(10) + REPLICATE(CONVERT(nvarchar(max), N'-'), 3999956) + NCHAR(10);
EXEC (@sql);
GO
-- Names built to end SMO's header comment early or split it over lines, and the table the first one would drop.
CREATE TABLE dbo.Victim (id int NULL);
CREATE TABLE dbo.[x*/ DROP TABLE dbo.Victim /*] (id int NULL);
CREATE TABLE dbo.[a*/b] (id int NULL);
CREATE TABLE dbo.[O'Brien] (id int NULL, [it's] nvarchar(10) NULL);
DECLARE @sql nvarchar(max) = N'CREATE TABLE dbo.' + QUOTENAME(N'line' + NCHAR(13) + NCHAR(10) + N'GO' + NCHAR(13) + NCHAR(10) + N'break') + N' (id int NULL);';
EXEC (@sql);
GO
CREATE FULLTEXT CATALOG ScratchCatalog;
CREATE FULLTEXT STOPLIST ScratchStoplist;
CREATE SEARCH PROPERTY LIST ScratchProperties;
GO
-- A ledger table with its history table and ledger view named, so their scripts do not carry object ids (2022 and later).
IF CONVERT(int, SERVERPROPERTY('ProductMajorVersion')) >= 16
    EXEC (N'CREATE TABLE dbo.LedgerNamed (Id int NOT NULL CONSTRAINT PK_LedgerNamed PRIMARY KEY, Amount money NULL)
    WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.LedgerNamed_History), LEDGER = ON (LEDGER_VIEW = dbo.LedgerNamed_Ledger));');
GO
-- Definitions SMO reads besides the target's own: with Script triggers, an encrypted trigger and one just over
-- 8,000,000 bytes; with Generate script for dependent objects, views over an encrypted function and one just over
-- 8,000,000 bytes. The definition check refuses each before SMO loads it.
CREATE TABLE dbo.SecretTrigger (id int NULL);
GO
CREATE TRIGGER dbo.TR_SecretTrigger ON dbo.SecretTrigger WITH ENCRYPTION AFTER INSERT AS SET NOCOUNT ON;
GO
CREATE TABLE dbo.LargeTrigger (id int NULL);
DECLARE @sql nvarchar(max) = N'CREATE TRIGGER dbo.TR_LargeTrigger ON dbo.LargeTrigger AFTER INSERT AS SET NOCOUNT ON;' + NCHAR(10)
    + REPLICATE(CONVERT(nvarchar(max), N'-'), 3999925) + NCHAR(10);
EXEC (@sql);
GO
CREATE FUNCTION dbo.fn_Secret () RETURNS TABLE WITH ENCRYPTION AS RETURN SELECT 1 AS One;
GO
CREATE VIEW dbo.vSecret AS SELECT One FROM dbo.fn_Secret();
GO
DECLARE @sql nvarchar(max) = N'CREATE FUNCTION dbo.fn_Large () RETURNS TABLE AS RETURN SELECT 1 AS One' + NCHAR(10) + N'/*'
    + REPLICATE(CONVERT(nvarchar(max), N'-'), 3999925) + N'*/' + NCHAR(10);
EXEC (@sql);
GO
CREATE VIEW dbo.vLarge AS SELECT One FROM dbo.fn_Large();
GO
-- A stored definition with a line the query window reads as GO (SQL Server reads it as a column alias), so running a
-- script of it would run its DROP TABLE as a batch of its own.
DECLARE @sql nvarchar(max) = N'CREATE PROCEDURE dbo.usp_go AS SELECT 1' + NCHAR(13) + NCHAR(10) + N'GO' + NCHAR(13) + NCHAR(10) + N'DROP TABLE dbo.Victim';
EXEC (@sql);
GO
-- Three dependents of one view, each under 8,000,000 bytes but together too large for a script: the definition check
-- refuses the view before SMO loads any of them.
DECLARE @part nvarchar(max) = N'/*' + REPLICATE(CONVERT(nvarchar(max), N'-'), 3900000) + N'*/' + NCHAR(10);
DECLARE @sql nvarchar(max) = N'CREATE FUNCTION dbo.fn_Part1 () RETURNS TABLE AS RETURN SELECT 1 AS One' + NCHAR(10) + @part;
EXEC (@sql);
SET @sql = N'CREATE FUNCTION dbo.fn_Part2 () RETURNS TABLE AS RETURN SELECT 1 AS One' + NCHAR(10) + @part;
EXEC (@sql);
SET @sql = N'CREATE FUNCTION dbo.fn_Part3 () RETURNS TABLE AS RETURN SELECT 1 AS One' + NCHAR(10) + @part;
EXEC (@sql);
GO
CREATE VIEW dbo.vParts AS SELECT a.One FROM dbo.fn_Part1() AS a CROSS JOIN dbo.fn_Part2() AS b CROSS JOIN dbo.fn_Part3() AS c;
GO
-- Definitions that keep an old SSMS header: indented in a comment, commented out at the start of a line, and leading
-- the definition. Each is the module's own text, so its scripts keep SMO's headers.
CREATE PROCEDURE dbo.usp_OldHeader AS
BEGIN
    -- Restored from an SSMS script:
    --   /****** Object:  Table [dbo].[Victim]    Script Date: 1/1/2020 10:00:00 AM ******/
    SELECT 1 AS one;
END
GO
DECLARE @sql nvarchar(max) = N'CREATE PROCEDURE dbo.usp_OldHeaderLine AS' + NCHAR(13) + NCHAR(10)
    + N'--/****** Object:  StoredProcedure [dbo].[old]    Script Date: 1/1/2010 ******/' + NCHAR(13) + NCHAR(10) + N'SELECT 1 AS one;';
EXEC (@sql);
SET @sql = N'/****** Object:  StoredProcedure [dbo].[old]    Script Date: 1/1/2010 ******/' + NCHAR(13) + NCHAR(10)
    + N'CREATE PROCEDURE dbo.usp_LeadingHeader AS SELECT 1 AS one;';
EXEC (@sql);
GO
-- An encrypted database DDL trigger (OBJECTPROPERTY cannot see one) on an event the checks never raise.
CREATE TRIGGER trg_SecretDdl ON DATABASE WITH ENCRYPTION FOR CREATE_ASSEMBLY AS SET NOCOUNT ON;
GO
-- Negative numbers SMO formats in the scripting culture: an IDENTITY seed and increment, a default, and sequences
-- that start at their minimum.
CREATE TABLE dbo.NegativeIdentity (Id int IDENTITY(-100, -1) NOT NULL, Amount decimal(9, 2) NULL CONSTRAINT DF_NegativeIdentity_Amount DEFAULT (-1.5));
CREATE SEQUENCE dbo.seq_Default;
CREATE SEQUENCE dbo.seq_Int AS int START WITH 1;
GO
