USE [<scratch>]
GO

/****** Object:  Table [dbo].[KitchenSink]    Script Date: <date> ******/
IF  EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[KitchenSink]') AND type in (N'U'))
DROP TABLE [dbo].[KitchenSink]
GO

