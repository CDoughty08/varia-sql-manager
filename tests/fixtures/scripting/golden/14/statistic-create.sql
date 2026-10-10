USE [<scratch>]
GO

/****** Object:  Statistic [ST_Orders_Quantity]    Script Date: <date> ******/
CREATE STATISTICS [ST_Orders_Quantity] ON [Sales].[Orders]([Quantity])
GO

