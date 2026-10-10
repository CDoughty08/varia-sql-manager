USE [<scratch>]
GO

/****** Object:  StoredProcedure [dbo].[usp_CreateOrAlter]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE   PROCEDURE [dbo].[usp_CreateOrAlter] @x int = 2 AS SELECT @x AS two;
GO

