USE [<scratch>]
GO

/****** Object:  PartitionScheme [ps_Range]    Script Date: <date> ******/
CREATE PARTITION SCHEME [ps_Range] AS PARTITION [pf_Range] TO ([PRIMARY], [PRIMARY], [PRIMARY], [PRIMARY])
GO

