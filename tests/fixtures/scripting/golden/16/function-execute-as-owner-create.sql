USE [<scratch>]
GO

/****** Object:  UserDefinedFunction [dbo].[fn_Owner]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE FUNCTION [dbo].[fn_Owner] (@x int) RETURNS int WITH EXECUTE AS OWNER AS BEGIN RETURN @x + 1; END;
GO

