USE [<scratch>]
GO

/****** Object:  StoredProcedure [Sales].[usp_Orders]    Script Date: <date> ******/
DROP PROCEDURE [Sales].[usp_Orders]
GO

/****** Object:  StoredProcedure [Sales].[usp_Orders]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

-- A comment with "@CustomerId int = 1" must not count as a default.
CREATE PROCEDURE [Sales].[usp_Orders]
    @CustomerId int,
    @Since datetime2(3) = NULL,
    @Count int = 0 OUTPUT,
    @Lines Sales.OrderLines READONLY,
    @Label nvarchar(20) = N'it''s = 1'
AS
SELECT @Count = COUNT(*) FROM Sales.Orders WHERE CustomerId = @CustomerId;
GO

