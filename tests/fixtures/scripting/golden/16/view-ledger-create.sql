USE [<scratch>]
GO

/****** Object:  View [dbo].[LedgerNamed_Ledger]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE VIEW [dbo].[LedgerNamed_Ledger]  AS 
SELECT [Id], [Amount], [ledger_start_transaction_id] AS [ledger_transaction_id], [ledger_start_sequence_number] AS [ledger_sequence_number], 1 AS [ledger_operation_type], N'INSERT' AS [ledger_operation_type_desc] FROM [dbo].[LedgerNamed]			UNION ALL			SELECT [Id], [Amount], [ledger_start_transaction_id] AS [ledger_transaction_id], [ledger_start_sequence_number] AS [ledger_sequence_number], 1 AS [ledger_operation_type], N'INSERT' AS [ledger_operation_type_desc] FROM [dbo].[LedgerNamed_History]			UNION ALL			SELECT [Id], [Amount], [ledger_end_transaction_id] AS [ledger_transaction_id], [ledger_end_sequence_number] AS [ledger_sequence_number], 2 AS [ledger_operation_type], N'DELETE' AS [ledger_operation_type_desc] FROM [dbo].[LedgerNamed_History]
GO

