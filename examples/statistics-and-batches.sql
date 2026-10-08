-- Development demo: only a session-local temporary table is modified.
-- GO ends a batch while keeping this query tab's SQL session.
DROP TABLE IF EXISTS #VariaStatisticsDemo;
CREATE TABLE #VariaStatisticsDemo (id int NOT NULL);
INSERT #VariaStatisticsDemo VALUES (1);
GO

-- This batch executes twice on the same connection.
INSERT #VariaStatisticsDemo VALUES (2);
GO 2

SET STATISTICS TIME, IO ON;
GO
SELECT COUNT(*) AS row_count FROM #VariaStatisticsDemo;
GO
SET STATISTICS TIME, IO OFF;
GO

-- Actual XML plan output is available when the login has SHOWPLAN permission.
-- SET STATISTICS XML ON;
-- GO
-- SELECT COUNT(*) AS row_count FROM #VariaStatisticsDemo;
-- GO
-- SET STATISTICS XML OFF;
-- GO

DROP TABLE #VariaStatisticsDemo;
