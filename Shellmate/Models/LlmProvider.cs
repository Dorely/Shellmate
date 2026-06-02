namespace Shellmate.Models;

public class LlmProvider
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public string? DisplayName { get; set; }
    public required string EndpointUrl { get; set; }
    public required string ModelId { get; set; }
    public AuthType AuthType { get; set; }
    public bool IsDefault { get; set; }
    public bool LastChatTestSucceeded { get; set; }
    public DateTime? LastChatTestedAt { get; set; }
    public string? LastChatTestError { get; set; }
    public string? LastChatTestEndpointUrl { get; set; }
    public string? LastChatTestModelId { get; set; }
    public AuthType? LastChatTestAuthType { get; set; }
    public int? LastChatTestCredentialSourceId { get; set; }

    public int? CredentialSourceId { get; set; }
    public LlmProvider? CredentialSource { get; set; }
    public ICollection<LlmProvider> ChildModels { get; set; } = [];

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public ICollection<OAuthToken> OAuthTokens { get; set; } = [];

    public int EffectiveCredentialProviderId => CredentialSourceId ?? Id;

    public bool HasCurrentChatTestSnapshot =>
        LastChatTestSucceeded
        && string.Equals(LastChatTestEndpointUrl, EndpointUrl, StringComparison.Ordinal)
        && string.Equals(LastChatTestModelId, ModelId, StringComparison.Ordinal)
        && LastChatTestAuthType == AuthType
        && LastChatTestCredentialSourceId == CredentialSourceId;

    public void MarkChatTestSucceeded(DateTime testedAt)
    {
        LastChatTestSucceeded = true;
        LastChatTestedAt = testedAt;
        LastChatTestError = null;
        LastChatTestEndpointUrl = EndpointUrl;
        LastChatTestModelId = ModelId;
        LastChatTestAuthType = AuthType;
        LastChatTestCredentialSourceId = CredentialSourceId;
    }

    public void MarkChatTestFailed(string error, DateTime testedAt)
    {
        LastChatTestSucceeded = false;
        LastChatTestedAt = testedAt;
        LastChatTestError = error;
        LastChatTestEndpointUrl = EndpointUrl;
        LastChatTestModelId = ModelId;
        LastChatTestAuthType = AuthType;
        LastChatTestCredentialSourceId = CredentialSourceId;
    }

    public void ClearChatReadiness(string? reason = null)
    {
        LastChatTestSucceeded = false;
        LastChatTestError = reason;
    }
}
