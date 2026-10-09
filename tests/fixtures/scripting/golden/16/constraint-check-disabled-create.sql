USE [<scratch>]
GO

ALTER TABLE [Sales].[Orders]  WITH NOCHECK ADD  CONSTRAINT [CK_Orders_Quantity] CHECK  (([Quantity]>(0)))
GO

ALTER TABLE [Sales].[Orders] NOCHECK CONSTRAINT [CK_Orders_Quantity]
GO

