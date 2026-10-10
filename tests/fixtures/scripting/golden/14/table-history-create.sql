USE [<scratch>]
GO

/****** Object:  Table [Sales].[InvoicesHistory]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TABLE [Sales].[InvoicesHistory](
	[Id] [int] NOT NULL,
	[Amount] [money] NULL,
	[ValidFrom] [datetime2](7) NOT NULL,
	[ValidTo] [datetime2](7) NOT NULL
) ON [PRIMARY]
GO

/****** Object:  Index [ix_InvoicesHistory]    Script Date: <date> ******/
CREATE CLUSTERED INDEX [ix_InvoicesHistory] ON [Sales].[InvoicesHistory]
(
	[ValidTo] ASC,
	[ValidFrom] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
GO

