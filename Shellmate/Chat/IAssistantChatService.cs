using Shellmate.Models;

namespace Shellmate.Chat;

public interface IAssistantChatService
{
    Task<AssistantConversation> GetOrCreateAsync(CancellationToken cancellationToken = default);
    Task<IReadOnlyList<AssistantMessage>> LoadMessagesAsync(Guid conversationId, CancellationToken cancellationToken = default);
    Task ResetAsync(CancellationToken cancellationToken = default);
    IAsyncEnumerable<AssistantTurnUpdate> SendAsync(string userText, CancellationToken cancellationToken = default);
}
