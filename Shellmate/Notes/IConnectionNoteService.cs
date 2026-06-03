namespace Shellmate.Notes;

public interface IConnectionNoteService
{
    Task<IReadOnlyList<ConnectionNoteSummary>> ListAsync(Guid connectionId, CancellationToken cancellationToken = default);
    Task<ConnectionNoteDetail?> GetAsync(Guid connectionId, Guid noteId, CancellationToken cancellationToken = default);
    Task<ConnectionNoteDetail?> GetByTitleAsync(Guid connectionId, string title, CancellationToken cancellationToken = default);
    Task<ConnectionNoteDetail> CreateDefaultAsync(Guid connectionId, CancellationToken cancellationToken = default);
    Task<ConnectionNoteDetail> CreateAsync(
        Guid connectionId,
        string title,
        string? content = null,
        CancellationToken cancellationToken = default);
    Task<ConnectionNoteDetail> RenameAsync(Guid connectionId, Guid noteId, string title, CancellationToken cancellationToken = default);
    Task<ConnectionNoteDetail> RenameByTitleAsync(
        Guid connectionId,
        string currentTitle,
        string newTitle,
        CancellationToken cancellationToken = default);
    Task<ConnectionNoteDetail> UpdateContentAsync(
        Guid connectionId,
        Guid noteId,
        string content,
        CancellationToken cancellationToken = default);
    Task<ConnectionNoteDetail> UpdateContentByTitleAsync(
        Guid connectionId,
        string title,
        string content,
        CancellationToken cancellationToken = default);
    Task DeleteAsync(Guid connectionId, Guid noteId, CancellationToken cancellationToken = default);
    Task DeleteByTitleAsync(Guid connectionId, string title, CancellationToken cancellationToken = default);
}
