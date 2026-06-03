using Shellmate.Models;

namespace Shellmate.Persistence.Repositories;

public interface IConnectionNoteRepository
{
    Task<List<ConnectionNote>> ListByConnectionAsync(Guid connectionId, CancellationToken cancellationToken = default);
    Task<ConnectionNote?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default);
    Task<ConnectionNote?> GetByConnectionAndNormalizedTitleAsync(
        Guid connectionId,
        string normalizedTitle,
        CancellationToken cancellationToken = default);
    Task AddAsync(ConnectionNote note, CancellationToken cancellationToken = default);
    void Update(ConnectionNote note);
    void Remove(ConnectionNote note);
    Task SaveChangesAsync(CancellationToken cancellationToken = default);
}
