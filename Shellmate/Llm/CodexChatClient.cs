using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace Shellmate.Llm;

public sealed class CodexChatClient : IChatClient
{
    private const int MaxBufferedResponseAttempts = 2;

    private readonly HttpClient _httpClient;
    private readonly string _accessToken;
    private readonly string _model;
    private readonly string _accountId;
    private readonly ILogger<CodexChatClient> _logger;

    public CodexChatClient(HttpClient httpClient, string accessToken, string model, ILogger<CodexChatClient> logger)
    {
        _httpClient = httpClient;
        _accessToken = accessToken;
        _model = string.IsNullOrWhiteSpace(model) ? CodexProvider.DefaultChatModel : model;
        _accountId = CodexProvider.ExtractAccountId(accessToken);
        _logger = logger;
    }

    public ChatClientMetadata Metadata => new("CodexResponsesAPI", new Uri("https://chatgpt.com"));

    public async Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> chatMessages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var bufferedMessages = chatMessages as IReadOnlyList<ChatMessage> ?? chatMessages.ToList();

        for (var attempt = 1; attempt <= MaxBufferedResponseAttempts; attempt++)
        {
            var fullText = new StringBuilder();
            var functionCalls = new List<FunctionCallContent>();

            try
            {
                await foreach (var update in GetStreamingResponseAsync(bufferedMessages, options, cancellationToken))
                {
                    foreach (var content in update.Contents)
                    {
                        if (content is TextContent textContent && textContent.Text is { Length: > 0 })
                            fullText.Append(textContent.Text);
                        else if (content is FunctionCallContent functionCall)
                            functionCalls.Add(functionCall);
                    }
                }
            }
            catch (HttpIOException ex) when (IsResponseEnded(ex)
                && attempt < MaxBufferedResponseAttempts
                && fullText.Length == 0
                && functionCalls.Count == 0
                && !cancellationToken.IsCancellationRequested)
            {
                _logger.LogWarning(
                    ex,
                    "Codex streaming response ended before assistant content on attempt {Attempt}; retrying once.",
                    attempt);
                continue;
            }

            return CreateResponse(fullText, functionCalls);
        }

        throw new HttpRequestException("Codex streaming response ended prematurely before assistant content after retry.");
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> chatMessages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var bufferedMessages = chatMessages as IReadOnlyCollection<ChatMessage> ?? chatMessages.ToList();
        var body = BuildRequestBody(bufferedMessages, options);
        var json = JsonSerializer.Serialize(body);
        var toolCount = options?.Tools?.Count ?? 0;

        using var request = new HttpRequestMessage(HttpMethod.Post, CodexProvider.ResponsesEndpoint);
        request.Content = new StringContent(json, Encoding.UTF8);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
        request.Headers.TryAddWithoutValidation("chatgpt-account-id", _accountId);
        request.Headers.TryAddWithoutValidation("OpenAI-Beta", "responses=experimental");
        request.Headers.TryAddWithoutValidation("originator", "pi");
        request.Headers.TryAddWithoutValidation("User-Agent", "Shellmate");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));

        _logger.LogDebug(
            "Codex request: POST {Endpoint}, account={AccountId}, model={Model}, messages={MessageCount}, tools={ToolCount}, bodyChars={BodyChars}",
            CodexProvider.ResponsesEndpoint,
            _accountId,
            _model,
            bufferedMessages.Count,
            toolCount,
            json.Length);

        using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogError("Codex API error {StatusCode}: {Body}", (int)response.StatusCode, errorBody);
            throw new HttpRequestException($"Codex API returned {(int)response.StatusCode}: {errorBody}");
        }

        using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);

        string? pendingCallId = null;
        string? pendingFuncName = null;
        var pendingArgs = new StringBuilder();
        var eventCount = 0;
        var outputTextChars = 0;
        var functionCallCount = 0;
        string? lastEventType = null;
        var lastEventData = string.Empty;

        while (true)
        {
            string? line;
            try
            {
                line = await reader.ReadLineAsync(cancellationToken);
            }
            catch (HttpIOException ex) when (IsResponseEnded(ex) && !cancellationToken.IsCancellationRequested)
            {
                _logger.LogWarning(
                    ex,
                    "Codex streaming response ended prematurely after {EventCount} SSE events; lastEvent={LastEventType}; textChars={TextChars}; functionCalls={FunctionCallCount}; model={Model}; bodyChars={BodyChars}",
                    eventCount,
                    lastEventType ?? "(none)",
                    outputTextChars,
                    functionCallCount,
                    _model,
                    json.Length);
                throw;
            }

            if (line is null)
                break;

            if (!line.StartsWith("data: ", StringComparison.Ordinal))
                continue;

            var data = line["data: ".Length..];
            if (data == "[DONE]")
                break;
            lastEventData = data;

            JsonElement evt;
            try
            {
                evt = JsonSerializer.Deserialize<JsonElement>(data);
            }
            catch
            {
                continue;
            }

            var type = evt.TryGetProperty("type", out var typeProp) ? typeProp.GetString() : null;
            eventCount++;
            lastEventType = type ?? "(missing)";

            switch (type)
            {
                case "response.output_text.delta":
                    if (evt.TryGetProperty("delta", out var delta))
                    {
                        var text = delta.GetString();
                        if (!string.IsNullOrEmpty(text))
                        {
                            outputTextChars += text.Length;
                            yield return new ChatResponseUpdate
                            {
                                Role = ChatRole.Assistant,
                                Contents = [new TextContent(text)]
                            };
                        }
                    }
                    break;

                case "response.output_item.added":
                    if (evt.TryGetProperty("item", out var item) &&
                        item.TryGetProperty("type", out var itemType) &&
                        itemType.GetString() == "function_call")
                    {
                        pendingCallId = item.TryGetProperty("call_id", out var callId) ? callId.GetString() : null;
                        pendingFuncName = item.TryGetProperty("name", out var name) ? name.GetString() : null;
                        pendingArgs.Clear();
                        if (pendingCallId is not null && pendingFuncName is not null)
                        {
                            yield return new ChatResponseUpdate
                            {
                                Role = ChatRole.Assistant,
                                Contents = [new FunctionCallStartedContent(pendingCallId, pendingFuncName)]
                            };
                        }
                    }
                    break;

                case "response.function_call_arguments.delta":
                    if (evt.TryGetProperty("delta", out var argDelta))
                    {
                        var argumentsDelta = argDelta.GetString();
                        if (!string.IsNullOrEmpty(argumentsDelta))
                        {
                            pendingArgs.Append(argumentsDelta);
                            if (pendingCallId is not null && pendingFuncName is not null)
                            {
                                yield return new ChatResponseUpdate
                                {
                                    Role = ChatRole.Assistant,
                                    Contents = [new FunctionCallArgumentsDeltaContent(pendingCallId, pendingFuncName, argumentsDelta)]
                                };
                            }
                        }
                    }
                    break;

                case "response.function_call_arguments.done":
                    if (pendingCallId is not null && pendingFuncName is not null)
                    {
                        functionCallCount++;
                        var argsJson = evt.TryGetProperty("arguments", out var doneArguments)
                            ? doneArguments.GetString() ?? pendingArgs.ToString()
                            : pendingArgs.ToString();
                        IDictionary<string, object?>? argsDict = null;
                        if (!string.IsNullOrEmpty(argsJson) && argsJson != "{}")
                        {
                            try
                            {
                                argsDict = JsonSerializer.Deserialize<Dictionary<string, object?>>(argsJson);
                            }
                            catch
                            {
                                argsDict = new Dictionary<string, object?> { ["raw"] = argsJson };
                            }
                        }

                        yield return new ChatResponseUpdate
                        {
                            Role = ChatRole.Assistant,
                            Contents = [new FunctionCallContent(pendingCallId, pendingFuncName, argsDict)]
                        };

                        pendingCallId = null;
                        pendingFuncName = null;
                        pendingArgs.Clear();
                    }
                    break;

                case "response.completed" or "response.done":
                    _logger.LogDebug(
                        "Codex streaming response completed after {EventCount} SSE events. TextChars={TextChars}, FunctionCalls={FunctionCallCount}",
                        eventCount,
                        outputTextChars,
                        functionCallCount);
                    yield break;

                case "response.created":
                case "response.in_progress":
                case "response.content_part.added":
                case "response.content_part.done":
                case "response.output_item.done":
                case "response.output_text.done":
                case "response.reasoning_summary_part.added":
                case "response.reasoning_summary_part.done":
                case "response.reasoning_summary_text.delta":
                case "response.reasoning_summary_text.done":
                case "keepalive":
                    break;

                case "response.failed":
                    _logger.LogError(
                        "Codex streaming response failed after {EventCount} SSE events; lastEvent={LastEventType}; textChars={TextChars}; functionCalls={FunctionCallCount}; model={Model}; bodyChars={BodyChars}; event={EventData}",
                        eventCount,
                        lastEventType ?? "(none)",
                        outputTextChars,
                        functionCallCount,
                        _model,
                        json.Length,
                        Truncate(lastEventData, 2000));
                    throw new InvalidOperationException(ExtractCodexErrorMessage(evt, "Codex API response failed."));

                case "error":
                    _logger.LogError(
                        "Codex streaming error after {EventCount} SSE events; lastEvent={LastEventType}; textChars={TextChars}; functionCalls={FunctionCallCount}; model={Model}; bodyChars={BodyChars}; event={EventData}",
                        eventCount,
                        lastEventType ?? "(none)",
                        outputTextChars,
                        functionCallCount,
                        _model,
                        json.Length,
                        Truncate(lastEventData, 2000));
                    throw new InvalidOperationException($"Codex error: {ExtractCodexErrorMessage(evt, "Unknown error")}");

                default:
                    _logger.LogWarning("Unhandled Codex SSE event type: {EventType}", type);
                    break;
            }
        }

        _logger.LogDebug(
            "Codex streaming response ended after {EventCount} SSE events without an explicit completion event. TextChars={TextChars}, FunctionCalls={FunctionCallCount}",
            eventCount,
            outputTextChars,
            functionCallCount);
    }

    public object? GetService(Type serviceType, object? serviceKey = null) => null;

    public void Dispose()
    {
    }

    private Dictionary<string, object> BuildRequestBody(IEnumerable<ChatMessage> chatMessages, ChatOptions? options)
    {
        var instructions = new List<string>();
        var inputItems = new List<object>();

        foreach (var message in chatMessages)
        {
            if (message.Role == ChatRole.System)
            {
                instructions.Add(message.Text ?? string.Empty);
                continue;
            }

            var functionCalls = message.Contents.OfType<FunctionCallContent>().ToList();
            if (functionCalls.Count > 0)
            {
                var textParts = message.Contents.OfType<TextContent>()
                    .Where(textContent => textContent.Text is { Length: > 0 })
                    .ToList();
                if (textParts.Count > 0)
                {
                    var combinedText = string.Join("", textParts.Select(textContent => textContent.Text));
                    inputItems.Add(new Dictionary<string, object>
                    {
                        ["role"] = "assistant",
                        ["content"] = new[] { new { type = "output_text", text = combinedText } }
                    });
                }

                foreach (var functionCall in functionCalls)
                {
                    inputItems.Add(new Dictionary<string, object>
                    {
                        ["type"] = "function_call",
                        ["call_id"] = functionCall.CallId ?? string.Empty,
                        ["name"] = functionCall.Name,
                        ["arguments"] = functionCall.Arguments is not null
                            ? JsonSerializer.Serialize(functionCall.Arguments)
                            : "{}"
                    });
                }
                continue;
            }

            var functionResults = message.Contents.OfType<FunctionResultContent>().ToList();
            if (functionResults.Count > 0)
            {
                foreach (var functionResult in functionResults)
                {
                    inputItems.Add(new Dictionary<string, object>
                    {
                        ["type"] = "function_call_output",
                        ["call_id"] = functionResult.CallId ?? string.Empty,
                        ["output"] = functionResult.Result?.ToString() ?? string.Empty
                    });
                }
                continue;
            }

            var text = message.Text ?? string.Empty;
            if (message.Role == ChatRole.User)
            {
                inputItems.Add(new Dictionary<string, object>
                {
                    ["role"] = "user",
                    ["content"] = new[] { new { type = "input_text", text } }
                });
            }
            else if (message.Role == ChatRole.Assistant)
            {
                inputItems.Add(new Dictionary<string, object>
                {
                    ["role"] = "assistant",
                    ["content"] = new[] { new { type = "output_text", text } }
                });
            }
        }

        var body = new Dictionary<string, object>
        {
            ["model"] = _model,
            ["stream"] = true,
            ["store"] = false,
            ["input"] = inputItems,
            ["instructions"] = instructions.Count > 0
                ? string.Join("\n\n", instructions)
                : "You are a helpful assistant."
        };

        if (options?.Tools is { Count: > 0 } tools)
        {
            var codexTools = new List<object>();
            foreach (var tool in tools)
            {
                if (tool is not AIFunction function)
                    continue;

                var toolDef = new Dictionary<string, object>
                {
                    ["type"] = "function",
                    ["name"] = function.Name,
                    ["description"] = function.Description ?? string.Empty,
                    ["strict"] = true,
                };

                var schema = function.JsonSchema;
                toolDef["parameters"] = schema.ValueKind != JsonValueKind.Undefined
                    ? PrepareStrictSchema(schema)
                    : new Dictionary<string, object>
                    {
                        ["type"] = "object",
                        ["properties"] = new Dictionary<string, object>(),
                        ["required"] = Array.Empty<string>(),
                        ["additionalProperties"] = false
                    };

                codexTools.Add(toolDef);
            }

            if (codexTools.Count > 0)
            {
                body["tools"] = codexTools;
                body["tool_choice"] = "auto";
            }
        }

        return body;
    }

    private static ChatResponse CreateResponse(StringBuilder fullText, IReadOnlyList<FunctionCallContent> functionCalls)
    {
        var contents = new List<AIContent>();
        if (fullText.Length > 0)
            contents.Add(new TextContent(fullText.ToString()));
        contents.AddRange(functionCalls);

        return new ChatResponse([new ChatMessage(ChatRole.Assistant, contents)]);
    }

    private static bool IsResponseEnded(HttpIOException exception) =>
        exception.HttpRequestError == HttpRequestError.ResponseEnded;

    private static JsonElement PrepareStrictSchema(JsonElement schema)
    {
        var prepared = EnforceStrictSchema(schema);
        using var document = JsonDocument.Parse(prepared.GetRawText());
        return document.RootElement.Clone();
    }

    private static JsonElement EnforceStrictSchema(JsonElement element, bool isPropertiesContainer = false)
    {
        if (element.ValueKind == JsonValueKind.Array)
        {
            var items = new List<JsonElement>();
            foreach (var item in element.EnumerateArray())
                items.Add(EnforceStrictSchema(item));
            return JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(items));
        }

        if (element.ValueKind != JsonValueKind.Object)
            return element;

        if (isPropertiesContainer)
        {
            var properties = new Dictionary<string, object>();
            foreach (var property in element.EnumerateObject())
            {
                properties[property.Name] = property.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array
                    ? EnforceStrictSchema(property.Value)
                    : property.Value;
            }

            return JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(properties));
        }

        var dict = new Dictionary<string, object>();
        var isObject = false;
        var hasProperties = false;
        var hasAdditionalProperties = false;
        var propertyNames = new List<string>();

        foreach (var property in element.EnumerateObject())
        {
            if (property.Name is "$defs" or "title")
                continue;

            if (property.Name == "type" &&
                ((property.Value.ValueKind == JsonValueKind.String && property.Value.GetString() == "object") ||
                 (property.Value.ValueKind == JsonValueKind.Array && property.Value.EnumerateArray().Any(e => e.GetString() == "object"))))
            {
                isObject = true;
            }

            if (property.Name == "properties")
            {
                hasProperties = true;
                if (property.Value.ValueKind == JsonValueKind.Object)
                {
                    foreach (var nestedProperty in property.Value.EnumerateObject())
                        propertyNames.Add(nestedProperty.Name);
                }
            }

            if (property.Name == "additionalProperties")
                hasAdditionalProperties = true;

            dict[property.Name] = property.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array
                ? EnforceStrictSchema(property.Value, isPropertiesContainer: property.Name == "properties")
                : property.Value;
        }

        if ((isObject || hasProperties) && !hasAdditionalProperties)
            dict["additionalProperties"] = false;

        if (isObject || hasProperties)
            dict["required"] = propertyNames;

        return JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(dict));
    }

    private static string ExtractCodexErrorMessage(JsonElement evt, string fallback)
    {
        foreach (var path in new[]
        {
            new[] { "message" },
            new[] { "error", "message" },
            new[] { "response", "error", "message" },
            new[] { "error", "code" },
            new[] { "response", "error", "code" },
        })
        {
            if (TryGetStringByPath(evt, path, out var value))
                return value;
        }

        return fallback;
    }

    private static bool TryGetStringByPath(JsonElement element, IReadOnlyList<string> path, out string value)
    {
        value = string.Empty;
        var current = element;
        foreach (var segment in path)
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
                return false;
        }

        value = current.ValueKind == JsonValueKind.String ? current.GetString() ?? string.Empty : current.GetRawText();
        return !string.IsNullOrWhiteSpace(value);
    }

    private static string Truncate(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value))
            return string.Empty;

        var trimmed = value.Trim();
        return trimmed.Length <= max ? trimmed : trimmed[..max] + "...";
    }
}
