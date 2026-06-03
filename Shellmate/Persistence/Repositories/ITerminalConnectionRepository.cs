using Shellmate.Models;

namespace Shellmate.Persistence.Repositories;

public interface ITerminalConnectionRepository
{
    Task<List<TerminalConnection>> GetAllAsync(CancellationToken cancellationToken = default);
    Task<TerminalConnection?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    Task<TerminalConnection?> GetByNameAsync(string name, CancellationToken cancellationToken = default);
    Task AddAsync(TerminalConnection connection, CancellationToken cancellationToken = default);
    void Update(TerminalConnection connection);
    void Remove(TerminalConnection connection);
    Task SaveChangesAsync(CancellationToken cancellationToken = default);
}
