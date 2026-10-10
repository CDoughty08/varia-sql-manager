USE [<scratch>]
GO

/****** Object:  ApplicationRole [AppRole]    Script Date: <date> ******/
/* To avoid disclosure of passwords, the password is generated in script. */
declare @idx as int
declare @placeholderPwd as nvarchar(64)
declare @rnd as float
select @idx = 0
select @placeholderPwd = N''
select @rnd = rand((@@CPU_BUSY % 100) + ((@@IDLE % 100) * 100) + 
       (DATEPART(ss, GETDATE()) * 10000) + ((cast(DATEPART(ms, GETDATE()) as int) % 100) * 1000000))
while @idx < 64
begin
   select @placeholderPwd = @placeholderPwd + char((cast((@rnd * 83) as int) + 43))
   select @idx = @idx + 1
select @rnd = rand()
end
declare @statement nvarchar(4000)
select @statement = N'CREATE APPLICATION ROLE [AppRole] WITH DEFAULT_SCHEMA = [dbo], ' + N'PASSWORD=N'<password>'')
EXEC dbo.sp_executesql @statement
GO

