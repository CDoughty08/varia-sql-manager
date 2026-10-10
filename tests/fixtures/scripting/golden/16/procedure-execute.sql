USE [<scratch>]
GO

DECLARE @RC int
DECLARE @CustomerId int
DECLARE @Since datetime2(3)
DECLARE @Count int
DECLARE @Lines [Sales].[OrderLines]
DECLARE @Label nvarchar(20)

-- TODO: Set parameter values here.

EXECUTE @RC = [Sales].[usp_Orders] 
   @CustomerId
  ,@Since
  ,@Count OUTPUT
  ,@Lines
  ,@Label
GO

