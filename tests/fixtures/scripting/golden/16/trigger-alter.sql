USE [<scratch>]
GO

/****** Object:  Trigger [Sales].[TR_Orders_Audit]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

ALTER TRIGGER [Sales].[TR_Orders_Audit] ON [Sales].[Orders] AFTER INSERT AS SET NOCOUNT ON;
GO

