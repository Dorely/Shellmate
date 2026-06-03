namespace Shellmate.Models;

public class TerminalConnection
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Name { get; set; }
    public TerminalConnectionKind Kind { get; set; }
    public string? Host { get; set; }
    public int Port { get; set; } = 22;
    public string? Username { get; set; }
    public SshAuthenticationType SshAuthType { get; set; } = SshAuthenticationType.Password;
    public string? PrivateKeyPath { get; set; }
    public string? TrustedHostKeyFingerprintSha256 { get; set; }
    public string? TrustedHostKeyName { get; set; }
    public int? TrustedHostKeyBits { get; set; }
    public string? LocalShellPath { get; set; }
    public string? LocalShellArguments { get; set; }
    public string? LocalWorkingDirectory { get; set; }
    public TerminalShellKind ShellKind { get; set; } = TerminalShellKind.Auto;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public List<ConnectionNote> Notes { get; set; } = [];
}

public enum TerminalConnectionKind
{
    Ssh,
    LocalShell
}

public enum SshAuthenticationType
{
    Password,
    PrivateKeyPath
}

public enum TerminalShellKind
{
    Auto,
    Posix,
    PowerShell,
    Cmd
}
