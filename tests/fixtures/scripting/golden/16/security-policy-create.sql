USE [<scratch>]
GO

/****** Object:  SecurityPolicy [dbo].[CustomerPolicy]    Script Date: <date> ******/
CREATE SECURITY POLICY [dbo].[CustomerPolicy] 
ADD FILTER PREDICATE [dbo].[fn_Policy]([Id]) ON [Sales].[Customers]
WITH (STATE = OFF, SCHEMABINDING = ON)
GO

