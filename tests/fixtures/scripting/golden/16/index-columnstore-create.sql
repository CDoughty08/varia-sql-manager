USE [<scratch>]
GO

/****** Object:  Index [CS_Indexed]    Script Date: <date> ******/
CREATE NONCLUSTERED COLUMNSTORE INDEX [CS_Indexed] ON [dbo].[Indexed]
(
	[Id],
	[Status],
	[Amount]
)WITH (DROP_EXISTING = OFF, COMPRESSION_DELAY = 0) ON [PRIMARY]
GO

