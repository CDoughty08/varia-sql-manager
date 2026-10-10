USE [<scratch>]
GO

SELECT [Id]
      ,[Amount]
      ,[ledger_start_transaction_id]
      ,[ledger_end_transaction_id]
      ,[ledger_start_sequence_number]
      ,[ledger_end_sequence_number]
  FROM [dbo].[LedgerNamed_History]
GO

