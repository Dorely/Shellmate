using Shellmate.Llm;

namespace Shellmate.Auth;

public static class CodexOAuthEndpoints
{
    public static IEndpointRouteBuilder MapCodexOAuth(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/auth/start/{providerId:int}", (int providerId, ICodexAuthService authService) =>
        {
            var (url, _) = authService.StartPkceFlow(providerId);
            return Results.Redirect(url);
        });

        endpoints.MapGet("/auth/callback", async (
            string? code,
            string? state,
            ICodexAuthService authService,
            CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrEmpty(code) || string.IsNullOrEmpty(state))
                return RedirectToProviders("OAuth callback missing code or state.", "danger");

            try
            {
                await authService.HandleCallbackAsync(code, state, cancellationToken);
                return RedirectToProviders("OpenAI account connected.", "success");
            }
            catch (Exception ex)
            {
                return RedirectToProviders("OAuth failed: " + ex.Message, "danger");
            }
        });

        return endpoints;
    }

    private static IResult RedirectToProviders(string message, string statusKind) =>
        Results.Redirect(
            "/settings/providers?message=" + Uri.EscapeDataString(message)
            + "&statusKind=" + Uri.EscapeDataString(statusKind));
}
