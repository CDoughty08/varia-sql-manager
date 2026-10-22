/* To prevent any potential data loss issues, you should review this script in detail before running it outside the context of the database designer.*/
BEGIN TRANSACTION
SET QUOTED_IDENTIFIER ON
SET ARITHABORT ON
SET NUMERIC_ROUNDABORT OFF
SET CONCAT_NULL_YIELDS_NULL ON
SET ANSI_NULLS ON
SET ANSI_PADDING ON
SET ANSI_WARNINGS ON
COMMIT
BEGIN TRANSACTION
GO
CREATE TABLE sales.OrderLines
	(
	OrderId bigint NOT NULL,
	Line smallint NOT NULL,
	Amount decimal(19, 4) NOT NULL,
	Shipped datetime2(3) NULL,
	Flag bit NULL,
	Code char(3) NULL
	)  ON [PRIMARY]
GO
ALTER TABLE sales.OrderLines ADD CONSTRAINT
	PK_OrderLines PRIMARY KEY CLUSTERED 
	(
	Line,
	OrderId
	) WITH( STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]

GO
ALTER TABLE sales.OrderLines SET (LOCK_ESCALATION = TABLE)
GO
COMMIT
