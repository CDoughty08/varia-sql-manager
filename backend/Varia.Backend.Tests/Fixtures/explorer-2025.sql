-- The vector and json types (SQL Server 2025 and later).
CREATE TABLE dbo.Embeddings (Id int NOT NULL PRIMARY KEY, Embedding vector(3) NULL, Document json NULL);
GO
