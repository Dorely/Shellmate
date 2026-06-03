namespace Shellmate.Notes;

public sealed record ConnectionNoteSummary(
    Guid Id,
    string Title,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    int ContentLength);

public sealed record ConnectionNoteDetail(
    Guid Id,
    string Title,
    string Content,
    DateTime CreatedAt,
    DateTime UpdatedAt);
