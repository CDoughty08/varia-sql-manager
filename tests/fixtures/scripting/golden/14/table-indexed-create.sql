USE [<scratch>]
GO

/****** Object:  Table [dbo].[Indexed]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TABLE [dbo].[Indexed](
	[Id] [int] NOT NULL,
	[Status] [tinyint] NOT NULL,
	[Amount] [money] NULL,
 CONSTRAINT [PK_Indexed] PRIMARY KEY CLUSTERED 
(
	[Id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
) ON [PRIMARY]
GO

/****** Object:  Index [IX_Indexed_Open]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Indexed_Open] ON [dbo].[Indexed]
(
	[Status] ASC
)
WHERE ([Status]=(1))
WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
GO

/****** Object:  Index [CS_Indexed]    Script Date: <date> ******/
CREATE NONCLUSTERED COLUMNSTORE INDEX [CS_Indexed] ON [dbo].[Indexed]
(
	[Id],
	[Status],
	[Amount]
)WITH (DROP_EXISTING = OFF, COMPRESSION_DELAY = 0) ON [PRIMARY]
GO

