USE [<scratch>]
GO

DECLARE @RC int
DECLARE @Rows cursor

-- TODO: Set parameter values here.

EXECUTE @RC = [dbo].[usp_Cursor] 
   @Rows OUTPUT
GO

