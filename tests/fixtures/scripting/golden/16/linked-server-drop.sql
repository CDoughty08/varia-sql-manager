USE [master]
GO

/****** Object:  LinkedServer [<scratch>_ls]    Script Date: <date> ******/
EXEC master.dbo.sp_dropserver @server=N'<scratch>_ls', @droplogins='droplogins'
GO

