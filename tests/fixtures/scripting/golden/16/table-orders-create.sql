USE [<scratch>]
GO

/****** Object:  Table [Sales].[Orders]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

SET ANSI_PADDING ON
GO

CREATE TABLE [Sales].[Orders](
	[Id] [int] NOT NULL,
	[CustomerId] [int] NULL,
	[ReferrerId] [int] NULL,
	[BackupId] [int] NULL,
	[Price] [decimal](8, 2) NOT NULL,
	[Quantity] [int] NOT NULL,
	[Total]  AS ([Price]*[Quantity]),
	[Payload] [varbinary](max) NULL,
 CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED 
(
	[Id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO

SET ANSI_PADDING OFF
GO

/****** Object:  Index [IX_Orders_Customer]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Orders_Customer] ON [Sales].[Orders]
(
	[CustomerId] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Orders_Disabled]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Orders_Disabled] ON [Sales].[Orders]
(
	[Quantity] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

ALTER INDEX [IX_Orders_Disabled] ON [Sales].[Orders] DISABLE
GO

/****** Object:  Index [IX_Orders_Price]    Script Date: <date> ******/
CREATE UNIQUE NONCLUSTERED INDEX [IX_Orders_Price] ON [Sales].[Orders]
(
	[Price] ASC,
	[Id] ASC
)
WHERE ([Price]>(0))
WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, IGNORE_DUP_KEY = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

ALTER TABLE [Sales].[Orders]  WITH NOCHECK ADD  CONSTRAINT [FK_Orders_Backup] FOREIGN KEY([BackupId])
REFERENCES [Sales].[Customers] ([Id])
GO

ALTER TABLE [Sales].[Orders] NOCHECK CONSTRAINT [FK_Orders_Backup]
GO

ALTER TABLE [Sales].[Orders]  WITH CHECK ADD  CONSTRAINT [FK_Orders_Customers] FOREIGN KEY([CustomerId])
REFERENCES [Sales].[Customers] ([Id])
GO

ALTER TABLE [Sales].[Orders] CHECK CONSTRAINT [FK_Orders_Customers]
GO

ALTER TABLE [Sales].[Orders]  WITH NOCHECK ADD  CONSTRAINT [FK_Orders_Referrer] FOREIGN KEY([ReferrerId])
REFERENCES [Sales].[Customers] ([Id])
GO

ALTER TABLE [Sales].[Orders] CHECK CONSTRAINT [FK_Orders_Referrer]
GO

ALTER TABLE [Sales].[Orders]  WITH CHECK ADD  CONSTRAINT [CK_Orders_Price] CHECK  (([Price]>=(0)))
GO

ALTER TABLE [Sales].[Orders] CHECK CONSTRAINT [CK_Orders_Price]
GO

ALTER TABLE [Sales].[Orders]  WITH NOCHECK ADD  CONSTRAINT [CK_Orders_Quantity] CHECK  (([Quantity]>(0)))
GO

ALTER TABLE [Sales].[Orders] NOCHECK CONSTRAINT [CK_Orders_Quantity]
GO

