using Microsoft.EntityFrameworkCore;
using Shellmate.Models;
using Shellmate.Persistence;

namespace Shellmate.Secrets;

public sealed class SqliteSecretStore(AppDbContext db) : ISecretStore
{
    public async Task<string?> GetAsync(string name, CancellationToken cancellationToken = default)
    {
        var secret = await db.StoredSecrets
            .AsNoTracking()
            .FirstOrDefaultAsync(candidate => candidate.Name == name, cancellationToken);
        return secret?.Value;
    }

    public async Task SetAsync(string name, string value, CancellationToken cancellationToken = default)
    {
        var secret = await db.StoredSecrets.FirstOrDefaultAsync(candidate => candidate.Name == name, cancellationToken);
        if (secret is null)
        {
            secret = new StoredSecret { Name = name, Value = value };
            await db.StoredSecrets.AddAsync(secret, cancellationToken);
        }
        else
        {
            secret.Value = value;
            secret.UpdatedAt = DateTime.UtcNow;
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task DeleteAsync(string name, CancellationToken cancellationToken = default)
    {
        var secrets = await db.StoredSecrets
            .Where(candidate => candidate.Name == name)
            .ToListAsync(cancellationToken);
        if (secrets.Count == 0)
            return;

        db.StoredSecrets.RemoveRange(secrets);
        await db.SaveChangesAsync(cancellationToken);
    }
}
