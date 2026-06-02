namespace Shellmate.Llm;

public static class SecretNames
{
    public static string ProviderApiKey(int providerId) => $"llm-provider:{providerId}:api-key";
    public static string OAuthAccessToken(int providerId) => $"oauth:{providerId}:access-token";
    public static string OAuthRefreshToken(int providerId) => $"oauth:{providerId}:refresh-token";
}
