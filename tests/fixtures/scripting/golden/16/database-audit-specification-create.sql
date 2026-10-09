USE [<scratch>]
GO

CREATE DATABASE AUDIT SPECIFICATION [ScratchAuditSpecification]
FOR SERVER AUDIT [<scratch>_audit]
ADD (SELECT ON SCHEMA::[Sales] BY [public])
WITH (STATE = OFF)
GO

