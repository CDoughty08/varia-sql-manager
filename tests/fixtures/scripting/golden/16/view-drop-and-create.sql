USE [<scratch>]
GO

/****** Object:  View [dbo].[vCustomers]    Script Date: <date> ******/
DROP VIEW [dbo].[vCustomers]
GO

/****** Object:  View [dbo].[vCustomers]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE VIEW [dbo].[vCustomers]  AS 
SELECT Id, Email FROM Sales.Customers;

GO

