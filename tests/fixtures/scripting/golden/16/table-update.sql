USE [<scratch>]
GO

UPDATE [dbo].[KitchenSink]
   SET [Code] = <Code, nchar(8),>
      ,[Name] = <Name, [dbo].[Name],>
      ,[Price] = <Price, decimal(10_2),>
      ,[Quantity] = <Quantity, int,>
      ,[CustomerId] = <CustomerId, int,>
      ,[ReferrerId] = <ReferrerId, int,>
      ,[Created] = <Created, datetime2(3),>
 WHERE <Search Conditions,,>
GO

