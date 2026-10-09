USE [master]
GO

/****** Object:  Audit [<scratch>_audit]    Script Date: <date> ******/
CREATE SERVER AUDIT [<scratch>_audit]
TO FILE 
(	FILEPATH = N'<path>'
	,MAXSIZE = 0 MB
	,MAX_ROLLOVER_FILES = 2147483647
	,RESERVE_DISK_SPACE = OFF
) WITH (QUEUE_DELAY = 1000, ON_FAILURE = CONTINUE, AUDIT_GUID = '<guid>')
ALTER SERVER AUDIT [<scratch>_audit] WITH (STATE = OFF)
GO

