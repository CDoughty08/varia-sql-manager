USE [<scratch>]
GO

/****** Object:  UserDefinedFunction [dbo].[fn_Inline]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER FUNCTION [dbo].[fn_Inline] (@x int = 1) RETURNS TABLE AS RETURN SELECT @x AS Value, N'a' AS Name;
GO

