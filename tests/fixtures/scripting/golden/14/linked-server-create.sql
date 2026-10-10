USE [master]
GO

/****** Object:  LinkedServer [<scratch>_ls]    Script Date: <date> ******/
EXEC master.dbo.sp_addlinkedserver @server = N'<scratch>_ls', @srvproduct=N'', @provider=N'SQLNCLI', @datasrc=N'localhost'
 /* For security reasons the linked server remote logins password is changed with ######## */
EXEC master.dbo.sp_addlinkedsrvlogin @rmtsrvname=N'<scratch>_ls',@useself=N'True',@locallogin=NULL,@rmtuser=NULL,@rmtpassword=NULL
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'collation compatible', @optvalue=N'false'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'data access', @optvalue=N'true'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'dist', @optvalue=N'false'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'pub', @optvalue=N'false'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'rpc', @optvalue=N'false'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'rpc out', @optvalue=N'false'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'sub', @optvalue=N'false'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'connect timeout', @optvalue=N'0'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'collation name', @optvalue=null
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'lazy schema validation', @optvalue=N'false'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'query timeout', @optvalue=N'0'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'use remote collation', @optvalue=N'true'
GO

EXEC master.dbo.sp_serveroption @server=N'<scratch>_ls', @optname=N'remote proc transaction promotion', @optvalue=N'false'
GO

