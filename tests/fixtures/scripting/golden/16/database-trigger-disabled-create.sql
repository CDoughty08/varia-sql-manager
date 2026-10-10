USE [<scratch>]
GO

/****** Object:  DdlTrigger [trg_ddl_off]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TRIGGER [trg_ddl_off] ON DATABASE FOR DROP_VIEW AS SET NOCOUNT ON;
GO

DISABLE TRIGGER [trg_ddl_off] ON DATABASE
GO

