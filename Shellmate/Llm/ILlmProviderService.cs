using Shellmate.Models;

namespace Shellmate.Llm;

public interface ILlmProviderService
{
    Task<List<LlmProvider>> GetAllAsync(CancellationToken cancellationToken = default);
    Task<LlmProvider?> GetByIdAsync(int id, CancellationToken cancellationToken = default);
    Task<LlmProvider?> GetByNameAsync(string name, CancellationToken cancellationToken = default);
    Task<LlmProvider?> GetDefaultAsync(CancellationToken cancellationToken = default);
    Task<ChatProviderAvailability> GetDefaultChatProviderAvailabilityAsync(CancellationToken cancellationToken = default);
    Task<bool> IsChatProviderWorkingAsync(int providerId, CancellationToken cancellationToken = default);
    Task<bool> IsCodexConnectedAsync(CancellationToken cancellationToken = default);
    Task<LlmProvider> CreateAsync(LlmProvider provider, string? apiKey = null, CancellationToken cancellationToken = default);
    Task<LlmProvider> UpdateAsync(LlmProvider provider, string? apiKey = null, CancellationToken cancellationToken = default);
    Task DeleteAsync(int id, CancellationToken cancellationToken = default);
    Task SetDefaultAsync(int id, CancellationToken cancellationToken = default);
    Task<LlmProvider> MarkChatTestSucceededAsync(LlmProvider provider, CancellationToken cancellationToken = default);
    Task<LlmProvider> MarkChatTestFailedAsync(LlmProvider provider, string error, CancellationToken cancellationToken = default);
    Task<string?> GetEffectiveApiKeyAsync(int providerId, CancellationToken cancellationToken = default);
}

public sealed record ChatProviderAvailability(
    bool IsAvailable,
    LlmProvider? Provider,
    string Message)
{
    public static ChatProviderAvailability Available(LlmProvider provider) =>
        new(true, provider, string.Empty);

    public static ChatProviderAvailability Unavailable(string message, LlmProvider? provider = null) =>
        new(false, provider, message);
}
