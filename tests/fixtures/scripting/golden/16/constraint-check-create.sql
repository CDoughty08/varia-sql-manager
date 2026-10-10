USE [<scratch>]
GO

ALTER TABLE [Sales].[Orders]  WITH CHECK ADD  CONSTRAINT [CK_Orders_Price] CHECK  (([Price]>=(0)))
GO

ALTER TABLE [Sales].[Orders] CHECK CONSTRAINT [CK_Orders_Price]
GO

