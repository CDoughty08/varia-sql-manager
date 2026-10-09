USE [<scratch>]
GO

ALTER TABLE [Sales].[Customers] ADD  CONSTRAINT [DF_Customers_Created]  DEFAULT (sysdatetime()) FOR [Created]
GO

