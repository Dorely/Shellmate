using System.Runtime.CompilerServices;
using System.Text;
using Microsoft.Extensions.AI;
using Shellmate.Llm;
using Shellmate.Models;
using Shellmate.Persistence.Repositories;

namespace Shellmate.Chat;

public sealed class AssistantChatService(
    IAssistantConversationRepository conversations,
    ILlmProviderService providerService,
    IChatClientFactory chatClientFactory,
    ILogger<AssistantChatService> logger) : IAssistantChatService
{
    private const string SystemPrompt = """
        You are Shellmate's assistant in an early desktop-app slice.

        The app is eventually an LLM-enabled remote connection manager, but SSH,
        remote desktop, notes, and machine tools are not connected yet. Be direct
        about that limitation. Help the user think through provider setup,
        connection-management workflows, and operator-safety design. Do not claim
        to inspect or change remote systems.
        """;

    private const string InitialAssistantGreeting =
        "Provider configuration is ready for setup. Add or connect a chat provider, run Test, choose a default, then use this chat to verify the first Shellmate assistant loop.";

    public async Task<AssistantConversation> GetOrCreateAsync(CancellationToken cancellationToken = default)
    {
        var existing = await conversations.GetCurrentAsync(cancellationToken);
        if (existing is not null)
            return existing;

        var conversation = new AssistantConversation();
        await conversations.AddConversationAsync(conversation, cancellationToken);

        var greeting = new AssistantMessage
        {
            ConversationId = conversation.Id,
            Order = 0,
            Role = AssistantMessageRole.Assistant,
            Content = InitialAssistantGreeting,
            Status = AssistantMessageStatus.Completed,
        };
        await conversations.AddMessageAsync(greeting, cancellationToken);
        await conversations.SaveChangesAsync(cancellationToken);
        return conversation;
    }

    public async Task<IReadOnlyList<AssistantMessage>> LoadMessagesAsync(Guid conversationId, CancellationToken cancellationToken = default) =>
        await conversations.LoadMessagesAsync(conversationId, cancellationToken);

    public async Task ResetAsync(CancellationToken cancellationToken = default)
    {
        var existing = await conversations.GetCurrentAsync(cancellationToken);
        if (existing is null)
            return;

        conversations.RemoveConversation(existing);
        await conversations.SaveChangesAsync(cancellationToken);
    }

    public async IAsyncEnumerable<AssistantTurnUpdate> SendAsync(
        string userText,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(userText))
            throw new ArgumentException("Message cannot be empty.", nameof(userText));

        var conversation = await GetOrCreateAsync(cancellationToken);
        var providerAvailability = await providerService.GetDefaultChatProviderAvailabilityAsync(cancellationToken);
        if (!providerAvailability.IsAvailable || providerAvailability.Provider is null)
        {
            yield return new AssistantTurnError(providerAvailability.Message, Cancelled: false);
            yield break;
        }

        var nextOrder = await conversations.GetMaxOrderAsync(conversation.Id, cancellationToken) + 1;

        var userMessage = new AssistantMessage
        {
            ConversationId = conversation.Id,
            Order = nextOrder++,
            Role = AssistantMessageRole.User,
            Content = userText.Trim(),
            Status = AssistantMessageStatus.Completed,
        };
        await conversations.AddMessageAsync(userMessage, cancellationToken);
        conversation.UpdatedAt = DateTime.UtcNow;
        await conversations.SaveChangesAsync(cancellationToken);

        IChatClient? chat = null;
        string? setupError = null;
        try
        {
            chat = await chatClientFactory.CreateChatClientAsync(providerAvailability.Provider.Id, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Assistant turn setup failed.");
            setupError = ex.Message;
        }

        if (setupError is not null || chat is null)
        {
            yield return new AssistantTurnError(setupError ?? "Assistant turn setup failed.", Cancelled: false);
            yield break;
        }

        var history = await conversations.LoadMessagesAsync(conversation.Id, cancellationToken);
        var messages = new List<ChatMessage> { new(ChatRole.System, SystemPrompt) };
        messages.AddRange(history
            .Where(message => message.Role is AssistantMessageRole.User or AssistantMessageRole.Assistant)
            .Select(ToChatMessage));

        var activeAssistant = new AssistantMessage
        {
            ConversationId = conversation.Id,
            Order = nextOrder,
            Role = AssistantMessageRole.Assistant,
            Content = string.Empty,
            Status = AssistantMessageStatus.Pending,
        };
        await conversations.AddMessageAsync(activeAssistant, cancellationToken);
        await conversations.SaveChangesAsync(cancellationToken);

        var textBuilder = new StringBuilder();
        string? streamError = null;
        var cancelled = false;

        var enumerator = chat.GetStreamingResponseAsync(messages, cancellationToken: cancellationToken)
            .GetAsyncEnumerator(cancellationToken);
        try
        {
            while (true)
            {
                bool hasNext;
                try
                {
                    hasNext = await enumerator.MoveNextAsync();
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    cancelled = true;
                    break;
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Assistant streaming turn failed.");
                    streamError = ex.Message;
                    break;
                }

                if (!hasNext)
                    break;

                var deltas = new List<string>();
                try
                {
                    foreach (var content in enumerator.Current.Contents.OfType<TextContent>())
                    {
                        if (string.IsNullOrEmpty(content.Text))
                            continue;

                        textBuilder.Append(content.Text);
                        deltas.Add(content.Text);
                    }
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Assistant streaming update processing failed.");
                    streamError = ex.Message;
                    break;
                }

                foreach (var delta in deltas)
                    yield return new AssistantTextDelta(delta);
            }
        }
        finally
        {
            try
            {
                await enumerator.DisposeAsync();
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                cancelled = true;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Assistant streaming enumerator disposal failed.");
                streamError ??= ex.Message;
            }
        }

        if (cancelled)
        {
            activeAssistant.Content = textBuilder.ToString();
            activeAssistant.Status = AssistantMessageStatus.Cancelled;
            activeAssistant.ErrorMessage = "Cancelled by user.";
            await SafePersistAsync(activeAssistant);
            yield return new AssistantTurnError("Cancelled.", Cancelled: true);
            yield break;
        }

        if (streamError is not null)
        {
            activeAssistant.Content = textBuilder.ToString();
            activeAssistant.Status = AssistantMessageStatus.Failed;
            activeAssistant.ErrorMessage = streamError;
            await SafePersistAsync(activeAssistant);
            yield return new AssistantTurnError(streamError, Cancelled: false);
            yield break;
        }

        activeAssistant.Content = textBuilder.ToString();
        activeAssistant.Status = AssistantMessageStatus.Completed;
        await SafePersistAsync(activeAssistant);
        conversation.UpdatedAt = DateTime.UtcNow;
        await conversations.SaveChangesAsync(CancellationToken.None);
        yield return new AssistantMessageCompleted(activeAssistant.Id);
    }

    private static ChatMessage ToChatMessage(AssistantMessage message) => message.Role switch
    {
        AssistantMessageRole.User => new ChatMessage(ChatRole.User, message.Content),
        AssistantMessageRole.Assistant => new ChatMessage(ChatRole.Assistant, message.Content),
        _ => new ChatMessage(ChatRole.User, message.Content)
    };

    private async Task SafePersistAsync(AssistantMessage message)
    {
        try
        {
            conversations.UpdateMessage(message);
            await conversations.SaveChangesAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to persist assistant message {MessageId}", message.Id);
        }
    }
}
