USE [<scratch>]
GO

/****** Object:  Trigger [Sales].[TR_Orders_Off]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TRIGGER [Sales].[TR_Orders_Off] ON [Sales].[Orders] AFTER UPDATE AS SET NOCOUNT ON;
GO

ALTER TABLE [Sales].[Orders] DISABLE TRIGGER [TR_Orders_Off]
GO

