USE [<scratch>]
GO

DECLARE @RC decimal(10,2)
DECLARE @a decimal(10,2)
DECLARE @b int

-- TODO: Set parameter values here.

EXECUTE @RC = [dbo].[fn_Scalar] 
   @a
  ,@b
GO

