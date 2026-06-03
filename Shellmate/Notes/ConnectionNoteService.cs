using Shellmate.Models;
using Shellmate.Persistence.Repositories;

namespace Shellmate.Notes;

public sealed class ConnectionNoteService(
    IConnectionNoteRepository notes,
    ITerminalConnectionRepository connections) : IConnectionNoteService
{
    private const string DefaultTitle = "Untitled note";

    public async Task<IReadOnlyList<ConnectionNoteSummary>> ListAsync(
        Guid connectionId,
        CancellationToken cancellationToken = default)
    {
        await EnsureConnectionExistsAsync(connectionId, cancellationToken);
        var items = await notes.ListByConnectionAsync(connectionId, cancellationToken);
        return items.Select(ToSummary).ToList();
    }

    public async Task<ConnectionNoteDetail?> GetAsync(
        Guid connectionId,
        Guid noteId,
        CancellationToken cancellationToken = default)
    {
        var note = await notes.GetByIdAsync(noteId, cancellationToken);
        return note is null || note.TerminalConnectionId != connectionId ? null : ToDetail(note);
    }

    public async Task<ConnectionNoteDetail?> GetByTitleAsync(
        Guid connectionId,
        string title,
        CancellationToken cancellationToken = default)
    {
        var normalizedTitle = NormalizeTitle(title);
        var note = await notes.GetByConnectionAndNormalizedTitleAsync(connectionId, normalizedTitle, cancellationToken);
        return note is null ? null : ToDetail(note);
    }

    public async Task<ConnectionNoteDetail> CreateDefaultAsync(
        Guid connectionId,
        CancellationToken cancellationToken = default)
    {
        await EnsureConnectionExistsAsync(connectionId, cancellationToken);
        var title = await NextDefaultTitleAsync(connectionId, cancellationToken);
        return await CreateAsync(connectionId, title, string.Empty, cancellationToken);
    }

    public async Task<ConnectionNoteDetail> CreateAsync(
        Guid connectionId,
        string title,
        string? content = null,
        CancellationToken cancellationToken = default)
    {
        await EnsureConnectionExistsAsync(connectionId, cancellationToken);
        var normalizedTitle = NormalizeTitle(title);
        await EnsureTitleAvailableAsync(connectionId, normalizedTitle, currentNoteId: null, cancellationToken);

        var now = DateTime.UtcNow;
        var note = new ConnectionNote
        {
            Id = Guid.NewGuid(),
            TerminalConnectionId = connectionId,
            Title = title.Trim(),
            NormalizedTitle = normalizedTitle,
            Content = content ?? string.Empty,
            CreatedAt = now,
            UpdatedAt = now
        };

        await notes.AddAsync(note, cancellationToken);
        await notes.SaveChangesAsync(cancellationToken);
        return ToDetail(note);
    }

    public async Task<ConnectionNoteDetail> RenameAsync(
        Guid connectionId,
        Guid noteId,
        string title,
        CancellationToken cancellationToken = default)
    {
        var note = await GetMutableNoteAsync(connectionId, noteId, cancellationToken);
        var normalizedTitle = NormalizeTitle(title);
        await EnsureTitleAvailableAsync(connectionId, normalizedTitle, note.Id, cancellationToken);

        note.Title = title.Trim();
        note.NormalizedTitle = normalizedTitle;
        note.UpdatedAt = DateTime.UtcNow;
        notes.Update(note);
        await notes.SaveChangesAsync(cancellationToken);
        return ToDetail(note);
    }

    public async Task<ConnectionNoteDetail> RenameByTitleAsync(
        Guid connectionId,
        string currentTitle,
        string newTitle,
        CancellationToken cancellationToken = default)
    {
        var note = await GetMutableNoteByTitleAsync(connectionId, currentTitle, cancellationToken);
        return await RenameAsync(connectionId, note.Id, newTitle, cancellationToken);
    }

    public async Task<ConnectionNoteDetail> UpdateContentAsync(
        Guid connectionId,
        Guid noteId,
        string content,
        CancellationToken cancellationToken = default)
    {
        var note = await GetMutableNoteAsync(connectionId, noteId, cancellationToken);
        note.Content = content;
        note.UpdatedAt = DateTime.UtcNow;
        notes.Update(note);
        await notes.SaveChangesAsync(cancellationToken);
        return ToDetail(note);
    }

    public async Task<ConnectionNoteDetail> UpdateContentByTitleAsync(
        Guid connectionId,
        string title,
        string content,
        CancellationToken cancellationToken = default)
    {
        var note = await GetMutableNoteByTitleAsync(connectionId, title, cancellationToken);
        return await UpdateContentAsync(connectionId, note.Id, content, cancellationToken);
    }

    public async Task DeleteAsync(Guid connectionId, Guid noteId, CancellationToken cancellationToken = default)
    {
        var note = await GetMutableNoteAsync(connectionId, noteId, cancellationToken);
        notes.Remove(note);
        await notes.SaveChangesAsync(cancellationToken);
    }

    public async Task DeleteByTitleAsync(
        Guid connectionId,
        string title,
        CancellationToken cancellationToken = default)
    {
        var note = await GetMutableNoteByTitleAsync(connectionId, title, cancellationToken);
        notes.Remove(note);
        await notes.SaveChangesAsync(cancellationToken);
    }

    private async Task<ConnectionNote> GetMutableNoteAsync(
        Guid connectionId,
        Guid noteId,
        CancellationToken cancellationToken)
    {
        var note = await notes.GetByIdAsync(noteId, cancellationToken);
        if (note is null || note.TerminalConnectionId != connectionId)
            throw new InvalidOperationException("Note was not found for the selected connection.");

        return note;
    }

    private async Task<ConnectionNote> GetMutableNoteByTitleAsync(
        Guid connectionId,
        string title,
        CancellationToken cancellationToken)
    {
        var normalizedTitle = NormalizeTitle(title);
        var note = await notes.GetByConnectionAndNormalizedTitleAsync(connectionId, normalizedTitle, cancellationToken);
        if (note is null)
            throw new InvalidOperationException("Note was not found for the selected connection.");

        return note;
    }

    private async Task EnsureConnectionExistsAsync(Guid connectionId, CancellationToken cancellationToken)
    {
        if (await connections.GetByIdAsync(connectionId, cancellationToken) is null)
            throw new InvalidOperationException("Connection was not found.");
    }

    private async Task EnsureTitleAvailableAsync(
        Guid connectionId,
        string normalizedTitle,
        Guid? currentNoteId,
        CancellationToken cancellationToken)
    {
        var existing = await notes.GetByConnectionAndNormalizedTitleAsync(connectionId, normalizedTitle, cancellationToken);
        if (existing is not null && existing.Id != currentNoteId)
            throw new InvalidOperationException("A note with that title already exists for this connection.");
    }

    private async Task<string> NextDefaultTitleAsync(Guid connectionId, CancellationToken cancellationToken)
    {
        if (await IsTitleAvailableAsync(connectionId, DefaultTitle, cancellationToken))
            return DefaultTitle;

        for (var index = 2; ; index++)
        {
            var title = $"{DefaultTitle} {index}";
            if (await IsTitleAvailableAsync(connectionId, title, cancellationToken))
                return title;
        }
    }

    private async Task<bool> IsTitleAvailableAsync(Guid connectionId, string title, CancellationToken cancellationToken)
    {
        var normalizedTitle = NormalizeTitle(title);
        return await notes.GetByConnectionAndNormalizedTitleAsync(connectionId, normalizedTitle, cancellationToken) is null;
    }

    private static string NormalizeTitle(string title)
    {
        var trimmed = title.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
            throw new InvalidOperationException("Note title is required.");

        return trimmed.ToUpperInvariant();
    }

    private static ConnectionNoteSummary ToSummary(ConnectionNote note) =>
        new(note.Id, note.Title, note.CreatedAt, note.UpdatedAt, note.Content.Length);

    private static ConnectionNoteDetail ToDetail(ConnectionNote note) =>
        new(note.Id, note.Title, note.Content, note.CreatedAt, note.UpdatedAt);
}
