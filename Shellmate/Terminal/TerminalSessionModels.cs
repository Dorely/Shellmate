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
    TerminalActiveCommandSnapshot? ActiveCommand,
    IReadOnlyList<TerminalCommandRecord> RecentCommands,
    string RecentOutput,
    bool RecentOutputTruncated);

public sealed record TerminalActiveCommandSnapshot(
    Guid Id,
    string Command,
    DateTime StartedAt,
    double ElapsedSeconds,
    TerminalCommandStatus Status,
    string Output,
    bool OutputTruncated,
    string? Message);

public sealed record TerminalCommandRecord(
    Guid Id,
    TerminalCommandOrigin Origin,
    string Command,
    DateTime StartedAt,
    DateTime? CompletedAt,
    int? ExitCode,
    TerminalCommandStatus Status,
    string Output,
    bool OutputTruncated,
    string? Message,
    string? Error);

public enum TerminalCommandOrigin
{
    User,
    Assistant
}

public enum TerminalCommandStatus
{
    Running,
    Completed,
    Failed,
    Cancelled
}

public sealed record TerminalCommandResult(
    Guid Id,
    string Command,
    DateTime StartedAt,
    DateTime? CompletedAt,
    int? ExitCode,
    TerminalCommandStatus Status,
    string Output,
    bool OutputTruncated,
    string? Message,
    string? Error);

public sealed record TerminalResetResult(
    TerminalResetStatus Status,
    bool Reconnected,
    string Message,
    TerminalSnapshot Snapshot,
    TerminalHostKeyPrompt? HostKeyPrompt = null)
{
    public static TerminalResetResult ReconnectedSnapshot(TerminalSnapshot snapshot) =>
        new(TerminalResetStatus.Reconnected, Reconnected: true, "Terminal connection reset and reconnected.", snapshot);

    public static TerminalResetResult HostKeyRequired(TerminalHostKeyPrompt prompt, TerminalSnapshot snapshot) =>
        new(TerminalResetStatus.HostKeyRequired, Reconnected: false, "SSH host key trust is required before reconnecting.", snapshot, prompt);

    public static TerminalResetResult Failed(string message, TerminalSnapshot snapshot) =>
        new(TerminalResetStatus.Failed, Reconnected: false, message, snapshot);
}

public enum TerminalResetStatus
{
    Reconnected,
    HostKeyRequired,
    Failed
}

public sealed record TerminalElevationPrompt(
    Guid Id,
    string ConnectionName,
    string Command,
    string PromptText,
    int Attempt = 1);

public sealed record TerminalElevationResponse(
    bool Approved,
    string? Password);
