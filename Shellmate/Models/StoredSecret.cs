namespace Shellmate.Models;

public class StoredSecret
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public required string Value { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
