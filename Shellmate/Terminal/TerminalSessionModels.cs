using Shellmate.Models;

namespace Shellmate.Terminal;

public sealed record TerminalSize(int Cols, int Rows)
{
    public static TerminalSize Default { get; } = new(80, 24);
}

public sealed record TerminalHostKeyPrompt(
    Guid ConnectionId,
    string Host,
    int Port,
    string HostKeyName,
    string FingerprintSha256,
    int KeyBits);

public sealed record TerminalConnectResult(
    bool Connected,
    string? ErrorMessage = null,
    TerminalHostKeyPrompt? HostKeyPrompt = null)
{
    public static TerminalConnectResult Success() => new(true);
    public static TerminalConnectResult Error(string message) => new(false, message);
    public static TerminalConnectResult HostKeyRequired(TerminalHostKeyPrompt prompt) => new(false, null, prompt);
}

public sealed record TerminalOutput(TerminalOutputKind Kind, string Text);

public enum TerminalOutputKind
{
    Data,
    Status,
    Error,
    Exited
}

public sealed record ResolvedSshConnection(
    TerminalConnection Connection,
    string? Password,
    string? PrivateKeyPassphrase);

public sealed record TerminalShellDescriptor(
    TerminalShellKind Kind,
    bool IsAssumed,
    string Label);

public sealed record TerminalSnapshot(
    bool IsConnected,
    string? ConnectionName,
    TerminalConnectionKind? ConnectionKind,
    TerminalShellDescriptor? Shell,
    IReadOnlyList<TerminalCommandRecord> RecentCommands,
    string RecentOutput,
    bool RecentOutputTruncated);

public sealed record TerminalCommandRecord(
    Guid Id,
    TerminalCommandOrigin Origin,
    string Command,
    DateTime StartedAt,
    DateTime? CompletedAt,
    int? ExitCode,
    bool TimedOut,
    bool Cancelled,
    string Output,
    bool OutputTruncated,
    string? Error);

public enum TerminalCommandOrigin
{
    User,
    Assistant
}

public sealed record TerminalCommandResult(
    Guid Id,
    string Command,
    DateTime StartedAt,
    DateTime CompletedAt,
    int? ExitCode,
    bool TimedOut,
    bool Cancelled,
    string Output,
    bool OutputTruncated,
    string? Error);

public sealed record TerminalElevationPrompt(
    Guid Id,
    string ConnectionName,
    string Command,
    string PromptText,
    int Attempt = 1);

public sealed record TerminalElevationResponse(
    bool Approved,
    string? Password);
