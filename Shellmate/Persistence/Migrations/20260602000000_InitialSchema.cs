using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Shellmate.Persistence.Migrations;

[Migration(DatabaseMigrationBootstrapper.InitialMigrationId)]
[DbContext(typeof(AppDbContext))]
public partial class InitialSchema : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "AssistantConversations",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_AssistantConversations", x => x.Id);
            });

        migrationBuilder.CreateTable(
            name: "LlmProviders",
            columns: table => new
            {
                Id = table.Column<int>(type: "INTEGER", nullable: false)
                    .Annotation("Sqlite:Autoincrement", true),
                Name = table.Column<string>(type: "TEXT", nullable: false),
                DisplayName = table.Column<string>(type: "TEXT", nullable: true),
                EndpointUrl = table.Column<string>(type: "TEXT", nullable: false),
                ModelId = table.Column<string>(type: "TEXT", nullable: false),
                AuthType = table.Column<string>(type: "TEXT", nullable: false),
                IsDefault = table.Column<bool>(type: "INTEGER", nullable: false),
                LastChatTestSucceeded = table.Column<bool>(type: "INTEGER", nullable: false),
                LastChatTestedAt = table.Column<DateTime>(type: "TEXT", nullable: true),
                LastChatTestError = table.Column<string>(type: "TEXT", nullable: true),
                LastChatTestEndpointUrl = table.Column<string>(type: "TEXT", nullable: true),
                LastChatTestModelId = table.Column<string>(type: "TEXT", nullable: true),
                LastChatTestAuthType = table.Column<string>(type: "TEXT", nullable: true),
                LastChatTestCredentialSourceId = table.Column<int>(type: "INTEGER", nullable: true),
                CredentialSourceId = table.Column<int>(type: "INTEGER", nullable: true),
                CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_LlmProviders", x => x.Id);
                table.ForeignKey(
                    name: "FK_LlmProviders_LlmProviders_CredentialSourceId",
                    column: x => x.CredentialSourceId,
                    principalTable: "LlmProviders",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.SetNull);
            });

        migrationBuilder.CreateTable(
            name: "StoredSecrets",
            columns: table => new
            {
                Id = table.Column<int>(type: "INTEGER", nullable: false)
                    .Annotation("Sqlite:Autoincrement", true),
                Name = table.Column<string>(type: "TEXT", nullable: false),
                Value = table.Column<string>(type: "TEXT", nullable: false),
                CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_StoredSecrets", x => x.Id);
            });

        migrationBuilder.CreateTable(
            name: "AssistantMessages",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                ConversationId = table.Column<Guid>(type: "TEXT", nullable: false),
                Order = table.Column<int>(type: "INTEGER", nullable: false),
                Role = table.Column<string>(type: "TEXT", nullable: false),
                Content = table.Column<string>(type: "TEXT", nullable: false),
                Status = table.Column<string>(type: "TEXT", nullable: false),
                ErrorMessage = table.Column<string>(type: "TEXT", nullable: true),
                CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_AssistantMessages", x => x.Id);
                table.ForeignKey(
                    name: "FK_AssistantMessages_AssistantConversations_ConversationId",
                    column: x => x.ConversationId,
                    principalTable: "AssistantConversations",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateTable(
            name: "OAuthTokens",
            columns: table => new
            {
                Id = table.Column<int>(type: "INTEGER", nullable: false)
                    .Annotation("Sqlite:Autoincrement", true),
                ProviderId = table.Column<int>(type: "INTEGER", nullable: false),
                AccessTokenSecretName = table.Column<string>(type: "TEXT", nullable: false),
                RefreshTokenSecretName = table.Column<string>(type: "TEXT", nullable: true),
                ExpiresAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                Scope = table.Column<string>(type: "TEXT", nullable: true),
                CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_OAuthTokens", x => x.Id);
                table.ForeignKey(
                    name: "FK_OAuthTokens_LlmProviders_ProviderId",
                    column: x => x.ProviderId,
                    principalTable: "LlmProviders",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateIndex(
            name: "IX_AssistantMessages_ConversationId_Order",
            table: "AssistantMessages",
            columns: new[] { "ConversationId", "Order" });

        migrationBuilder.CreateIndex(
            name: "IX_LlmProviders_CredentialSourceId",
            table: "LlmProviders",
            column: "CredentialSourceId");

        migrationBuilder.CreateIndex(
            name: "IX_LlmProviders_Name",
            table: "LlmProviders",
            column: "Name",
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_OAuthTokens_ProviderId",
            table: "OAuthTokens",
            column: "ProviderId");

        migrationBuilder.CreateIndex(
            name: "IX_StoredSecrets_Name",
            table: "StoredSecrets",
            column: "Name",
            unique: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "AssistantMessages");
        migrationBuilder.DropTable(name: "OAuthTokens");
        migrationBuilder.DropTable(name: "StoredSecrets");
        migrationBuilder.DropTable(name: "AssistantConversations");
        migrationBuilder.DropTable(name: "LlmProviders");
    }
}
