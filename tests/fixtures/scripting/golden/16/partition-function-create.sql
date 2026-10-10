USE [<scratch>]
GO

/****** Object:  PartitionFunction [pf_Range]    Script Date: <date> ******/
CREATE PARTITION FUNCTION [pf_Range](int) AS RANGE LEFT FOR VALUES (10, 20)
GO

