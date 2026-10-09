USE [<scratch>]
GO

/****** Object:  Trigger [dbo].[TR_vCustomers]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TRIGGER [dbo].[TR_vCustomers] ON [dbo].[vCustomers] INSTEAD OF INSERT AS SET NOCOUNT ON;
GO

