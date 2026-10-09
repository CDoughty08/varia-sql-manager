USE [<scratch>]
GO

/****** Object:  Index [PK_Orders]    Script Date: <date> ******/
ALTER TABLE [Sales].[Orders] DROP CONSTRAINT [PK_Orders] WITH ( ONLINE = OFF )
GO

