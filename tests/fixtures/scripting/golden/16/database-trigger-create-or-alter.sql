USE [<scratch>]
GO

/****** Object:  DdlTrigger [trg_ddl_on]    Script Date: <date> ******/
CREATE OR ALTER TRIGGER [trg_ddl_on] ON DATABASE FOR CREATE_TABLE AS SET NOCOUNT ON;
GO

ENABLE TRIGGER [trg_ddl_on] ON DATABASE
GO

