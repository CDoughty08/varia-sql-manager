USE [<scratch>]
GO

/****** Object:  PlanGuide pg_Orders    Script Date: <date> ******/
EXEC sp_create_plan_guide @name = N'[pg_Orders]', @stmt = N'SELECT COUNT(*) FROM Sales.Orders', @type = N'SQL', @module_or_batch = N'SELECT COUNT(*) FROM Sales.Orders', @hints = N'OPTION (MAXDOP 1)'
GO

