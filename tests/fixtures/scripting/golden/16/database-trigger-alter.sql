USE [<scratch>]
GO

/****** Object:  DdlTrigger [trg_ddl_on]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

ALTER TRIGGER [trg_ddl_on] ON DATABASE FOR CREATE_TABLE AS SET NOCOUNT ON;
GO

