using Microsoft.Extensions.AI;
using Shellmate.Models;

namespace Shellmate.Llm;

public interface IChatClientFactory
{
    Task<IChatClient> CreateChatClientAsync(int providerId, CancellationToken cancellationToken = default);
    Task TestModelAsync(int providerId, CancellationToken cancellationToken = default);
    Task TestModelAsync(LlmProvider provider, string? apiKeyOverride = null, CancellationToken cancellationToken = default);
}
