USE [<scratch>]
GO

/****** Object:  Table [KitchenSink]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

SET ANSI_PADDING ON
GO

CREATE TABLE [KitchenSink](
	[Id] [int] IDENTITY(1,1) NOT NULL,
	[Code] [nchar](8) NOT NULL,
	[Name] [dbo].[Name] NULL,
	[Price] [decimal](10, 2) NOT NULL,
	[Quantity] [int] NOT NULL,
	[Total]  AS ([Price]*[Quantity]) PERSISTED,
	[CustomerId] [int] NULL,
	[ReferrerId] [int] NULL,
	[Created] [datetime2](3) NOT NULL,
	[RowVersion] [timestamp] NOT NULL,
 CONSTRAINT [PK_KitchenSink] PRIMARY KEY CLUSTERED 
(
	[Id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON),
 CONSTRAINT [UQ_KitchenSink_Code] UNIQUE NONCLUSTERED 
(
	[Code] ASC,
	[Id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON)
)
GO

SET ANSI_PADDING OFF
GO

/****** Object:  Index [IX_KitchenSink_Created]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_KitchenSink_Created] ON [KitchenSink]
(
	[Created] DESC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, FILLFACTOR = 90)
GO

/****** Object:  Index [IX_KitchenSink_Customer]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_KitchenSink_Customer] ON [KitchenSink]
(
	[CustomerId] ASC
)
INCLUDE([Price]) WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON)
GO

SET ANSI_PADDING ON
GO

/****** Object:  Index [IX_KitchenSink_Name]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_KitchenSink_Name] ON [KitchenSink]
(
	[Name] ASC
)
WHERE ([Name] IS NOT NULL)
WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON)
GO

ALTER TABLE [KitchenSink] ADD  CONSTRAINT [DF_KitchenSink_Code]  DEFAULT (N'NEW') FOR [Code]
GO

ALTER TABLE [KitchenSink] ADD  CONSTRAINT [DF_KitchenSink_Quantity]  DEFAULT ((1)) FOR [Quantity]
GO

ALTER TABLE [KitchenSink] ADD  CONSTRAINT [DF_KitchenSink_Created]  DEFAULT (sysdatetime()) FOR [Created]
GO

ALTER TABLE [KitchenSink]  WITH NOCHECK ADD  CONSTRAINT [FK_KitchenSink_Customer] FOREIGN KEY([CustomerId])
REFERENCES [Sales].[Customers] ([Id])
GO

ALTER TABLE [KitchenSink] CHECK CONSTRAINT [FK_KitchenSink_Customer]
GO

ALTER TABLE [KitchenSink]  WITH NOCHECK ADD  CONSTRAINT [FK_KitchenSink_Referrer] FOREIGN KEY([ReferrerId])
REFERENCES [Sales].[Customers] ([Id])
ON DELETE SET NULL
GO

ALTER TABLE [KitchenSink] NOCHECK CONSTRAINT [FK_KitchenSink_Referrer]
GO

ALTER TABLE [KitchenSink]  WITH CHECK ADD  CONSTRAINT [CK_KitchenSink_Price] CHECK  (([Price]>=(0)))
GO

ALTER TABLE [KitchenSink] CHECK CONSTRAINT [CK_KitchenSink_Price]
GO

EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Price before tax.' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'KitchenSink', @level2type=N'COLUMN',@level2name=N'Price'
GO

EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Everything a table can carry.' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'KitchenSink'
GO

