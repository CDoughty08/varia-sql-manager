USE [<scratch>]
GO

/****** Object:  UserDefinedTableType [Sales].[OrderLines]    Script Date: <date> ******/
CREATE TYPE [Sales].[OrderLines] AS TABLE(
	[Line] [int] NOT NULL,
	[Quantity] [int] NOT NULL,
	[Note] [nvarchar](20) NULL,
	INDEX [IX_Quantity] NONCLUSTERED 
(
	[Quantity] ASC
),
	PRIMARY KEY CLUSTERED 
(
	[Line] ASC
)WITH (IGNORE_DUP_KEY = OFF),
	CHECK (([Quantity]>(0)))
)
GO

