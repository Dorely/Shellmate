using System.Data;
using Microsoft.EntityFrameworkCore;

namespace Shellmate.Persistence;

public static class DatabaseMigrationBootstrapper
{
    public const string InitialMigrationId = "20260602000000_InitialSchema";

    public static async Task MigrateAsync(AppDbContext db, CancellationToken cancellationToken = default)
    {
        await StampInitialMigrationForEnsureCreatedDatabaseAsync(db, cancellationToken);

        var pending = (await db.Database.GetPendingMigrationsAsync(cancellationToken)).ToList();
        if (pending.Count == 0)
            return;

        try
        {
            await db.Database.ExecuteSqlRawAsync("DELETE FROM \"__EFMigrationsLock\";", cancellationToken);
        }
        catch
        {
            // The lock table only exists while SQLite migrations are active.
        }

        await db.Database.MigrateAsync(cancellationToken);
    }

    private static async Task StampInitialMigrationForEnsureCreatedDatabaseAsync(
        AppDbContext db,
        CancellationToken cancellationToken)
    {
        var connection = db.Database.GetDbConnection();
        var shouldClose = connection.State == ConnectionState.Closed;
        if (shouldClose)
            await connection.OpenAsync(cancellationToken);

        try
        {
            if (!await TableExistsAsync(connection, "LlmProviders", cancellationToken))
                return;

            await using (var command = connection.CreateCommand())
            {
                command.CommandText = """
                    CREATE TABLE IF NOT EXISTS "__EFMigrationsHistory" (
                        "MigrationId" TEXT NOT NULL CONSTRAINT "PK___EFMigrationsHistory" PRIMARY KEY,
                        "ProductVersion" TEXT NOT NULL
                    );
                    """;
                await command.ExecuteNonQueryAsync(cancellationToken);
            }

            await using var existsCommand = connection.CreateCommand();
            existsCommand.CommandText = """
                SELECT COUNT(*)
                FROM "__EFMigrationsHistory"
                WHERE "MigrationId" = $migrationId;
                """;
            var parameter = existsCommand.CreateParameter();
            parameter.ParameterName = "$migrationId";
            parameter.Value = InitialMigrationId;
            existsCommand.Parameters.Add(parameter);

            var existing = Convert.ToInt32(await existsCommand.ExecuteScalarAsync(cancellationToken));
            if (existing > 0)
                return;

            await using var insertCommand = connection.CreateCommand();
            insertCommand.CommandText = """
                INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion")
                VALUES ($migrationId, $productVersion);
                """;
            var migrationParameter = insertCommand.CreateParameter();
            migrationParameter.ParameterName = "$migrationId";
            migrationParameter.Value = InitialMigrationId;
            insertCommand.Parameters.Add(migrationParameter);

            var productVersionParameter = insertCommand.CreateParameter();
            productVersionParameter.ParameterName = "$productVersion";
            productVersionParameter.Value = typeof(DbContext).Assembly.GetName().Version?.ToString() ?? "10.0.0";
            insertCommand.Parameters.Add(productVersionParameter);

            await insertCommand.ExecuteNonQueryAsync(cancellationToken);
        }
        finally
        {
            if (shouldClose)
                await connection.CloseAsync();
        }
    }

    private static async Task<bool> TableExistsAsync(
        System.Data.Common.DbConnection connection,
        string tableName,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT COUNT(*)
            FROM sqlite_master
            WHERE type = 'table' AND name = $tableName;
            """;
        var parameter = command.CreateParameter();
        parameter.ParameterName = "$tableName";
        parameter.Value = tableName;
        command.Parameters.Add(parameter);

        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken)) > 0;
    }
}
