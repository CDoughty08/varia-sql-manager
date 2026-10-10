USE [<scratch>]
GO

/****** Object:  PlanGuide pg_Orders    Script Date: <date> ******/
EXEC sp_control_plan_guide @operation = N'DROP', @name = N'[pg_Orders]'
GO

