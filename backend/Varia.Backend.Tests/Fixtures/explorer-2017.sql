-- Graph tables (SQL Server 2017 and later).
CREATE TABLE dbo.Person (Id int NOT NULL PRIMARY KEY, Name nvarchar(50) NULL) AS NODE;
GO
CREATE TABLE dbo.Knows (Since date NULL) AS EDGE;
GO
