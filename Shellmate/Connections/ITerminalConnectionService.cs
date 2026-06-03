using Shellmate.Models;

namespace Shellmate.Connections;

public interface ITerminalConnectionService
{
    Task<List<TerminalConnection>> ListAsync(CancellationToken cancellationToken = default);
    Task<TerminalConnection?> GetAsync(Guid id, CancellationToken cancellationToken = default);
    Task<TerminalConnectionSecretStatus> GetSecretStatusAsync(Guid id, CancellationToken cancellationToken = default);
    Task<TerminalConnection> CreateAsync(TerminalConnectionDraft draft, CancellationToken cancellationToken = default);
    Task UpdateAsync(Guid id, TerminalConnectionDraft draft, CancellationToken cancellationToken = default);
    Task DeleteAsync(Guid id, CancellationToken cancellationToken = default);
    Task TrustHostKeyAsync(Guid id, SshHostKeyTrust trust, CancellationToken cancellationToken = default);
}
