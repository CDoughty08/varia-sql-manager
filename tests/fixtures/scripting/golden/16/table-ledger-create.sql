USE [<scratch>]
GO

/****** Object:  Table [dbo].[LedgerNamed]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TABLE [dbo].[LedgerNamed](
	[Id] [int] NOT NULL,
	[Amount] [money] NULL,
	[ledger_start_transaction_id] [bigint] GENERATED ALWAYS AS transaction_id START HIDDEN NOT NULL,
	[ledger_end_transaction_id] [bigint] GENERATED ALWAYS AS transaction_id END HIDDEN NULL,
	[ledger_start_sequence_number] [bigint] GENERATED ALWAYS AS sequence_number START HIDDEN NOT NULL,
	[ledger_end_sequence_number] [bigint] GENERATED ALWAYS AS sequence_number END HIDDEN NULL,
 CONSTRAINT [PK_LedgerNamed] PRIMARY KEY CLUSTERED 
(
	[Id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
WITH
(
SYSTEM_VERSIONING = ON (HISTORY_TABLE = [dbo].[LedgerNamed_History]), 
LEDGER = ON (LEDGER_VIEW = [dbo].[LedgerNamed_Ledger] (TRANSACTION_ID_COLUMN_NAME = [ledger_transaction_id], SEQUENCE_NUMBER_COLUMN_NAME = [ledger_sequence_number], OPERATION_TYPE_COLUMN_NAME = [ledger_operation_type], OPERATION_TYPE_DESC_COLUMN_NAME = [ledger_operation_type_desc]))
)
GO

