// Code snippets for Insert Snippet (Ctrl+K Ctrl+X) and Surround With (Ctrl+K Ctrl+S), in Monaco's snippet syntax:
// `${1:placeholder}` tab stops, `$0` where the caret ends, `$TM_SELECTED_TEXT` for the surrounded selection. The T-SQL
// is Varia's own; SSMS's .snippet files are Microsoft's and are not copied.

export interface Snippet {
  readonly id: string
  readonly kind: 'expansion' | 'surround'
  readonly category: string
  readonly title: string
  readonly description: string
  readonly body: string
}

/** The categories of SSMS's Code Snippets Manager (SQL), in its order. */
export const snippetCategories = [
  'Function', 'Index', 'Login', 'Role', 'Schema', 'Stored Procedure', 'Synonym', 'Table', 'Trigger', 'User', 'User Defined Data Type',
  'User Defined Table Type', 'User Defined Type', 'View'
] as const
export const snippetLimits = { snippets: 64, bodyChars: 4096 } as const

const expansion = (id: string, category: typeof snippetCategories[number], title: string, description: string, body: string): Snippet =>
  ({ id, kind: 'expansion', category, title, description, body })
const surround = (id: string, title: string, description: string, body: string): Snippet => ({ id, kind: 'surround', category: 'Surround With', title, description, body })

export const snippets: readonly Snippet[] = [
  expansion('function.inlineTable', 'Function', 'Create Inline Table Function', 'An inline table-valued function with one parameter.',
    'CREATE FUNCTION ${1:dbo}.${2:FunctionName}\n(\n\t@${3:Parameter} ${4:int}\n)\nRETURNS TABLE\nAS\nRETURN\n(\n\tSELECT ${5:Column}\n\tFROM ${6:dbo}.${7:TableName}\n\tWHERE ${8:Column} = @${3:Parameter}$0\n)'),
  expansion('index.nonclustered', 'Index', 'Create Nonclustered Index', 'A nonclustered index on one column of a table.',
    'CREATE NONCLUSTERED INDEX ${1:IX_TableName_Column}\nON ${2:dbo}.${3:TableName} (${4:Column})$0'),
  expansion('login.sql', 'Login', 'Create SQL Authentication Login', 'A login that signs in with a SQL Server password.',
    'CREATE LOGIN ${1:LoginName}\nWITH PASSWORD = N\'${2:password}\',\n\tDEFAULT_DATABASE = ${3:master},\n\tCHECK_POLICY = ON$0'),
  expansion('role.create', 'Role', 'Create Role', 'A database role owned by a user or role.',
    'CREATE ROLE ${1:RoleName} AUTHORIZATION ${2:dbo}$0'),
  expansion('schema.create', 'Schema', 'Create Schema', 'A schema owned by a user or role.',
    'CREATE SCHEMA ${1:SchemaName} AUTHORIZATION ${2:dbo}$0'),
  expansion('procedure.basic', 'Stored Procedure', 'Create Procedure Basic Template', 'A stored procedure with one parameter.',
    'CREATE PROCEDURE ${1:dbo}.${2:ProcedureName}\n\t@${3:Parameter} ${4:int} = ${5:0}\nAS\nBEGIN\n\tSET NOCOUNT ON;\n\n\tSELECT @${3:Parameter}$0\nEND'),
  expansion('synonym.create', 'Synonym', 'Create Synonym', 'A synonym for an object in this or another database.',
    'CREATE SYNONYM ${1:dbo}.${2:SynonymName}\nFOR ${3:DatabaseName}.${4:dbo}.${5:ObjectName}$0'),
  expansion('table.create', 'Table', 'Create Table', 'A table with a primary key and one more column.',
    'CREATE TABLE ${1:dbo}.${2:TableName}\n(\n\t${3:Id} ${4:int} NOT NULL PRIMARY KEY,\n\t${5:Name} ${6:nvarchar(100)} NULL$0\n)'),
  expansion('trigger.dml', 'Trigger', 'Create DML Trigger', 'A trigger that runs after rows of a table change.',
    'CREATE TRIGGER ${1:dbo}.${2:TriggerName}\nON ${1:dbo}.${3:TableName}\nAFTER ${4:INSERT, UPDATE}\nAS\nBEGIN\n\tSET NOCOUNT ON;\n\t$0\nEND'),
  expansion('user.create', 'User', 'Create User', 'A database user for a login.',
    'CREATE USER ${1:UserName}\nFOR LOGIN ${2:LoginName}\nWITH DEFAULT_SCHEMA = ${3:dbo}$0'),
  expansion('type.alias', 'User Defined Data Type', 'Create Alias Type', 'An alias type based on a system type.',
    'CREATE TYPE ${1:dbo}.${2:TypeName}\nFROM ${3:nvarchar(50)} ${4:NOT NULL}$0'),
  expansion('type.table', 'User Defined Table Type', 'Create Table Type', 'A table type for table-valued parameters.',
    'CREATE TYPE ${1:dbo}.${2:TypeName} AS TABLE\n(\n\t${3:Id} ${4:int} NOT NULL,\n\t${5:Name} ${6:nvarchar(100)} NULL$0\n)'),
  expansion('type.clr', 'User Defined Type', 'Create CLR Type', 'A type implemented by a class in a registered assembly.',
    'CREATE TYPE ${1:dbo}.${2:TypeName}\nEXTERNAL NAME ${3:AssemblyName}.[${4:Namespace.ClassName}]$0'),
  expansion('view.create', 'View', 'Create View', 'A view over one table.',
    'CREATE VIEW ${1:dbo}.${2:ViewName}\nAS\nSELECT ${3:Column}\nFROM ${4:dbo}.${5:TableName}$0'),
  surround('surround.begin', 'Begin', 'BEGIN … END around the selection.', 'BEGIN\n\t$TM_SELECTED_TEXT$0\nEND'),
  surround('surround.if', 'If', 'IF (condition) BEGIN … END around the selection.', 'IF (${1:condition})\nBEGIN\n\t$TM_SELECTED_TEXT$0\nEND'),
  surround('surround.while', 'While', 'WHILE (condition) BEGIN … END around the selection.', 'WHILE (${1:condition})\nBEGIN\n\t$TM_SELECTED_TEXT$0\nEND')
]

/** Snippets by id. */
export const snippetById = (id: string): Snippet | undefined => snippets.find(snippet => snippet.id === id)
