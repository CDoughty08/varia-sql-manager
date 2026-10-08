using System.Text.Json;
using System.Text.Json.Serialization;
using Varia.Backend;
using Varia.Backend.Protocol;

// stdout carries protocol v2 frames only, so take it before anything can write there, then send Console.Out to stderr.
var output = Console.OpenStandardOutput();
var input = new BufferedStream(Console.OpenStandardInput(), 64 * 1024);
Console.SetOut(Console.Error);
Console.SetIn(TextReader.Null);
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web)
{
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
};
var host = new ProtocolHost(input, output, () => new SqlService(), json);
AppDomain.CurrentDomain.UnhandledException += (_, e) => host.Crash(e.ExceptionObject);
var code = 0;
var reader = new Thread(() => code = host.Run()) { Name = "varia-ipc-reader" };
reader.Start();
reader.Join();
return code;
