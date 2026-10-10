USE [<scratch>]
GO

ALTER TABLE [dbo].[Likes] ADD CONSTRAINT [EC_Likes] CONNECTION ([dbo].[Person] To [dbo].[Person])
GO

