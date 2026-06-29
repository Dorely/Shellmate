using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using Shellmate.Llm;
using Shellmate.Terminal;

namespace Shellmate.Chat;

public sealed record AssistantShellToolContext(
    ITerminalSessionService Terminal,
    CancellationToken CancellationToken);

public sealed class AssistantShellTools(IOptions<AgentOptions> options)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
        Converters = { new JsonStringEnumConverter() }
    };

    public IList<AITool> Build(AssistantShellToolContext context)
    {
        return new List<AITool>
        {
            AIFunctionFactory.Create(
                method: () => ReadTerminalState(context),
                name: "read_terminal_state",
                description: "Read the currently connected terminal state as JSON, including connection name/type, shell kind, any active command, recent commands, and bounded recent output. This cannot connect or disconnect terminals."),

            AIFunctionFactory.Create(
                method: (string command, int? timeoutSeconds = null) => RunShellCommandAsync(context, command, timeoutSeconds),
                name: "run_shell_command",
                description: "Execute one command or multi-line script in the currently connected terminal shell and return bounded JSON output. The timeout is only an observation window; if it expires, the command keeps running and the result status is Running. The tool cannot connect to a terminal. If sudo is needed, start with sudo -v or one short standalone sudo command with a timeout long enough for the user to answer the Shellmate password prompt, then run diagnostics separately after sudo is available."),

            AIFunctionFactory.Create(
                method: (int seconds) => WaitForTerminalAsync(context, seconds),
                name: "wait_for_terminal",
                description: "Wait for a bounded number of seconds, then return the current terminal state as JSON. Use this after run_shell_command returns status Running, or when the terminal is expected to produce more output soon."),

            AIFunctionFactory.Create(
                method: (string? reason = null) => ResetTerminalConnectionAsync(context, reason),
                name: "reset_terminal_connection",
                description: "Recover a locked or unusable terminal by stopping the current backend session and reconnecting the same connection profile. Use only when waiting and reading state indicate the terminal is stuck or unusable."),
        };
    }

    private static string ReadTerminalState(AssistantShellToolContext context)
    {
        var snapshot = context.Terminal.GetSnapshot();
        return JsonSerializer.Serialize(snapshot, JsonOptions);
    }

    private async Task<string> RunShellCommandAsync(
        AssistantShellToolContext context,
        string command,
        int? timeoutSeconds)
    {
        if (string.IsNullOrWhiteSpace(command))
            return "Error: command is required.";

        var effectiveTimeout = Math.Clamp(
            timeoutSeconds ?? options.Value.TerminalCommandTimeoutSeconds,
            1,
            120);
        var result = await context.Terminal.ExecuteCommandAsync(
            command,
            TimeSpan.FromSeconds(effectiveTimeout),
            context.CancellationToken);

        return JsonSerializer.Serialize(result, JsonOptions);
    }

    private async Task<string> WaitForTerminalAsync(AssistantShellToolContext context, int seconds)
    {
        var effectiveSeconds = Math.Clamp(seconds, 1, Math.Max(1, options.Value.TerminalWaitMaxSeconds));
        await Task.Delay(TimeSpan.FromSeconds(effectiveSeconds), context.CancellationToken);
        return ReadTerminalState(context);
    }

    private static async Task<string> ResetTerminalConnectionAsync(
        AssistantShellToolContext context,
        string? reason)
    {
        var result = await context.Terminal.ResetConnectionAsync(reason, context.CancellationToken);
        return JsonSerializer.Serialize(result, JsonOptions);
    }
}
