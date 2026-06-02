using Shellmate.Models;

namespace Shellmate.Persistence.Repositories;

public interface IAssistantConversationRepository
{
    Task<AssistantConversation?> GetCurrentAsync(CancellationToken cancellationToken = default);
    Task AddConversationAsync(AssistantConversation conversation, CancellationToken cancellationToken = default);
    void RemoveConversation(AssistantConversation conversation);
    Task<IReadOnlyList<AssistantMessage>> LoadMessagesAsync(Guid conversationId, CancellationToken cancellationToken = default);
    Task<int> GetMaxOrderAsync(Guid conversationId, CancellationToken cancellationToken = default);
    Task AddMessageAsync(AssistantMessage message, CancellationToken cancellationToken = default);
    void UpdateMessage(AssistantMessage message);
    Task SaveChangesAsync(CancellationToken cancellationToken = default);
}
