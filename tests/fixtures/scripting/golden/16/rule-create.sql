USE [<scratch>]
GO

/****** Object:  Rule [r_Positive]    Script Date: <date> ******/
CREATE RULE [dbo].[r_Positive] 
AS
@value > 0;
GO

