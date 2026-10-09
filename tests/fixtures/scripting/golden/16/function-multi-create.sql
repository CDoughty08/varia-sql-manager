USE [<scratch>]
GO

/****** Object:  UserDefinedFunction [dbo].[fn_Multi]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE FUNCTION [dbo].[fn_Multi] (@x int) RETURNS @t TABLE (Value int NOT NULL) AS BEGIN INSERT @t VALUES (@x); RETURN; END;
GO

