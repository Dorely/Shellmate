using Shellmate.Models;

namespace Shellmate.Persistence.Repositories;

public interface IOAuthTokenRepository
{
    Task<OAuthToken?> GetLatestForProviderAsync(int providerId, CancellationToken cancellationToken = default);
    Task ReplaceForProviderAsync(int providerId, OAuthToken newToken, CancellationToken cancellationToken = default);
    Task DeleteForProviderAsync(int providerId, CancellationToken cancellationToken = default);
    Task SaveChangesAsync(CancellationToken cancellationToken = default);
}
