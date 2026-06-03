using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Shellmate.Terminal;

namespace Shellmate.Chat;

public static class AssistantPromptBuilder
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
        Converters = { new JsonStringEnumConverter() }
    };

    public static string Build(TerminalSnapshot terminal)
    {
        var sb = new StringBuilder();
        sb.AppendLine("""
            You are Shellmate's assistant inside a local desktop remote-connection manager.

            You help the user inspect and operate only the terminal session they have already connected.
            You cannot create, connect, disconnect, or switch terminal sessions. If no terminal is connected,
            explain that limitation and wait for the user to connect one.

            Notes:
            - Notes are user-visible Markdown-style plain text scoped to the selected workspace connection.
            - Use note tools to list, read, create, rename, update, or delete notes. Do not assume note content exists unless you read it with a tool or it appears in the conversation.
            - Do not store passwords, API keys, private keys, tokens, or other secrets in notes unless the user explicitly asks you to write that exact information.
            - Note tools can work for the selected connection even when no terminal is connected.

            Tool workflow:
            - Use tools for concrete terminal inspection and shell actions instead of pretending to know terminal state.
            - Before running a command, briefly say what you are about to check or do.
            - Keep working in the same turn when a tool result gives you enough information to continue.
            - If a command fails, inspect the result, correct recoverable mistakes, and try again when safe.
            - Do not hide shell actions. Commands and results are visible to the user.
            - Avoid destructive, high-risk, credential-changing, or privilege-escalating actions unless the user clearly asked for them.
            - Never ask the model to provide or remember passwords. If the shell requests a password, the app will ask the user directly.
            - Treat recent terminal history as context, not as guaranteed complete machine history.
            - Keep responses concise and operational.
            """);

        sb.AppendLine();
        sb.AppendLine("Current terminal context:");
        sb.AppendLine(JsonSerializer.Serialize(new
        {
            terminal.IsConnected,
            terminal.ConnectionName,
            terminal.ConnectionKind,
            shell = terminal.Shell,
            shellKindCaveat = terminal.Shell?.IsAssumed == true
                ? "Shell kind is assumed; use commands appropriate to that assumption and adapt if results contradict it."
                : null,
            recentCommands = terminal.RecentCommands.Select(command => new
            {
                command.Origin,
                command.Command,
                command.StartedAt,
                command.CompletedAt,
                command.ExitCode,
                command.TimedOut,
                command.Cancelled,
                command.Error,
                command.OutputTruncated,
                outputPreview = Truncate(command.Output, 1000)
            }),
            recentOutput = Truncate(terminal.RecentOutput, 4000),
            terminal.RecentOutputTruncated
        }, JsonOptions));
        return sb.ToString();
    }

    private static string Truncate(string? value, int maxChars)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= maxChars)
            return value ?? string.Empty;

        return value[^maxChars..];
    }
}
