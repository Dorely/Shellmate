using Shellmate.Models;
using Shellmate.Persistence.Repositories;
using Shellmate.Secrets;

namespace Shellmate.Llm;

public class LlmProviderService(
    ILlmProviderRepository providers,
    ICodexAuthService codexAuth,
    ISecretStore secrets) : ILlmProviderService
{
    public Task<List<LlmProvider>> GetAllAsync(CancellationToken cancellationToken = default) =>
        providers.GetAllAsync(cancellationToken);

    public Task<LlmProvider?> GetByIdAsync(int id, CancellationToken cancellationToken = default) =>
        providers.GetByIdAsync(id, cancellationToken);

    public Task<LlmProvider?> GetByNameAsync(string name, CancellationToken cancellationToken = default) =>
        providers.GetByNameAsync(name, cancellationToken);

    public Task<LlmProvider?> GetDefaultAsync(CancellationToken cancellationToken = default) =>
        providers.GetDefaultAsync(cancellationToken);

    public async Task<ChatProviderAvailability> GetDefaultChatProviderAvailabilityAsync(CancellationToken cancellationToken = default)
    {
        var all = await providers.GetAllAsync(cancellationToken);
        if (all.Count == 0)
            return ChatProviderAvailability.Unavailable("Configure and test a chat provider in Providers to enable chat.");

        var explicitDefault = all.FirstOrDefault(provider => provider.IsDefault);
        if (explicitDefault is not null && await IsChatProviderWorkingAsync(explicitDefault, cancellationToken))
            return ChatProviderAvailability.Available(explicitDefault);

        foreach (var provider in all.Where(provider => !provider.IsDefault))
        {
            if (await IsChatProviderWorkingAsync(provider, cancellationToken))
                return ChatProviderAvailability.Available(provider);
        }

        var candidate = explicitDefault ?? all.FirstOrDefault();
        var reason = candidate is null
            ? "Configure and test a chat provider in Providers to enable chat."
            : await GetUnavailableReasonAsync(candidate, cancellationToken);
        return ChatProviderAvailability.Unavailable(reason, candidate);
    }

    public async Task<bool> IsChatProviderWorkingAsync(int providerId, CancellationToken cancellationToken = default)
    {
        var provider = await providers.GetByIdAsync(providerId, cancellationToken);
        return provider is not null && await IsChatProviderWorkingAsync(provider, cancellationToken);
    }

    public async Task<bool> IsCodexConnectedAsync(CancellationToken cancellationToken = default)
    {
        var provider = await providers.GetByNameAsync(CodexProvider.Name, cancellationToken);
        if (provider is null || !CodexProvider.IsCodex(provider))
            return false;

        try
        {
            return !string.IsNullOrWhiteSpace(await codexAuth.GetValidTokenAsync(provider.Id, cancellationToken));
        }
        catch
        {
            return false;
        }
    }

    public async Task<LlmProvider> CreateAsync(LlmProvider provider, string? apiKey = null, CancellationToken cancellationToken = default)
    {
        provider.CreatedAt = DateTime.UtcNow;
        provider.UpdatedAt = DateTime.UtcNow;
        await providers.AddAsync(provider, cancellationToken);
        await providers.SaveChangesAsync(cancellationToken);

        if (provider.AuthType == AuthType.ApiKey && !string.IsNullOrWhiteSpace(apiKey))
            await secrets.SetAsync(SecretNames.ProviderApiKey(provider.Id), apiKey, cancellationToken);

        return provider;
    }

    public async Task<LlmProvider> UpdateAsync(LlmProvider provider, string? apiKey = null, CancellationToken cancellationToken = default)
    {
        if (provider.LastChatTestSucceeded && !provider.HasCurrentChatTestSnapshot)
            provider.ClearChatReadiness("Provider settings changed. Run Test successfully before using this provider for chat.");

        provider.UpdatedAt = DateTime.UtcNow;
        providers.Update(provider);
        await providers.SaveChangesAsync(cancellationToken);

        if (provider.AuthType == AuthType.ApiKey && !string.IsNullOrWhiteSpace(apiKey))
            await secrets.SetAsync(SecretNames.ProviderApiKey(provider.Id), apiKey, cancellationToken);

        if (provider.AuthType != AuthType.ApiKey)
            await secrets.DeleteAsync(SecretNames.ProviderApiKey(provider.Id), cancellationToken);

        return provider;
    }

    public async Task DeleteAsync(int id, CancellationToken cancellationToken = default)
    {
        var provider = await providers.GetByIdAsync(id, cancellationToken);
        if (provider is null)
            return;

        providers.Remove(provider);
        await providers.SaveChangesAsync(cancellationToken);
        await secrets.DeleteAsync(SecretNames.ProviderApiKey(id), cancellationToken);
        await codexAuth.RevokeTokenAsync(id, cancellationToken);
    }

    public async Task SetDefaultAsync(int id, CancellationToken cancellationToken = default)
    {
        if (!await IsChatProviderWorkingAsync(id, cancellationToken))
            throw new InvalidOperationException("Run Test successfully before setting this provider as the default chat provider.");

        await providers.SetDefaultAsync(id, cancellationToken);
        await providers.SaveChangesAsync(cancellationToken);
    }

    public async Task<LlmProvider> MarkChatTestSucceededAsync(LlmProvider provider, CancellationToken cancellationToken = default)
    {
        var target = await ResolvePersistedProviderForTestAsync(provider, cancellationToken);
        target.MarkChatTestSucceeded(DateTime.UtcNow);
        if (target.Id == 0)
            return target;

        target.UpdatedAt = DateTime.UtcNow;
        providers.Update(target);
        await providers.SaveChangesAsync(cancellationToken);
        return target;
    }

    public async Task<LlmProvider> MarkChatTestFailedAsync(LlmProvider provider, string error, CancellationToken cancellationToken = default)
    {
        var target = await ResolvePersistedProviderForTestAsync(provider, cancellationToken);
        target.MarkChatTestFailed(error, DateTime.UtcNow);
        if (target.Id == 0)
            return target;

        target.UpdatedAt = DateTime.UtcNow;
        providers.Update(target);
        await providers.SaveChangesAsync(cancellationToken);
        return target;
    }

    public async Task<string?> GetEffectiveApiKeyAsync(int providerId, CancellationToken cancellationToken = default)
    {
        var provider = await providers.GetByIdAsync(providerId, cancellationToken);
        if (provider is null)
            return null;

        var credentialProviderId = provider.EffectiveCredentialProviderId;
        var credentialProvider = credentialProviderId == providerId
            ? provider
            : await providers.GetByIdAsync(credentialProviderId, cancellationToken);

        if (credentialProvider is null)
            return null;

        return credentialProvider.AuthType switch
        {
            AuthType.ApiKey => await secrets.GetAsync(SecretNames.ProviderApiKey(credentialProviderId), cancellationToken),
            AuthType.OAuth => await codexAuth.GetValidTokenAsync(credentialProviderId, cancellationToken),
            _ => null
        };
    }

    private async Task<bool> IsChatProviderWorkingAsync(LlmProvider provider, CancellationToken cancellationToken)
    {
        if (!provider.HasCurrentChatTestSnapshot)
            return false;

        var credentials = await GetCredentialStatusAsync(provider, cancellationToken);
        return credentials.Available;
    }

    private async Task<string> GetUnavailableReasonAsync(LlmProvider provider, CancellationToken cancellationToken)
    {
        if (!provider.LastChatTestSucceeded)
        {
            return string.IsNullOrWhiteSpace(provider.LastChatTestError)
                ? "Run Test successfully in Providers to enable chat."
                : $"The last provider test failed: {provider.LastChatTestError}";
        }

        if (!provider.HasCurrentChatTestSnapshot)
            return "Provider settings changed. Run Test successfully in Providers to enable chat.";

        var credentials = await GetCredentialStatusAsync(provider, cancellationToken);
        return credentials.Available ? string.Empty : credentials.Message;
    }

    private async Task<CredentialStatus> GetCredentialStatusAsync(LlmProvider provider, CancellationToken cancellationToken)
    {
        var credentialProviderId = provider.EffectiveCredentialProviderId;
        var credentialProvider = credentialProviderId == provider.Id
            ? provider
            : await providers.GetByIdAsync(credentialProviderId, cancellationToken);

        if (credentialProvider is null)
            return new CredentialStatus(false, "The credential source for this provider no longer exists.");

        if (credentialProvider.AuthType == AuthType.None)
            return new CredentialStatus(true, string.Empty);

        if (credentialProvider.AuthType == AuthType.ApiKey)
        {
            return !string.IsNullOrWhiteSpace(await secrets.GetAsync(SecretNames.ProviderApiKey(credentialProviderId), cancellationToken))
                ? new CredentialStatus(true, string.Empty)
                : new CredentialStatus(false, "Add an API key and run Test successfully in Providers.");
        }

        if (credentialProvider.AuthType == AuthType.OAuth)
        {
            try
            {
                return !string.IsNullOrWhiteSpace(await codexAuth.GetValidTokenAsync(credentialProviderId, cancellationToken))
                    ? new CredentialStatus(true, string.Empty)
                    : new CredentialStatus(false, "Connect OpenAI and run Test successfully in Providers.");
            }
            catch (Exception ex)
            {
                return new CredentialStatus(false, $"Reconnect OpenAI and run Test successfully in Providers. {ex.Message}");
            }
        }

        return new CredentialStatus(false, "Provider credentials are not configured.");
    }

    private async Task<LlmProvider> ResolvePersistedProviderForTestAsync(LlmProvider provider, CancellationToken cancellationToken)
    {
        if (provider.Id == 0)
            return provider;

        var target = await providers.GetByIdAsync(provider.Id, cancellationToken)
            ?? throw new InvalidOperationException($"Provider {provider.Id} not found.");

        CopyEditableValues(provider, target);
        return target;
    }

    private static void CopyEditableValues(LlmProvider source, LlmProvider target)
    {
        target.Name = source.Name;
        target.DisplayName = source.DisplayName;
        target.EndpointUrl = source.EndpointUrl;
        target.ModelId = source.ModelId;
        target.AuthType = source.AuthType;
        target.IsDefault = source.IsDefault;
        target.CredentialSourceId = source.CredentialSourceId;
    }

    private sealed record CredentialStatus(bool Available, string Message);
}
