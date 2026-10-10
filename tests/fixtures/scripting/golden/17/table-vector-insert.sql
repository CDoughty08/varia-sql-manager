USE [<scratch>]
GO

INSERT INTO [dbo].[Embeddings]
           ([Id]
           ,[Embedding]
           ,[Document])
     VALUES
           (<Id, int,>
           ,<Embedding, vector(3),>
           ,<Document, json,>)
GO

