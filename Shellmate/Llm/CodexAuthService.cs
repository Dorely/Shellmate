using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Shellmate.Models;
using Shellmate.Persistence.Repositories;
using Shellmate.Secrets;

namespace Shellmate.Llm;

public class CodexAuthService(
    IOAuthTokenRepository tokens,
    ISecretStore secrets,
    IHttpClientFactory httpClientFactory,
    IConfiguration configuration) : ICodexAuthService
{
    private const string AuthEndpoint = "https://auth.openai.com/oauth/authorize";
    private const string TokenEndpoint = "https://auth.openai.com/oauth/token";
    private const string ClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
    private const string Scope = "openid profile email offline_access";
    private readonly string _redirectUri = configuration["Auth:Codex:RedirectUri"]
        ?? throw new InvalidOperationException("Auth:Codex:RedirectUri must be configured for Codex OAuth.");

    private static readonly ConcurrentDictionary<string, PkceState> PendingFlows = new();

    private sealed record PkceState(int ProviderId, string CodeVerifier, DateTime CreatedAt);

    public (string AuthorizationUrl, string State) StartPkceFlow(int providerId)
    {
        var codeVerifier = GenerateCodeVerifier();
        var codeChallenge = GenerateCodeChallenge(codeVerifier);
        var state = Guid.NewGuid().ToString("N");

        PendingFlows[state] = new PkceState(providerId, codeVerifier, DateTime.UtcNow);

        var url = $"{AuthEndpoint}?" +
            $"response_type=code&" +
            $"client_id={Uri.EscapeDataString(ClientId)}&" +
            $"redirect_uri={Uri.EscapeDataString(_redirectUri)}&" +
            $"scope={Uri.EscapeDataString(Scope)}&" +
            $"state={Uri.EscapeDataString(state)}&" +
            $"code_challenge={Uri.EscapeDataString(codeChallenge)}&" +
            $"code_challenge_method=S256&" +
            $"id_token_add_organizations=true&" +
            $"codex_cli_simplified_flow=true&" +
            $"originator=pi";

        return (url, state);
    }

    public async Task<int> HandleCallbackAsync(string code, string state, CancellationToken cancellationToken = default)
    {
        if (!PendingFlows.TryRemove(state, out var pkce))
            throw new InvalidOperationException("Invalid or expired OAuth state.");

        if (DateTime.UtcNow - pkce.CreatedAt > TimeSpan.FromMinutes(10))
            throw new InvalidOperationException("OAuth flow has expired.");

        var client = httpClientFactory.CreateClient();

        var tokenRequest = new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["client_id"] = ClientId,
            ["code"] = code,
            ["redirect_uri"] = _redirectUri,
            ["code_verifier"] = pkce.CodeVerifier
        };

        var response = await client.PostAsync(TokenEndpoint, new FormUrlEncodedContent(tokenRequest), cancellationToken);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken);

        var accessToken = json.GetProperty("access_token").GetString()!;
        var expiresIn = json.GetProperty("expires_in").GetInt32();
        var refreshToken = json.TryGetProperty("refresh_token", out var rt) ? rt.GetString() : null;
        var scope = json.TryGetProperty("scope", out var sc) ? sc.GetString() : null;

        var accessSecretName = SecretNames.OAuthAccessToken(pkce.ProviderId);
        var refreshSecretName = SecretNames.OAuthRefreshToken(pkce.ProviderId);
        await secrets.SetAsync(accessSecretName, accessToken, cancellationToken);
        if (!string.IsNullOrWhiteSpace(refreshToken))
            await secrets.SetAsync(refreshSecretName, refreshToken, cancellationToken);
        else
            await secrets.DeleteAsync(refreshSecretName, cancellationToken);

        await tokens.ReplaceForProviderAsync(pkce.ProviderId, new OAuthToken
        {
            ProviderId = pkce.ProviderId,
            AccessTokenSecretName = accessSecretName,
            RefreshTokenSecretName = string.IsNullOrWhiteSpace(refreshToken) ? null : refreshSecretName,
            ExpiresAt = DateTime.UtcNow.AddSeconds(expiresIn),
            Scope = scope
        }, cancellationToken);
        await tokens.SaveChangesAsync(cancellationToken);

        return pkce.ProviderId;
    }

    public async Task<string?> GetValidTokenAsync(int providerId, CancellationToken cancellationToken = default)
    {
        var token = await tokens.GetLatestForProviderAsync(providerId, cancellationToken);
        if (token is null)
            return null;

        if (token.ExpiresAt <= DateTime.UtcNow && token.RefreshTokenSecretName is not null)
            token = await RefreshTokenAsync(token, cancellationToken);

        if (token.ExpiresAt <= DateTime.UtcNow)
            return null;

        return await secrets.GetAsync(token.AccessTokenSecretName, cancellationToken);
    }

    public async Task RevokeTokenAsync(int providerId, CancellationToken cancellationToken = default)
    {
        await tokens.DeleteForProviderAsync(providerId, cancellationToken);
        await tokens.SaveChangesAsync(cancellationToken);
        await secrets.DeleteAsync(SecretNames.OAuthAccessToken(providerId), cancellationToken);
        await secrets.DeleteAsync(SecretNames.OAuthRefreshToken(providerId), cancellationToken);
    }

    private async Task<OAuthToken> RefreshTokenAsync(OAuthToken token, CancellationToken cancellationToken)
    {
        if (token.RefreshTokenSecretName is null)
            return token;

        var refreshToken = await secrets.GetAsync(token.RefreshTokenSecretName, cancellationToken);
        if (string.IsNullOrWhiteSpace(refreshToken))
            return token;

        var client = httpClientFactory.CreateClient();

        var refreshRequest = new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["client_id"] = ClientId,
            ["refresh_token"] = refreshToken
        };

        var response = await client.PostAsync(TokenEndpoint, new FormUrlEncodedContent(refreshRequest), cancellationToken);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken);

        var accessToken = json.GetProperty("access_token").GetString()!;
        await secrets.SetAsync(token.AccessTokenSecretName, accessToken, cancellationToken);

        token.ExpiresAt = DateTime.UtcNow.AddSeconds(json.GetProperty("expires_in").GetInt32());
        if (json.TryGetProperty("refresh_token", out var rt) && token.RefreshTokenSecretName is not null)
            await secrets.SetAsync(token.RefreshTokenSecretName, rt.GetString() ?? string.Empty, cancellationToken);
        token.CreatedAt = DateTime.UtcNow;

        await tokens.SaveChangesAsync(cancellationToken);
        return token;
    }

    private static string GenerateCodeVerifier()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    private static string GenerateCodeChallenge(string codeVerifier)
    {
        var hash = SHA256.HashData(Encoding.ASCII.GetBytes(codeVerifier));
        return Convert.ToBase64String(hash)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }
}
