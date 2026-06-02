using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace Shellmate.Llm;

public sealed class CodexChatClient : IChatClient
{
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
        var fullText = new StringBuilder();
        await foreach (var update in GetStreamingResponseAsync(chatMessages, options, cancellationToken))
        {
            foreach (var content in update.Contents.OfType<TextContent>())
            {
                if (!string.IsNullOrEmpty(content.Text))
                    fullText.Append(content.Text);
            }
        }

        return new ChatResponse([new ChatMessage(ChatRole.Assistant, fullText.ToString())]);
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> chatMessages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (options?.Tools is { Count: > 0 })
            throw new NotSupportedException("Shellmate's first Codex chat slice does not enable tool calls yet.");

        var bufferedMessages = chatMessages as IReadOnlyCollection<ChatMessage> ?? chatMessages.ToList();
        var body = BuildRequestBody(bufferedMessages);
        var json = JsonSerializer.Serialize(body);

        using var request = new HttpRequestMessage(HttpMethod.Post, CodexProvider.ResponsesEndpoint);
        request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
        request.Headers.TryAddWithoutValidation("chatgpt-account-id", _accountId);
        request.Headers.TryAddWithoutValidation("OpenAI-Beta", "responses=experimental");
        request.Headers.TryAddWithoutValidation("originator", "pi");
        request.Headers.TryAddWithoutValidation("User-Agent", "Shellmate");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));

        using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogError("Codex API error {StatusCode}: {Body}", (int)response.StatusCode, errorBody);
            throw new HttpRequestException($"Codex API returned {(int)response.StatusCode}: {errorBody}");
        }

        using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);

        while (true)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (line is null)
                break;

            if (!line.StartsWith("data: ", StringComparison.Ordinal))
                continue;

            var data = line["data: ".Length..];
            if (data == "[DONE]")
                break;

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
            switch (type)
            {
                case "response.output_text.delta":
                    if (evt.TryGetProperty("delta", out var delta))
                    {
                        var text = delta.GetString();
                        if (!string.IsNullOrEmpty(text))
                        {
                            yield return new ChatResponseUpdate
                            {
                                Role = ChatRole.Assistant,
                                Contents = [new TextContent(text)]
                            };
                        }
                    }
                    break;

                case "response.completed" or "response.done":
                    yield break;

                case "response.failed" or "error":
                    throw new InvalidOperationException(ExtractCodexErrorMessage(evt, "Codex response failed."));
            }
        }
    }

    public object? GetService(Type serviceType, object? serviceKey = null) => null;

    public void Dispose()
    {
    }

    private Dictionary<string, object> BuildRequestBody(IEnumerable<ChatMessage> chatMessages)
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

        return new Dictionary<string, object>
        {
            ["model"] = _model,
            ["stream"] = true,
            ["store"] = false,
            ["input"] = inputItems,
            ["instructions"] = instructions.Count > 0
                ? string.Join("\n\n", instructions)
                : "You are a helpful assistant."
        };
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
}
