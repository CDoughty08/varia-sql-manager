USE [master]
GO

/****** Object:  DdlTrigger [<scratch>_trg]    Script Date: <date> ******/
DROP TRIGGER [<scratch>_trg] ON ALL SERVER
GO

/****** Object:  DdlTrigger [<scratch>_trg]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TRIGGER [<scratch>_trg] ON ALL SERVER FOR CREATE_CREDENTIAL AS SET NOCOUNT ON;
GO

DISABLE TRIGGER [<scratch>_trg] ON ALL SERVER
GO

