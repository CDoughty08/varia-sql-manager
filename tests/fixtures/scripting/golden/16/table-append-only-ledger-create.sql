USE [<scratch>]
GO

/****** Object:  Table [dbo].[LedgerEvents]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TABLE [dbo].[LedgerEvents](
	[Id] [int] NOT NULL,
	[Note] [nvarchar](50) NULL,
	[ledger_start_transaction_id] [bigint] GENERATED ALWAYS AS transaction_id START HIDDEN NOT NULL,
	[ledger_start_sequence_number] [bigint] GENERATED ALWAYS AS sequence_number START HIDDEN NOT NULL
) ON [PRIMARY]
WITH
(
LEDGER = ON (APPEND_ONLY = ON, LEDGER_VIEW = [dbo].[LedgerEvents_Ledger] (TRANSACTION_ID_COLUMN_NAME = [ledger_transaction_id], SEQUENCE_NUMBER_COLUMN_NAME = [ledger_sequence_number], OPERATION_TYPE_COLUMN_NAME = [ledger_operation_type], OPERATION_TYPE_DESC_COLUMN_NAME = [ledger_operation_type_desc]))
)
GO

