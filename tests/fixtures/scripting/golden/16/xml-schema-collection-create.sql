USE [<scratch>]
GO

/****** Object:  XmlSchemaCollection [dbo].[Coll]    Script Date: <date> ******/
CREATE XML SCHEMA COLLECTION [dbo].[Coll] AS N'<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"><xsd:element name="a" type="xsd:string" /></xsd:schema>'
GO

