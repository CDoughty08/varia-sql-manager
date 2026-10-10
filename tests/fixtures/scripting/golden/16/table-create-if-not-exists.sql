USE [<scratch>]
GO

/****** Object:  Table [dbo].[KitchenSink]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

SET ANSI_PADDING ON
GO

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[KitchenSink]') AND type in (N'U'))
BEGIN
CREATE TABLE [dbo].[KitchenSink](
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
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF),
 CONSTRAINT [UQ_KitchenSink_Code] UNIQUE NONCLUSTERED 
(
	[Code] ASC,
	[Id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF)
)
END
GO

SET ANSI_PADDING OFF
GO

/****** Object:  Index [IX_KitchenSink_Created]    Script Date: <date> ******/
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE object_id = OBJECT_ID(N'[dbo].[KitchenSink]') AND name = N'IX_KitchenSink_Created')
CREATE NONCLUSTERED INDEX [IX_KitchenSink_Created] ON [dbo].[KitchenSink]
(
	[Created] DESC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, FILLFACTOR = 90, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF)
GO

/****** Object:  Index [IX_KitchenSink_Customer]    Script Date: <date> ******/
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE object_id = OBJECT_ID(N'[dbo].[KitchenSink]') AND name = N'IX_KitchenSink_Customer')
CREATE NONCLUSTERED INDEX [IX_KitchenSink_Customer] ON [dbo].[KitchenSink]
(
	[CustomerId] ASC
)
INCLUDE([Price]) WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF)
GO

SET ANSI_PADDING ON
GO

/****** Object:  Index [IX_KitchenSink_Name]    Script Date: <date> ******/
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE object_id = OBJECT_ID(N'[dbo].[KitchenSink]') AND name = N'IX_KitchenSink_Name')
CREATE NONCLUSTERED INDEX [IX_KitchenSink_Name] ON [dbo].[KitchenSink]
(
	[Name] ASC
)
WHERE ([Name] IS NOT NULL)
WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF)
GO

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[DF_KitchenSink_Code]') AND type = 'D')
BEGIN
ALTER TABLE [dbo].[KitchenSink] ADD  CONSTRAINT [DF_KitchenSink_Code]  DEFAULT (N'NEW') FOR [Code]
END
GO

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[DF_KitchenSink_Quantity]') AND type = 'D')
BEGIN
ALTER TABLE [dbo].[KitchenSink] ADD  CONSTRAINT [DF_KitchenSink_Quantity]  DEFAULT ((1)) FOR [Quantity]
END
GO

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[DF_KitchenSink_Created]') AND type = 'D')
BEGIN
ALTER TABLE [dbo].[KitchenSink] ADD  CONSTRAINT [DF_KitchenSink_Created]  DEFAULT (sysdatetime()) FOR [Created]
END
GO

IF NOT EXISTS (SELECT * FROM sys.foreign_keys WHERE object_id = OBJECT_ID(N'[dbo].[FK_KitchenSink_Customer]') AND parent_object_id = OBJECT_ID(N'[dbo].[KitchenSink]'))
ALTER TABLE [dbo].[KitchenSink]  WITH NOCHECK ADD  CONSTRAINT [FK_KitchenSink_Customer] FOREIGN KEY([CustomerId])
REFERENCES [Sales].[Customers] ([Id])
GO

IF  EXISTS (SELECT * FROM sys.foreign_keys WHERE object_id = OBJECT_ID(N'[dbo].[FK_KitchenSink_Customer]') AND parent_object_id = OBJECT_ID(N'[dbo].[KitchenSink]'))
ALTER TABLE [dbo].[KitchenSink] CHECK CONSTRAINT [FK_KitchenSink_Customer]
GO

IF NOT EXISTS (SELECT * FROM sys.foreign_keys WHERE object_id = OBJECT_ID(N'[dbo].[FK_KitchenSink_Referrer]') AND parent_object_id = OBJECT_ID(N'[dbo].[KitchenSink]'))
ALTER TABLE [dbo].[KitchenSink]  WITH NOCHECK ADD  CONSTRAINT [FK_KitchenSink_Referrer] FOREIGN KEY([ReferrerId])
REFERENCES [Sales].[Customers] ([Id])
ON DELETE SET NULL
GO

IF  EXISTS (SELECT * FROM sys.foreign_keys WHERE object_id = OBJECT_ID(N'[dbo].[FK_KitchenSink_Referrer]') AND parent_object_id = OBJECT_ID(N'[dbo].[KitchenSink]'))
ALTER TABLE [dbo].[KitchenSink] NOCHECK CONSTRAINT [FK_KitchenSink_Referrer]
GO

IF NOT EXISTS (SELECT * FROM sys.check_constraints WHERE object_id = OBJECT_ID(N'[dbo].[CK_KitchenSink_Price]') AND parent_object_id = OBJECT_ID(N'[dbo].[KitchenSink]'))
ALTER TABLE [dbo].[KitchenSink]  WITH CHECK ADD  CONSTRAINT [CK_KitchenSink_Price] CHECK  (([Price]>=(0)))
GO

IF  EXISTS (SELECT * FROM sys.check_constraints WHERE object_id = OBJECT_ID(N'[dbo].[CK_KitchenSink_Price]') AND parent_object_id = OBJECT_ID(N'[dbo].[KitchenSink]'))
ALTER TABLE [dbo].[KitchenSink] CHECK CONSTRAINT [CK_KitchenSink_Price]
GO

IF NOT EXISTS (SELECT * FROM sys.fn_listextendedproperty(N'MS_Description' , N'SCHEMA',N'dbo', N'TABLE',N'KitchenSink', N'COLUMN',N'Price'))
	EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Price before tax.' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'KitchenSink', @level2type=N'COLUMN',@level2name=N'Price'
GO

IF NOT EXISTS (SELECT * FROM sys.fn_listextendedproperty(N'MS_Description' , N'SCHEMA',N'dbo', N'TABLE',N'KitchenSink', NULL,NULL))
	EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Everything a table can carry.' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'KitchenSink'
GO

