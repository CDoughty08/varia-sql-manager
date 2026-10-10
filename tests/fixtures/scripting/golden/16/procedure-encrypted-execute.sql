USE [<scratch>]
GO

DECLARE @RC int
DECLARE @x int

-- TODO: Set parameter values here.

EXECUTE @RC = [dbo].[usp_Secret] 
   @x
GO

