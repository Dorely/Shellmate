using Shellmate.Models;

namespace Shellmate.Connections;

public sealed record TerminalConnectionDraft(
    string Name,
    TerminalConnectionKind Kind,
    string? Host,
    int Port,
    string? Username,
    SshAuthenticationType SshAuthType,
    string? PrivateKeyPath,
    string? LocalShellPath,
    string? LocalShellArguments,
    string? LocalWorkingDirectory,
    string? Password,
    bool ClearPassword,
    string? PrivateKeyPassphrase,
    bool ClearPrivateKeyPassphrase,
    bool ClearTrustedHostKey);

public sealed record TerminalConnectionSecretStatus(
    bool HasPassword,
    bool HasPrivateKeyPassphrase);

public sealed record SshHostKeyTrust(
    string FingerprintSha256,
    string HostKeyName,
    int KeyBits);
