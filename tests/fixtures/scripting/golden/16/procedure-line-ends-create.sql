USE [<scratch>]
GO

/****** Object:  StoredProcedure [dbo].[usp_LineEnds]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE PROCEDURE [dbo].[usp_LineEnds]
AS
SELECT N'one
two' AS Text;
SELECT 2 AS Two;
GO

