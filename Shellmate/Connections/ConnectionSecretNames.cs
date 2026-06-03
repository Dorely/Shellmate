namespace Shellmate.Connections;

public static class ConnectionSecretNames
{
    public static string SshPassword(Guid connectionId) => $"terminal-connection:{connectionId:N}:ssh-password";
    public static string SshPrivateKeyPassphrase(Guid connectionId) => $"terminal-connection:{connectionId:N}:ssh-key-passphrase";
}
