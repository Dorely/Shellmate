namespace Shellmate.Models;

public class OAuthToken
{
    public int Id { get; set; }
    public int ProviderId { get; set; }
    public required string AccessTokenSecretName { get; set; }
    public string? RefreshTokenSecretName { get; set; }
    public DateTime ExpiresAt { get; set; }
    public string? Scope { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public LlmProvider Provider { get; set; } = null!;
}
