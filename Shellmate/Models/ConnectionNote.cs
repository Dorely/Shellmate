namespace Shellmate.Models;

public class ConnectionNote
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TerminalConnectionId { get; set; }
    public required string Title { get; set; }
    public required string NormalizedTitle { get; set; }
    public string Content { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public TerminalConnection TerminalConnection { get; set; } = null!;
}
