USE [<scratch>]
GO

INSERT INTO [dbo].[Knows]
           ([$from_id_<id>]
           ,[$to_id_<id>]
           ,[Since])
     VALUES
           (<$from_id_<id>, nvarchar(1000),>
           ,<$to_id_<id>, nvarchar(1000),>
           ,<Since, date,>)
GO

