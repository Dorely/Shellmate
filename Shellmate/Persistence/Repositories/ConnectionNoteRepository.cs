using Microsoft.EntityFrameworkCore;
using Shellmate.Models;

namespace Shellmate.Persistence.Repositories;

public sealed class ConnectionNoteRepository(AppDbContext db) : IConnectionNoteRepository
{
    public Task<List<ConnectionNote>> ListByConnectionAsync(
        Guid connectionId,
        CancellationToken cancellationToken = default) =>
        db.ConnectionNotes
            .AsNoTracking()
            .Where(note => note.TerminalConnectionId == connectionId)
            .OrderBy(note => note.Title)
            .ToListAsync(cancellationToken);

    public Task<ConnectionNote?> GetByIdAsync(Guid id, CancellationToken cancellationToken = default) =>
        db.ConnectionNotes.FirstOrDefaultAsync(note => note.Id == id, cancellationToken);

    public Task<ConnectionNote?> GetByConnectionAndNormalizedTitleAsync(
        Guid connectionId,
        string normalizedTitle,
        CancellationToken cancellationToken = default) =>
        db.ConnectionNotes.FirstOrDefaultAsync(
            note => note.TerminalConnectionId == connectionId && note.NormalizedTitle == normalizedTitle,
            cancellationToken);

    public async Task AddAsync(ConnectionNote note, CancellationToken cancellationToken = default) =>
        await db.ConnectionNotes.AddAsync(note, cancellationToken);

    public void Update(ConnectionNote note) => db.ConnectionNotes.Update(note);

    public void Remove(ConnectionNote note) => db.ConnectionNotes.Remove(note);

    public Task SaveChangesAsync(CancellationToken cancellationToken = default) =>
        db.SaveChangesAsync(cancellationToken);
}
