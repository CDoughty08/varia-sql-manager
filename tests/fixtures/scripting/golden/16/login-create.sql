USE [master]
GO

/* For security reasons the login is created disabled and with a random password. */
/****** Object:  Login [<scratch>]    Script Date: <date> ******/
CREATE LOGIN [<scratch>] WITH PASSWORD=N'<password>', DEFAULT_DATABASE=[master], DEFAULT_LANGUAGE=[us_english], CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF
GO

ALTER LOGIN [<scratch>] DISABLE
GO

