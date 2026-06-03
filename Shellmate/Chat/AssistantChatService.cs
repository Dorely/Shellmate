using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using Shellmate.Llm;
using Shellmate.Models;
using Shellmate.Persistence.Repositories;
using Shellmate.Terminal;

namespace Shellmate.Chat;

public sealed class AssistantChatService(
    IAssistantConversationRepository conversations,
    ILlmProviderService providerService,
    IChatClientFactory chatClientFactory,
    ITerminalSessionService terminal,
    AssistantShellTools shellTools,
    IOptions<AgentOptions> options,
    ILogger<AssistantChatService> logger) : IAssistantChatService
{
    private const string InitialAssistantGreeting =
        "Connect a terminal session, then ask me to inspect it or run shell commands. I can only operate on the currently connected terminal.";

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

        IChatClient chat = null!;
        IList<AITool> aiTools = null!;
        string systemPrompt = string.Empty;
        string? setupError = null;
        try
        {
            chat = await chatClientFactory.CreateChatClientAsync(providerAvailability.Provider.Id, cancellationToken);
            aiTools = shellTools.Build(new AssistantShellToolContext(terminal, cancellationToken));
            systemPrompt = AssistantPromptBuilder.Build(terminal.GetSnapshot());
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Assistant turn setup failed.");
            await PersistFailedAssistantAsync(conversation.Id, nextOrder, ex.Message);
            setupError = ex.Message;
        }

        if (setupError is not null)
        {
            yield return new AssistantTurnError(setupError, Cancelled: false);
            yield break;
        }

        var chatOptions = new ChatOptions
        {
            Tools = aiTools,
            ToolMode = ChatToolMode.Auto,
        };

        var history = await conversations.LoadMessagesAsync(conversation.Id, cancellationToken);
        var messages = new List<ChatMessage> { new(ChatRole.System, systemPrompt) };
        messages.AddRange(history.Select(ToChatMessage));

        var maxIterations = Math.Max(1, options.Value.MaxToolIterations);
        for (var iteration = 0; iteration < maxIterations; iteration++)
        {
            var activeAssistant = new AssistantMessage
            {
                ConversationId = conversation.Id,
                Order = nextOrder++,
                Role = AssistantMessageRole.Assistant,
                Content = string.Empty,
                Status = AssistantMessageStatus.Pending,
            };
            await conversations.AddMessageAsync(activeAssistant, cancellationToken);
            await conversations.SaveChangesAsync(cancellationToken);

            var textBuilder = new StringBuilder();
            var pendingCalls = new List<PendingToolCall>();
            var toolCallTracker = new StreamingToolCallTracker();
            var streamFailed = false;
            string? streamError = null;
            var cancelled = false;

            var enumerator = chat.GetStreamingResponseAsync(messages, chatOptions, cancellationToken)
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
                        logger.LogError(ex, "Assistant streaming round failed.");
                        streamFailed = true;
                        streamError = ex.Message;
                        break;
                    }

                    if (!hasNext)
                        break;

                    var updatesToYield = new List<AssistantTurnUpdate>();
                    try
                    {
                        var contents = enumerator.Current?.Contents;
                        if (contents is null)
                            continue;

                        foreach (var content in contents)
                        {
                            if (content is TextContent textContent && !string.IsNullOrEmpty(textContent.Text))
                            {
                                textBuilder.Append(textContent.Text);
                                updatesToYield.Add(new AssistantTextDelta(textContent.Text));
                            }
                            else
                            {
                                foreach (var toolUpdate in toolCallTracker.Process(content, textBuilder.Length))
                                {
                                    switch (toolUpdate)
                                    {
                                        case StreamingToolCallStartedUpdate started:
                                            updatesToYield.Add(new AssistantToolCallStarted(
                                                started.CallId,
                                                started.ToolName,
                                                started.ArgumentsJson,
                                                started.ArgumentsComplete));
                                            break;
                                        case StreamingToolCallArgumentsDeltaUpdate delta:
                                            updatesToYield.Add(new AssistantToolCallArgumentsDelta(
                                                delta.CallId,
                                                delta.ArgumentsDelta,
                                                delta.ArgumentsComplete));
                                            break;
                                        case StreamingToolCallReadyUpdate ready:
                                            pendingCalls.Add(new PendingToolCall(
                                                ready.Content,
                                                ready.CallId,
                                                ready.ToolName,
                                                ready.ArgumentsJson,
                                                ready.TextOffset));
                                            break;
                                    }
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        logger.LogError(ex, "Assistant streaming update processing failed.");
                        streamFailed = true;
                        streamError = ex.Message;
                        break;
                    }

                    foreach (var updateToYield in updatesToYield)
                        yield return updateToYield;
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
                    streamFailed = true;
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

            if (streamFailed)
            {
                activeAssistant.Content = textBuilder.ToString();
                activeAssistant.Status = AssistantMessageStatus.Failed;
                activeAssistant.ErrorMessage = streamError;
                await SafePersistAsync(activeAssistant);
                yield return new AssistantTurnError(streamError ?? "Assistant streaming failed.", Cancelled: false);
                yield break;
            }

            if (pendingCalls.Count == 0)
            {
                activeAssistant.Content = textBuilder.ToString();
                activeAssistant.Status = AssistantMessageStatus.Completed;
                await SafePersistAsync(activeAssistant);
                conversation.UpdatedAt = DateTime.UtcNow;
                await conversations.SaveChangesAsync(CancellationToken.None);
                yield return new AssistantMessageCompleted(activeAssistant.Id);
                yield break;
            }

            var manifest = pendingCalls
                .Select(pendingCall => new PersistedToolCall(
                    pendingCall.CallId,
                    pendingCall.Name,
                    pendingCall.ArgumentsJson,
                    pendingCall.TextOffset))
                .ToList();
            activeAssistant.Content = textBuilder.ToString();
            activeAssistant.ToolCallsJson = JsonSerializer.Serialize(manifest);
            activeAssistant.Status = AssistantMessageStatus.Completed;
            await SafePersistAsync(activeAssistant);

            messages.Add(new ChatMessage(ChatRole.Assistant, BuildAssistantContents(textBuilder.ToString(), manifest)));

            var resultContents = new List<AIContent>();
            foreach (var pendingCall in pendingCalls)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    yield return new AssistantTurnError("Cancelled.", Cancelled: true);
                    yield break;
                }

                var stopwatch = Stopwatch.StartNew();
                string? toolResult = null;
                string? toolError = null;
                var toolCancelled = false;
                try
                {
                    var aiFunction = aiTools.OfType<AIFunction>().FirstOrDefault(function => function.Name == pendingCall.Name)
                        ?? throw new InvalidOperationException($"Unknown tool '{pendingCall.Name}'.");
                    var invokeResult = await aiFunction.InvokeAsync(
                        ToolCallArguments.Create(pendingCall.Content.Arguments, pendingCall.ArgumentsJson),
                        cancellationToken);
                    toolResult = invokeResult?.ToString() ?? string.Empty;
                    toolError = ExtractToolError(toolResult);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    toolCancelled = true;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Assistant tool '{Tool}' failed.", pendingCall.Name);
                    toolError = ex.Message;
                    toolResult = $"Error: {ex.Message}";
                }
                stopwatch.Stop();

                if (toolCancelled)
                {
                    yield return new AssistantTurnError("Cancelled.", Cancelled: true);
                    yield break;
                }

                var toolMessage = new AssistantMessage
                {
                    ConversationId = conversation.Id,
                    Order = nextOrder++,
                    Role = AssistantMessageRole.Tool,
                    Content = toolResult ?? string.Empty,
                    ToolCallId = pendingCall.CallId,
                    ToolName = pendingCall.Name,
                    Status = toolError is null ? AssistantMessageStatus.Completed : AssistantMessageStatus.Failed,
                    ErrorMessage = toolError,
                };
                await conversations.AddMessageAsync(toolMessage, CancellationToken.None);
                await conversations.SaveChangesAsync(CancellationToken.None);

                resultContents.Add(new FunctionResultContent(pendingCall.CallId, toolResult ?? string.Empty));
                yield return new AssistantToolCallCompleted(
                    pendingCall.CallId,
                    pendingCall.Name,
                    toolError is null ? toolResult : null,
                    toolError,
                    stopwatch.Elapsed.TotalMilliseconds);

                if (cancellationToken.IsCancellationRequested || IsCancelledToolResult(toolResult))
                {
                    yield return new AssistantTurnError("Cancelled.", Cancelled: true);
                    yield break;
                }
            }

            messages.Add(new ChatMessage(ChatRole.Tool, resultContents));

            if (iteration == maxIterations - 1)
            {
                yield return new AssistantTurnError(
                    $"Assistant tool-call loop hit cap of {maxIterations} iterations without producing a final response.",
                    Cancelled: false);
                yield break;
            }
        }
    }

    private static ChatMessage ToChatMessage(AssistantMessage message) => message.Role switch
    {
        AssistantMessageRole.System => new ChatMessage(ChatRole.System, message.Content),
        AssistantMessageRole.User => new ChatMessage(ChatRole.User, message.Content),
        AssistantMessageRole.Assistant => BuildAssistantReplay(message),
        AssistantMessageRole.Tool => new ChatMessage(ChatRole.Tool, [new FunctionResultContent(message.ToolCallId ?? string.Empty, message.Content)]),
        _ => new ChatMessage(ChatRole.User, message.Content)
    };

    private static ChatMessage BuildAssistantReplay(AssistantMessage message)
    {
        var calls = ReadPersistedToolCalls(message.ToolCallsJson);
        var contents = calls.Count == 0
            ? BuildTextOnlyAssistantContents(message.Content)
            : BuildAssistantContents(message.Content, calls);

        return new ChatMessage(ChatRole.Assistant, contents);
    }

    private static List<AIContent> BuildTextOnlyAssistantContents(string text)
    {
        var contents = new List<AIContent>();
        if (!string.IsNullOrEmpty(text))
            contents.Add(new TextContent(text));
        if (contents.Count == 0)
            contents.Add(new TextContent(string.Empty));
        return contents;
    }

    private static List<AIContent> BuildAssistantContents(string text, IReadOnlyList<PersistedToolCall> calls)
    {
        if (calls.Count == 0)
            return BuildTextOnlyAssistantContents(text);

        if (calls.Any(call => call.TextOffset is null))
        {
            var fallbackContents = BuildTextOnlyAssistantContents(text);
            foreach (var call in calls)
                fallbackContents.Add(ToFunctionCallContent(call));
            return fallbackContents;
        }

        var contents = new List<AIContent>();
        var cursor = 0;
        foreach (var item in calls
            .Select((call, index) => new { Call = call, Index = index })
            .OrderBy(item => item.Call.TextOffset!.Value)
            .ThenBy(item => item.Index))
        {
            var offset = Math.Clamp(item.Call.TextOffset!.Value, 0, text.Length);
            if (offset > cursor)
            {
                contents.Add(new TextContent(text[cursor..offset]));
                cursor = offset;
            }
            contents.Add(ToFunctionCallContent(item.Call));
        }

        if (cursor < text.Length)
            contents.Add(new TextContent(text[cursor..]));

        if (contents.Count == 0)
            contents.Add(new TextContent(string.Empty));
        return contents;
    }

    private static List<PersistedToolCall> ReadPersistedToolCalls(string toolCallsJson)
    {
        if (string.IsNullOrWhiteSpace(toolCallsJson) || toolCallsJson == "[]")
            return [];

        try
        {
            return JsonSerializer.Deserialize<List<PersistedToolCall>>(toolCallsJson) ?? [];
        }
        catch
        {
            return [];
        }
    }

    private static FunctionCallContent ToFunctionCallContent(PersistedToolCall call)
    {
        var arguments = ToolCallArguments.ParseObjectOrNull(call.ArgumentsJson);
        return new FunctionCallContent(call.CallId, call.Name, arguments);
    }

    private static string? ExtractToolError(string? toolResult)
    {
        if (string.IsNullOrWhiteSpace(toolResult))
            return null;

        if (toolResult.StartsWith("Error:", StringComparison.OrdinalIgnoreCase))
            return toolResult;

        if (!TryReadJsonObject(toolResult, out var root))
            return null;

        if (TryGetNonEmptyString(root, "error", out var error))
            return error;

        if (TryGetBoolean(root, "timedOut") == true)
            return "Command timed out.";

        if (TryGetBoolean(root, "cancelled") == true)
            return "Command was cancelled.";

        return null;
    }

    private static bool IsCancelledToolResult(string? toolResult)
    {
        if (string.IsNullOrWhiteSpace(toolResult) || !TryReadJsonObject(toolResult, out var root))
            return false;

        return TryGetBoolean(root, "cancelled") == true;
    }

    private static bool TryReadJsonObject(string json, out JsonElement root)
    {
        root = default;
        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                return false;

            root = document.RootElement.Clone();
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryGetNonEmptyString(JsonElement root, string propertyName, out string value)
    {
        value = string.Empty;
        if (!root.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.String)
            return false;

        value = property.GetString() ?? string.Empty;
        return !string.IsNullOrWhiteSpace(value);
    }

    private static bool? TryGetBoolean(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var property))
            return null;

        return property.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private async Task PersistFailedAssistantAsync(Guid conversationId, int order, string error)
    {
        try
        {
            var message = new AssistantMessage
            {
                ConversationId = conversationId,
                Order = order,
                Role = AssistantMessageRole.Assistant,
                Status = AssistantMessageStatus.Failed,
                ErrorMessage = error,
            };
            await conversations.AddMessageAsync(message, CancellationToken.None);
            await conversations.SaveChangesAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to persist assistant setup failure.");
        }
    }

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

    private sealed record PendingToolCall(
        FunctionCallContent Content,
        string CallId,
        string Name,
        string ArgumentsJson,
        int TextOffset);

    private sealed record PersistedToolCall(string CallId, string Name, string ArgumentsJson, int? TextOffset = null);
}
