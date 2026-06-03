using Shellmate.Models;
using Shellmate.Persistence.Repositories;
using Shellmate.Secrets;

namespace Shellmate.Connections;

public sealed class TerminalConnectionService(
    ITerminalConnectionRepository connections,
    ISecretStore secrets) : ITerminalConnectionService
{
    public Task<List<TerminalConnection>> ListAsync(CancellationToken cancellationToken = default) =>
        connections.GetAllAsync(cancellationToken);

    public Task<TerminalConnection?> GetAsync(Guid id, CancellationToken cancellationToken = default) =>
        connections.GetByIdAsync(id, cancellationToken);

    public async Task<TerminalConnectionSecretStatus> GetSecretStatusAsync(
        Guid id,
        CancellationToken cancellationToken = default)
    {
        var password = await secrets.GetAsync(ConnectionSecretNames.SshPassword(id), cancellationToken);
        var passphrase = await secrets.GetAsync(ConnectionSecretNames.SshPrivateKeyPassphrase(id), cancellationToken);
        return new TerminalConnectionSecretStatus(password is not null, passphrase is not null);
    }

    public async Task<TerminalConnection> CreateAsync(
        TerminalConnectionDraft draft,
        CancellationToken cancellationToken = default)
    {
        var normalized = await NormalizeAndValidateAsync(draft, currentId: null, cancellationToken);
        var now = DateTime.UtcNow;
        var connection = new TerminalConnection
        {
            Id = Guid.NewGuid(),
            Name = normalized.Name,
            Kind = normalized.Kind,
            Host = normalized.Host,
            Port = normalized.Port,
            Username = normalized.Username,
            SshAuthType = normalized.SshAuthType,
            PrivateKeyPath = normalized.PrivateKeyPath,
            LocalShellPath = normalized.LocalShellPath,
            LocalShellArguments = normalized.LocalShellArguments,
            LocalWorkingDirectory = normalized.LocalWorkingDirectory,
            ShellKind = normalized.ShellKind,
            CreatedAt = now,
            UpdatedAt = now
        };

        await connections.AddAsync(connection, cancellationToken);
        await connections.SaveChangesAsync(cancellationToken);
        await SaveSecretsAsync(connection.Id, normalized, cancellationToken);
        return connection;
    }

    public async Task UpdateAsync(
        Guid id,
        TerminalConnectionDraft draft,
        CancellationToken cancellationToken = default)
    {
        var connection = await connections.GetByIdAsync(id, cancellationToken)
            ?? throw new InvalidOperationException("Connection was not found.");
        var normalized = await NormalizeAndValidateAsync(draft, id, cancellationToken);

        connection.Name = normalized.Name;
        connection.Kind = normalized.Kind;
        connection.Host = normalized.Host;
        connection.Port = normalized.Port;
        connection.Username = normalized.Username;
        connection.SshAuthType = normalized.SshAuthType;
        connection.PrivateKeyPath = normalized.PrivateKeyPath;
        connection.LocalShellPath = normalized.LocalShellPath;
        connection.LocalShellArguments = normalized.LocalShellArguments;
        connection.LocalWorkingDirectory = normalized.LocalWorkingDirectory;
        connection.ShellKind = normalized.ShellKind;
        connection.UpdatedAt = DateTime.UtcNow;

        if (normalized.ClearTrustedHostKey || connection.Kind != TerminalConnectionKind.Ssh)
            ClearTrustedHostKey(connection);

        connections.Update(connection);
        await connections.SaveChangesAsync(cancellationToken);
        await SaveSecretsAsync(connection.Id, normalized, cancellationToken);
    }

    public async Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
    {
        var connection = await connections.GetByIdAsync(id, cancellationToken);
        if (connection is null)
            return;

        connections.Remove(connection);
        await connections.SaveChangesAsync(cancellationToken);
        await secrets.DeleteAsync(ConnectionSecretNames.SshPassword(id), cancellationToken);
        await secrets.DeleteAsync(ConnectionSecretNames.SshPrivateKeyPassphrase(id), cancellationToken);
    }

    public async Task TrustHostKeyAsync(Guid id, SshHostKeyTrust trust, CancellationToken cancellationToken = default)
    {
        var connection = await connections.GetByIdAsync(id, cancellationToken)
            ?? throw new InvalidOperationException("Connection was not found.");
        if (connection.Kind != TerminalConnectionKind.Ssh)
            throw new InvalidOperationException("Only SSH connections can store host-key trust.");

        connection.TrustedHostKeyFingerprintSha256 = trust.FingerprintSha256;
        connection.TrustedHostKeyName = trust.HostKeyName;
        connection.TrustedHostKeyBits = trust.KeyBits;
        connection.UpdatedAt = DateTime.UtcNow;
        connections.Update(connection);
        await connections.SaveChangesAsync(cancellationToken);
    }

    private async Task<TerminalConnectionDraft> NormalizeAndValidateAsync(
        TerminalConnectionDraft draft,
        Guid? currentId,
        CancellationToken cancellationToken)
    {
        var name = draft.Name.Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidOperationException("Connection name is required.");

        var existing = await connections.GetByNameAsync(name, cancellationToken);
        if (existing is not null && existing.Id != currentId)
            throw new InvalidOperationException("A connection with that name already exists.");

        var host = TrimToNull(draft.Host);
        var username = TrimToNull(draft.Username);
        var privateKeyPath = TrimToNull(draft.PrivateKeyPath);
        var localShellPath = TrimToNull(draft.LocalShellPath);
        var localShellArguments = TrimToNull(draft.LocalShellArguments);
        var localWorkingDirectory = TrimToNull(draft.LocalWorkingDirectory);
        var port = draft.Port <= 0 ? 22 : draft.Port;

        if (draft.Kind == TerminalConnectionKind.Ssh)
        {
            if (string.IsNullOrWhiteSpace(host))
                throw new InvalidOperationException("SSH host is required.");
            if (port is <= 0 or > 65535)
                throw new InvalidOperationException("SSH port must be between 1 and 65535.");
            if (string.IsNullOrWhiteSpace(username))
                throw new InvalidOperationException("SSH username is required.");
            if (draft.SshAuthType == SshAuthenticationType.PrivateKeyPath && string.IsNullOrWhiteSpace(privateKeyPath))
                throw new InvalidOperationException("Private key path is required for private-key authentication.");
        }

        return draft with
        {
            Name = name,
            Host = host,
            Port = port,
            Username = username,
            PrivateKeyPath = privateKeyPath,
            LocalShellPath = localShellPath,
            LocalShellArguments = localShellArguments,
            LocalWorkingDirectory = localWorkingDirectory,
            ShellKind = draft.ShellKind,
            Password = TrimToNull(draft.Password),
            PrivateKeyPassphrase = TrimToNull(draft.PrivateKeyPassphrase)
        };
    }

    private async Task SaveSecretsAsync(
        Guid connectionId,
        TerminalConnectionDraft draft,
        CancellationToken cancellationToken)
    {
        if (draft.Kind != TerminalConnectionKind.Ssh)
        {
            await secrets.DeleteAsync(ConnectionSecretNames.SshPassword(connectionId), cancellationToken);
            await secrets.DeleteAsync(ConnectionSecretNames.SshPrivateKeyPassphrase(connectionId), cancellationToken);
            return;
        }

        if (draft.ClearPassword || draft.SshAuthType != SshAuthenticationType.Password)
            await secrets.DeleteAsync(ConnectionSecretNames.SshPassword(connectionId), cancellationToken);
        if (!string.IsNullOrEmpty(draft.Password))
            await secrets.SetAsync(ConnectionSecretNames.SshPassword(connectionId), draft.Password, cancellationToken);

        if (draft.ClearPrivateKeyPassphrase || draft.SshAuthType != SshAuthenticationType.PrivateKeyPath)
            await secrets.DeleteAsync(ConnectionSecretNames.SshPrivateKeyPassphrase(connectionId), cancellationToken);
        if (!string.IsNullOrEmpty(draft.PrivateKeyPassphrase))
            await secrets.SetAsync(
                ConnectionSecretNames.SshPrivateKeyPassphrase(connectionId),
                draft.PrivateKeyPassphrase,
                cancellationToken);
    }

    private static void ClearTrustedHostKey(TerminalConnection connection)
    {
        connection.TrustedHostKeyFingerprintSha256 = null;
        connection.TrustedHostKeyName = null;
        connection.TrustedHostKeyBits = null;
    }

    private static string? TrimToNull(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed;
    }
}
