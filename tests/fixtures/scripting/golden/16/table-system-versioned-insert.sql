USE [<scratch>]
GO

INSERT INTO [Sales].[Invoices]
           ([Id]
           ,[Amount])
     VALUES
           (<Id, int,>
           ,<Amount, money,>)
GO

