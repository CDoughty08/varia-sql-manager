USE [<scratch>]
GO

INSERT INTO [Customers]
           ([Name]
           ,[Email]
           ,[Created]
           ,[Notes]
           ,[Doc]
           ,[Frag]
           ,[Extra])
     VALUES
           (<Name, [Name],>
           ,<Email, nvarchar(200),>
           ,<Created, datetime2(3),>
           ,<Notes, nvarchar(max),>
           ,<Doc, xml ([dbo].[Coll]),>
           ,<Frag, xml ([dbo].[Coll]),>
           ,<Extra, int,>)
GO

