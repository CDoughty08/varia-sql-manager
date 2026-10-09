-- An edge constraint (SQL Server 2019 and later).
CREATE TABLE dbo.Likes (Rating int NULL, CONSTRAINT EC_Likes CONNECTION (dbo.Person TO dbo.Person)) AS EDGE;
GO
