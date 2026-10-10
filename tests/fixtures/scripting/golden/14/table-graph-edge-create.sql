USE [<scratch>]
GO

/****** Object:  Table [dbo].[Knows]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TABLE [dbo].[Knows](
	[Since] [date] NULL
)
AS EDGE ON [PRIMARY]
GO

/****** Object:  Index [GRAPH_UNIQUE_INDEX_<id>]    Script Date: <date> ******/
CREATE UNIQUE NONCLUSTERED INDEX [GRAPH_UNIQUE_INDEX_<id>] ON [dbo].[Knows]
(
	$edge_id
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, IGNORE_DUP_KEY = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
GO

