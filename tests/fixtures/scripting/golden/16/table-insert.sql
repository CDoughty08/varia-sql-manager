USE [<scratch>]
GO

INSERT INTO [dbo].[KitchenSink]
           ([Code]
           ,[Name]
           ,[Price]
           ,[Quantity]
           ,[CustomerId]
           ,[ReferrerId]
           ,[Created])
     VALUES
           (<Code, nchar(8),>
           ,<Name, [dbo].[Name],>
           ,<Price, decimal(10_2),>
           ,<Quantity, int,>
           ,<CustomerId, int,>
           ,<ReferrerId, int,>
           ,<Created, datetime2(3),>)
GO

