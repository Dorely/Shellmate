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
