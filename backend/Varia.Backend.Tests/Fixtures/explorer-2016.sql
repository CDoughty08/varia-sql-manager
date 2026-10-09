-- Object Explorer scratch fixture for SQL Server 2016 and later. Runs in a fresh scratch database created with a
-- case-sensitive collation, through query.execute (which also exercises the GO parser). {{password}} is replaced by a
-- random password held in memory only.
CREATE SCHEMA Sales;
GO
CREATE SCHEMA [Odd]]Schema];
GO
CREATE SCHEMA [bulk];
GO
CREATE TYPE dbo.Name FROM nvarchar(50) NOT NULL;
GO
CREATE XML SCHEMA COLLECTION dbo.Coll AS N'<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"><xsd:element name="a" type="xsd:string"/></xsd:schema>';
GO
CREATE TABLE Sales.Customers (
    Id int IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Customers PRIMARY KEY CLUSTERED,
    Name dbo.Name,
    Email nvarchar(200) NULL CONSTRAINT UQ_Customers_Email UNIQUE,
    Created datetime2(3) NOT NULL CONSTRAINT DF_Customers_Created DEFAULT SYSDATETIME(),
    Notes nvarchar(max) NULL,
    Doc xml(DOCUMENT dbo.Coll) NULL,
    Frag xml(CONTENT dbo.Coll) NULL,
    Extra int SPARSE NULL
);
GO
CREATE TABLE Sales.Orders (
    Id int NOT NULL CONSTRAINT PK_Orders PRIMARY KEY,
    CustomerId int NULL,
    ReferrerId int NULL,
    BackupId int NULL,
    Price decimal(8, 2) NOT NULL CONSTRAINT CK_Orders_Price CHECK (Price >= 0),
    Quantity int NOT NULL CONSTRAINT CK_Orders_Quantity CHECK (Quantity > 0),
    Total AS (Price * Quantity),
    Payload varbinary(max) NULL
);
ALTER TABLE Sales.Orders ADD CONSTRAINT FK_Orders_Customers FOREIGN KEY (CustomerId) REFERENCES Sales.Customers (Id);
ALTER TABLE Sales.Orders WITH NOCHECK ADD CONSTRAINT FK_Orders_Referrer FOREIGN KEY (ReferrerId) REFERENCES Sales.Customers (Id);
ALTER TABLE Sales.Orders ADD CONSTRAINT FK_Orders_Backup FOREIGN KEY (BackupId) REFERENCES Sales.Customers (Id);
ALTER TABLE Sales.Orders NOCHECK CONSTRAINT FK_Orders_Backup;
ALTER TABLE Sales.Orders NOCHECK CONSTRAINT CK_Orders_Quantity;
CREATE INDEX IX_Orders_Customer ON Sales.Orders (CustomerId);
CREATE UNIQUE INDEX IX_Orders_Price ON Sales.Orders (Price, Id) WHERE Price > 0;
CREATE INDEX IX_Orders_Disabled ON Sales.Orders (Quantity);
ALTER INDEX IX_Orders_Disabled ON Sales.Orders DISABLE;
CREATE STATISTICS ST_Orders_Quantity ON Sales.Orders (Quantity);
GO
CREATE TRIGGER Sales.TR_Orders_Audit ON Sales.Orders AFTER INSERT AS SET NOCOUNT ON;
GO
CREATE TRIGGER Sales.TR_Orders_Off ON Sales.Orders AFTER UPDATE AS SET NOCOUNT ON;
GO
DISABLE TRIGGER Sales.TR_Orders_Off ON Sales.Orders;
GO
CREATE TABLE Sales.Invoices (
    Id int NOT NULL CONSTRAINT PK_Invoices PRIMARY KEY CLUSTERED,
    Amount money NULL,
    ValidFrom datetime2(7) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    ValidTo datetime2(7) GENERATED ALWAYS AS ROW END HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo)
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = Sales.InvoicesHistory));
GO
CREATE TABLE dbo.a (id int NULL);
CREATE TABLE dbo.A (id int NULL);
CREATE TABLE dbo.b (id int NULL, [spaced ] int NULL);
CREATE TABLE dbo.[Ünïcødé表] (id int NULL);
CREATE TABLE dbo.[50%_off] (id int NULL);
CREATE TABLE dbo.[50x_off] (id int NULL);
CREATE TABLE dbo.[[x]]] (id int NULL);
CREATE TABLE [Odd]]Schema].[t] (id int NULL);
CREATE TABLE dbo.Doomed (id int NULL);
GO
CREATE VIEW dbo.vCustomers AS SELECT Id, Email FROM Sales.Customers;
GO
CREATE TRIGGER dbo.TR_vCustomers ON dbo.vCustomers INSTEAD OF INSERT AS SET NOCOUNT ON;
GO
CREATE VIEW dbo.vOrderTotals WITH SCHEMABINDING AS SELECT CustomerId, COUNT_BIG(*) AS Orders FROM Sales.Orders GROUP BY CustomerId;
GO
CREATE UNIQUE CLUSTERED INDEX IX_vOrderTotals ON dbo.vOrderTotals (CustomerId);
GO
CREATE TYPE Sales.OrderLines AS TABLE (Line int NOT NULL PRIMARY KEY, Quantity int NOT NULL CHECK (Quantity > 0), Note nvarchar(20) NULL, INDEX IX_Quantity (Quantity));
GO
-- A comment with "@CustomerId int = 1" must not count as a default.
CREATE PROCEDURE Sales.usp_Orders
    @CustomerId int,
    @Since datetime2(3) = NULL,
    @Count int = 0 OUTPUT,
    @Lines Sales.OrderLines READONLY,
    @Label nvarchar(20) = N'it''s = 1'
AS
SELECT @Count = COUNT(*) FROM Sales.Orders WHERE CustomerId = @CustomerId;
GO
CREATE PROCEDURE dbo.usp_Secret @x int = 1 WITH ENCRYPTION AS SELECT @x;
GO
CREATE FUNCTION dbo.fn_Inline (@x int = 1) RETURNS TABLE AS RETURN SELECT @x AS Value, N'a' AS Name;
GO
CREATE FUNCTION dbo.fn_Multi (@x int) RETURNS @t TABLE (Value int NOT NULL) AS BEGIN INSERT @t VALUES (@x); RETURN; END;
GO
CREATE FUNCTION dbo.fn_Scalar (@a decimal(10, 2), @b int = 2) RETURNS decimal(10, 2) AS BEGIN RETURN @a * @b; END;
GO
CREATE FUNCTION dbo.fn_Policy (@Id int) RETURNS TABLE WITH SCHEMABINDING AS RETURN SELECT 1 AS Allowed WHERE @Id > 0;
GO
CREATE SECURITY POLICY dbo.CustomerPolicy ADD FILTER PREDICATE dbo.fn_Policy(Id) ON Sales.Customers WITH (STATE = OFF);
GO
CREATE SYNONYM dbo.syn_Orders FOR Sales.Orders;
CREATE SEQUENCE dbo.seq_Orders AS int START WITH 1;
GO
CREATE RULE dbo.r_Positive AS @value > 0;
GO
CREATE DEFAULT dbo.d_Zero AS 0;
GO
EXEC sys.sp_create_plan_guide @name = N'pg_Orders', @stmt = N'SELECT COUNT(*) FROM Sales.Orders', @type = N'SQL', @module_or_batch = NULL, @params = NULL, @hints = N'OPTION (MAXDOP 1)';
GO
CREATE TRIGGER trg_ddl_on ON DATABASE FOR CREATE_TABLE AS SET NOCOUNT ON;
GO
CREATE TRIGGER trg_ddl_off ON DATABASE FOR DROP_VIEW AS SET NOCOUNT ON;
GO
DISABLE TRIGGER trg_ddl_off ON DATABASE;
GO
CREATE PARTITION FUNCTION pf_Range (int) AS RANGE LEFT FOR VALUES (10, 20);
CREATE PARTITION SCHEME ps_Range AS PARTITION pf_Range ALL TO ([PRIMARY]);
GO
CREATE ROLE SalesReaders;
CREATE APPLICATION ROLE AppRole WITH PASSWORD = N'{{password}}';
CREATE USER NoLoginUser WITHOUT LOGIN;
CREATE USER NoConnect WITHOUT LOGIN;
REVOKE CONNECT FROM NoConnect;
CREATE MASTER KEY ENCRYPTION BY PASSWORD = N'{{password}}';
CREATE CERTIFICATE ScratchCert WITH SUBJECT = N'Varia scratch', EXPIRY_DATE = '20991231';
CREATE SYMMETRIC KEY ScratchSymmetric WITH ALGORITHM = AES_256 ENCRYPTION BY CERTIFICATE ScratchCert;
CREATE ASYMMETRIC KEY ScratchAsymmetric WITH ALGORITHM = RSA_2048;
CREATE COLUMN MASTER KEY ScratchCmk WITH (KEY_STORE_PROVIDER_NAME = N'MSSQL_CERTIFICATE_STORE', KEY_PATH = N'CurrentUser/My/0000000000000000000000000000000000000000');
GO
CREATE COLUMN ENCRYPTION KEY ScratchCek WITH VALUES (COLUMN_MASTER_KEY = ScratchCmk, ALGORITHM = 'RSA_OAEP', ENCRYPTED_VALUE = 0x016E000001630075007200720065006E0074007500730065007200);
GO
-- 2,500 tables for paging; one batch keeps fixture time low.
DECLARE @i int = 0, @sql nvarchar(max);
WHILE @i < 2500
BEGIN
    SET @sql = N'CREATE TABLE [bulk].' + QUOTENAME(N't' + RIGHT(N'0000' + CONVERT(nvarchar(10), @i), 4)) + N' (id int NULL);';
    EXEC (@sql);
    SET @i += 1;
END;
GO
