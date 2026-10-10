USE [<scratch>]
GO

/****** Object:  Table [dbo].[Wide]    Script Date: <date> ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TABLE [dbo].[Wide](
	[Id] [int] NOT NULL,
	[C001] [int] NULL,
	[C002] [int] NULL,
	[C003] [int] NULL,
	[C004] [int] NULL,
	[C005] [int] NULL,
	[C006] [int] NULL,
	[C007] [int] NULL,
	[C008] [int] NULL,
	[C009] [int] NULL,
	[C010] [int] NULL,
	[C011] [int] NULL,
	[C012] [int] NULL,
	[C013] [int] NULL,
	[C014] [int] NULL,
	[C015] [int] NULL,
	[C016] [int] NULL,
	[C017] [int] NULL,
	[C018] [int] NULL,
	[C019] [int] NULL,
	[C020] [int] NULL,
	[C021] [int] NULL,
	[C022] [int] NULL,
	[C023] [int] NULL,
	[C024] [int] NULL,
	[C025] [int] NULL,
	[C026] [int] NULL,
	[C027] [int] NULL,
	[C028] [int] NULL,
	[C029] [int] NULL,
	[C030] [int] NULL,
	[C031] [int] NULL,
	[C032] [int] NULL,
	[C033] [int] NULL,
	[C034] [int] NULL,
	[C035] [int] NULL,
	[C036] [int] NULL,
	[C037] [int] NULL,
	[C038] [int] NULL,
	[C039] [int] NULL,
	[C040] [int] NULL,
	[C041] [int] NULL,
	[C042] [int] NULL,
	[C043] [int] NULL,
	[C044] [int] NULL,
	[C045] [int] NULL,
	[C046] [int] NULL,
	[C047] [int] NULL,
	[C048] [int] NULL,
	[C049] [int] NULL,
	[C050] [int] NULL,
	[C051] [int] NULL,
	[C052] [int] NULL,
	[C053] [int] NULL,
	[C054] [int] NULL,
	[C055] [int] NULL,
	[C056] [int] NULL,
	[C057] [int] NULL,
	[C058] [int] NULL,
	[C059] [int] NULL,
	[C060] [int] NULL,
	[C061] [int] NULL,
	[C062] [int] NULL,
	[C063] [int] NULL,
	[C064] [int] NULL,
	[C065] [int] NULL,
	[C066] [int] NULL,
	[C067] [int] NULL,
	[C068] [int] NULL,
	[C069] [int] NULL,
	[C070] [int] NULL,
	[C071] [int] NULL,
	[C072] [int] NULL,
	[C073] [int] NULL,
	[C074] [int] NULL,
	[C075] [int] NULL,
	[C076] [int] NULL,
	[C077] [int] NULL,
	[C078] [int] NULL,
	[C079] [int] NULL,
	[C080] [int] NULL,
	[C081] [int] NULL,
	[C082] [int] NULL,
	[C083] [int] NULL,
	[C084] [int] NULL,
	[C085] [int] NULL,
	[C086] [int] NULL,
	[C087] [int] NULL,
	[C088] [int] NULL,
	[C089] [int] NULL,
	[C090] [int] NULL,
	[C091] [int] NULL,
	[C092] [int] NULL,
	[C093] [int] NULL,
	[C094] [int] NULL,
	[C095] [int] NULL,
	[C096] [int] NULL,
	[C097] [int] NULL,
	[C098] [int] NULL,
	[C099] [int] NULL,
	[C100] [int] NULL,
	[C101] [int] NULL,
	[C102] [int] NULL,
	[C103] [int] NULL,
	[C104] [int] NULL,
	[C105] [int] NULL,
	[C106] [int] NULL,
	[C107] [int] NULL,
	[C108] [int] NULL,
	[C109] [int] NULL,
	[C110] [int] NULL,
	[C111] [int] NULL,
	[C112] [int] NULL,
	[C113] [int] NULL,
	[C114] [int] NULL,
	[C115] [int] NULL,
	[C116] [int] NULL,
	[C117] [int] NULL,
	[C118] [int] NULL,
	[C119] [int] NULL,
	[C120] [int] NULL,
	[C121] [int] NULL,
	[C122] [int] NULL,
	[C123] [int] NULL,
	[C124] [int] NULL,
	[C125] [int] NULL,
	[C126] [int] NULL,
	[C127] [int] NULL,
	[C128] [int] NULL,
	[C129] [int] NULL,
	[C130] [int] NULL,
	[C131] [int] NULL,
	[C132] [int] NULL,
	[C133] [int] NULL,
	[C134] [int] NULL,
	[C135] [int] NULL,
	[C136] [int] NULL,
	[C137] [int] NULL,
	[C138] [int] NULL,
	[C139] [int] NULL,
	[C140] [int] NULL,
	[C141] [int] NULL,
	[C142] [int] NULL,
	[C143] [int] NULL,
	[C144] [int] NULL,
	[C145] [int] NULL,
	[C146] [int] NULL,
	[C147] [int] NULL,
	[C148] [int] NULL,
	[C149] [int] NULL,
	[C150] [int] NULL,
	[C151] [int] NULL,
	[C152] [int] NULL,
	[C153] [int] NULL,
	[C154] [int] NULL,
	[C155] [int] NULL,
	[C156] [int] NULL,
	[C157] [int] NULL,
	[C158] [int] NULL,
	[C159] [int] NULL,
	[C160] [int] NULL,
	[C161] [int] NULL,
	[C162] [int] NULL,
	[C163] [int] NULL,
	[C164] [int] NULL,
	[C165] [int] NULL,
	[C166] [int] NULL,
	[C167] [int] NULL,
	[C168] [int] NULL,
	[C169] [int] NULL,
	[C170] [int] NULL,
	[C171] [int] NULL,
	[C172] [int] NULL,
	[C173] [int] NULL,
	[C174] [int] NULL,
	[C175] [int] NULL,
	[C176] [int] NULL,
	[C177] [int] NULL,
	[C178] [int] NULL,
	[C179] [int] NULL,
	[C180] [int] NULL,
	[C181] [int] NULL,
	[C182] [int] NULL,
	[C183] [int] NULL,
	[C184] [int] NULL,
	[C185] [int] NULL,
	[C186] [int] NULL,
	[C187] [int] NULL,
	[C188] [int] NULL,
	[C189] [int] NULL,
	[C190] [int] NULL,
	[C191] [int] NULL,
	[C192] [int] NULL,
	[C193] [int] NULL,
	[C194] [int] NULL,
	[C195] [int] NULL,
	[C196] [int] NULL,
	[C197] [int] NULL,
	[C198] [int] NULL,
	[C199] [int] NULL,
	[C200] [int] NULL,
	[C201] [int] NULL,
	[C202] [int] NULL,
	[C203] [int] NULL,
	[C204] [int] NULL,
	[C205] [int] NULL,
	[C206] [int] NULL,
	[C207] [int] NULL,
	[C208] [int] NULL,
	[C209] [int] NULL,
	[C210] [int] NULL,
	[C211] [int] NULL,
	[C212] [int] NULL,
	[C213] [int] NULL,
	[C214] [int] NULL,
	[C215] [int] NULL,
	[C216] [int] NULL,
	[C217] [int] NULL,
	[C218] [int] NULL,
	[C219] [int] NULL,
	[C220] [int] NULL,
	[C221] [int] NULL,
	[C222] [int] NULL,
	[C223] [int] NULL,
	[C224] [int] NULL,
	[C225] [int] NULL,
	[C226] [int] NULL,
	[C227] [int] NULL,
	[C228] [int] NULL,
	[C229] [int] NULL,
	[C230] [int] NULL,
	[C231] [int] NULL,
	[C232] [int] NULL,
	[C233] [int] NULL,
	[C234] [int] NULL,
	[C235] [int] NULL,
	[C236] [int] NULL,
	[C237] [int] NULL,
	[C238] [int] NULL,
	[C239] [int] NULL,
	[C240] [int] NULL,
	[C241] [int] NULL,
	[C242] [int] NULL,
	[C243] [int] NULL,
	[C244] [int] NULL,
	[C245] [int] NULL,
	[C246] [int] NULL,
	[C247] [int] NULL,
	[C248] [int] NULL,
	[C249] [int] NULL,
	[C250] [int] NULL,
	[C251] [int] NULL,
	[C252] [int] NULL,
	[C253] [int] NULL,
	[C254] [int] NULL,
	[C255] [int] NULL,
	[C256] [int] NULL,
	[C257] [int] NULL,
	[C258] [int] NULL,
	[C259] [int] NULL,
	[C260] [int] NULL,
	[C261] [int] NULL,
	[C262] [int] NULL,
	[C263] [int] NULL,
	[C264] [int] NULL,
	[C265] [int] NULL,
	[C266] [int] NULL,
	[C267] [int] NULL,
	[C268] [int] NULL,
	[C269] [int] NULL,
	[C270] [int] NULL,
	[C271] [int] NULL,
	[C272] [int] NULL,
	[C273] [int] NULL,
	[C274] [int] NULL,
	[C275] [int] NULL,
	[C276] [int] NULL,
	[C277] [int] NULL,
	[C278] [int] NULL,
	[C279] [int] NULL,
	[C280] [int] NULL,
	[C281] [int] NULL,
	[C282] [int] NULL,
	[C283] [int] NULL,
	[C284] [int] NULL,
	[C285] [int] NULL,
	[C286] [int] NULL,
	[C287] [int] NULL,
	[C288] [int] NULL,
	[C289] [int] NULL,
	[C290] [int] NULL,
	[C291] [int] NULL,
	[C292] [int] NULL,
	[C293] [int] NULL,
	[C294] [int] NULL,
	[C295] [int] NULL,
	[C296] [int] NULL,
	[C297] [int] NULL,
	[C298] [int] NULL,
	[C299] [int] NULL,
 CONSTRAINT [PK_Wide] PRIMARY KEY CLUSTERED 
(
	[Id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_01]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_01] ON [dbo].[Wide]
(
	[C001] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_02]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_02] ON [dbo].[Wide]
(
	[C002] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_03]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_03] ON [dbo].[Wide]
(
	[C003] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_04]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_04] ON [dbo].[Wide]
(
	[C004] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_05]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_05] ON [dbo].[Wide]
(
	[C005] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_06]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_06] ON [dbo].[Wide]
(
	[C006] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_07]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_07] ON [dbo].[Wide]
(
	[C007] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_08]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_08] ON [dbo].[Wide]
(
	[C008] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_09]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_09] ON [dbo].[Wide]
(
	[C009] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_10]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_10] ON [dbo].[Wide]
(
	[C010] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_11]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_11] ON [dbo].[Wide]
(
	[C011] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_12]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_12] ON [dbo].[Wide]
(
	[C012] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_13]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_13] ON [dbo].[Wide]
(
	[C013] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_14]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_14] ON [dbo].[Wide]
(
	[C014] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_15]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_15] ON [dbo].[Wide]
(
	[C015] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_16]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_16] ON [dbo].[Wide]
(
	[C016] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_17]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_17] ON [dbo].[Wide]
(
	[C017] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_18]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_18] ON [dbo].[Wide]
(
	[C018] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_19]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_19] ON [dbo].[Wide]
(
	[C019] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

/****** Object:  Index [IX_Wide_20]    Script Date: <date> ******/
CREATE NONCLUSTERED INDEX [IX_Wide_20] ON [dbo].[Wide]
(
	[C020] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

