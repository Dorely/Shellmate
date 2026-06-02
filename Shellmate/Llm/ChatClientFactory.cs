using System.ClientModel;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using OpenAI;
using Shellmate.Models;

namespace Shellmate.Llm;

public class ChatClientFactory(
    ILlmProviderService providerService,
    IHttpClientFactory httpClientFactory,
    IOptions<AgentOptions> agentOptions,
    ILoggerFactory loggerFactory) : IChatClientFactory
{
    public async Task<IChatClient> CreateChatClientAsync(int providerId, CancellationToken cancellationToken = default)
    {
        var provider = await providerService.GetByIdAsync(providerId, cancellationToken)
            ?? throw new InvalidOperationException($"Provider {providerId} not found.");

        var (apiKey, effectiveAuthType) = await ResolveConnectionAsync(provider, null, cancellationToken);
        return CreateChatClient(provider, apiKey, effectiveAuthType);
    }

    public async Task TestModelAsync(int providerId, CancellationToken cancellationToken = default)
    {
        var chatClient = await CreateChatClientAsync(providerId, cancellationToken);
        await TestChatClientAsync(chatClient, cancellationToken);
    }

    public async Task TestModelAsync(LlmProvider provider, string? apiKeyOverride = null, CancellationToken cancellationToken = default)
    {
        var (apiKey, effectiveAuthType) = await ResolveConnectionAsync(provider, apiKeyOverride, cancellationToken);
        var chatClient = CreateChatClient(provider, apiKey, effectiveAuthType);
        await TestChatClientAsync(chatClient, cancellationToken);
    }

    private async Task<(string? ApiKey, AuthType EffectiveAuthType)> ResolveConnectionAsync(
        LlmProvider provider,
        string? apiKeyOverride,
        CancellationToken cancellationToken)
    {
        if (provider.CredentialSourceId is int sourceId)
        {
            var credentialSource = await providerService.GetByIdAsync(sourceId, cancellationToken)
                ?? throw new InvalidOperationException($"Credential source provider {sourceId} not found.");

            var sourceApiKey = await providerService.GetEffectiveApiKeyAsync(sourceId, cancellationToken);
            return (sourceApiKey, credentialSource.AuthType);
        }

        if (!string.IsNullOrWhiteSpace(apiKeyOverride))
            return (apiKeyOverride, provider.AuthType);

        if (provider.Id != 0)
            return (await providerService.GetEffectiveApiKeyAsync(provider.Id, cancellationToken), provider.AuthType);

        return (null, provider.AuthType);
    }

    private IChatClient CreateChatClient(LlmProvider provider, string? apiKey, AuthType effectiveAuthType)
    {
        if (effectiveAuthType == AuthType.OAuth && apiKey is not null && IsJwt(apiKey))
        {
            var httpClient = httpClientFactory.CreateClient();
            var timeoutSeconds = Math.Clamp(agentOptions.Value.CodexRequestTimeoutSeconds, 1, 3600);
            httpClient.Timeout = TimeSpan.FromSeconds(timeoutSeconds);
            return new CodexChatClient(httpClient, apiKey, provider.ModelId, loggerFactory.CreateLogger<CodexChatClient>());
        }

        if (effectiveAuthType != AuthType.None && apiKey is null)
            throw new InvalidOperationException($"No valid API key or token for provider '{provider.Name}'.");

        var options = new OpenAIClientOptions
        {
            Endpoint = new Uri(provider.EndpointUrl),
            NetworkTimeout = TimeSpan.FromMinutes(10)
        };

        var credential = new ApiKeyCredential(apiKey ?? "local-provider");
        var client = new OpenAIClient(credential, options);
        return client.GetChatClient(provider.ModelId).AsIChatClient();
    }

    private static async Task TestChatClientAsync(IChatClient chatClient, CancellationToken cancellationToken)
    {
        var options = new ChatOptions { MaxOutputTokens = 1 };
        await chatClient.GetResponseAsync("hi", options, cancellationToken);
    }

    private static bool IsJwt(string token) =>
        !token.StartsWith("sk-", StringComparison.Ordinal) && token.Split('.').Length == 3;
}
