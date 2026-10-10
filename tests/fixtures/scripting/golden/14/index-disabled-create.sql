USE [<scratch>]
GO

/****** Object:  Index [IX_Orders_Disabled]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Orders_Disabled] ON [Sales].[Orders]
(
	[Quantity] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
GO

ALTER INDEX [IX_Orders_Disabled] ON [Sales].[Orders] DISABLE
GO

