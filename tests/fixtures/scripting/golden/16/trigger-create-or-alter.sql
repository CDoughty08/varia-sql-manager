USE [<scratch>]
GO

/****** Object:  Trigger [Sales].[TR_Orders_Audit]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER TRIGGER [Sales].[TR_Orders_Audit] ON [Sales].[Orders] AFTER INSERT AS SET NOCOUNT ON;
GO

ALTER TABLE [Sales].[Orders] ENABLE TRIGGER [TR_Orders_Audit]
GO

