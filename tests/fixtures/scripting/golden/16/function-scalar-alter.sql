USE [<scratch>]
GO

/****** Object:  UserDefinedFunction [dbo].[fn_Scalar]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

ALTER FUNCTION [dbo].[fn_Scalar] (@a decimal(10, 2), @b int = 2) RETURNS decimal(10, 2) AS BEGIN RETURN @a * @b; END;
GO

