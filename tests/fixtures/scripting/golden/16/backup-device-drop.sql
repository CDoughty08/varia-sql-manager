USE [master]
GO

/****** Object:  BackupDevice [<scratch>_dev]    Script Date: <date> ******/
EXEC master.dbo.sp_dropdevice @logicalname = N'<scratch>_dev'
GO

