USE [<scratch>]
GO

ALTER TABLE [Sales].[Orders]  WITH NOCHECK ADD  CONSTRAINT [FK_Orders_Backup] FOREIGN KEY([BackupId])
REFERENCES [Sales].[Customers] ([Id])
GO

ALTER TABLE [Sales].[Orders] NOCHECK CONSTRAINT [FK_Orders_Backup]
GO

