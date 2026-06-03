using Microsoft.EntityFrameworkCore;
using Shellmate.Models;

namespace Shellmate.Persistence.Repositories;

public sealed class TerminalConnectionRepository(AppDbContext db) : ITerminalConnectionRepository
{
    public Task<List<TerminalConnection>> GetAllAsync(CancellationToken cancellationToken = default) =>
        db.TerminalConnections
            .AsNoTracking()
            .OrderBy(connection => connection.Name)
            .ToListAsync(cancellationToken);

    public Task<TerminalConnection?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        db.TerminalConnections.FirstOrDefaultAsync(connection => connection.Id == id, cancellationToken);

    public Task<TerminalConnection?> GetByNameAsync(string name, CancellationToken cancellationToken = default) =>
        db.TerminalConnections.FirstOrDefaultAsync(connection => connection.Name == name, cancellationToken);

    public async Task AddAsync(TerminalConnection connection, CancellationToken cancellationToken = default) =>
        await db.TerminalConnections.AddAsync(connection, cancellationToken);

    public void Update(TerminalConnection connection) => db.TerminalConnections.Update(connection);

    public void Remove(TerminalConnection connection) => db.TerminalConnections.Remove(connection);

    public Task SaveChangesAsync(CancellationToken cancellationToken = default) =>
        db.SaveChangesAsync(cancellationToken);
}
