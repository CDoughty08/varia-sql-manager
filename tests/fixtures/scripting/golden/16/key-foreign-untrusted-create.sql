USE [<scratch>]
GO

ALTER TABLE [Sales].[Orders]  WITH NOCHECK ADD  CONSTRAINT [FK_Orders_Referrer] FOREIGN KEY([ReferrerId])
REFERENCES [Sales].[Customers] ([Id])
GO

ALTER TABLE [Sales].[Orders] CHECK CONSTRAINT [FK_Orders_Referrer]
GO

