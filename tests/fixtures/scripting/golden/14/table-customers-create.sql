USE [<scratch>]
GO

/****** Object:  Table [Sales].[Customers]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TABLE [Sales].[Customers](
	[Id] [int] IDENTITY(1,1) NOT NULL,
	[Name] [dbo].[Name] NOT NULL,
	[Email] [nvarchar](200) NULL,
	[Created] [datetime2](3) NOT NULL,
	[Notes] [nvarchar](max) NULL,
	[Doc] [xml](DOCUMENT [dbo].[Coll]) NULL,
	[Frag] [xml](CONTENT [dbo].[Coll]) NULL,
	[Extra] [int] SPARSE  NULL,
 CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED 
(
	[Id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY],
 CONSTRAINT [UQ_Customers_Email] UNIQUE NONCLUSTERED 
(
	[Email] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO

ALTER TABLE [Sales].[Customers] ADD  CONSTRAINT [DF_Customers_Created]  DEFAULT (sysdatetime()) FOR [Created]
GO

