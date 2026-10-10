USE [master]
GO

/****** Object:  Database [<scratch>_snap]    Script Date: <date> ******/
CREATE DATABASE [<scratch>_snap]
 CONTAINMENT = NONE
 ON 
( NAME = N'<scratch>', FILENAME = N'<path>' ) AS SNAPSHOT OF [<scratch>]
GO

ALTER DATABASE [<scratch>_snap] SET QUERY_STORE = OFF
GO

ALTER DATABASE [<scratch>_snap] SET  READ_ONLY 
GO

