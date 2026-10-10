USE [master]
GO

/****** Object:  BackupDevice [<scratch>_dev]    Script Date: <date> ******/
EXEC master.dbo.sp_addumpdevice  @devtype = N'disk', @logicalname = N'<scratch>_dev', @physicalname = N'<path>'
GO

