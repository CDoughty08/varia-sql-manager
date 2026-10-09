USE [<scratch>]
GO

SELECT [Id]
      ,[Amount]
      ,[ledger_transaction_id]
      ,[ledger_sequence_number]
      ,[ledger_operation_type]
      ,[ledger_operation_type_desc]
  FROM [dbo].[LedgerNamed_Ledger]
GO

