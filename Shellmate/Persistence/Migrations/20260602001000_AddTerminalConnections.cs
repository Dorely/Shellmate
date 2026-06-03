using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Shellmate.Persistence.Migrations;

[Migration("20260602001000_AddTerminalConnections")]
[DbContext(typeof(AppDbContext))]
public partial class AddTerminalConnections : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "TerminalConnections",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                Name = table.Column<string>(type: "TEXT", nullable: false),
                Kind = table.Column<string>(type: "TEXT", nullable: false),
                Host = table.Column<string>(type: "TEXT", nullable: true),
                Port = table.Column<int>(type: "INTEGER", nullable: false),
                Username = table.Column<string>(type: "TEXT", nullable: true),
                SshAuthType = table.Column<string>(type: "TEXT", nullable: false),
                PrivateKeyPath = table.Column<string>(type: "TEXT", nullable: true),
                TrustedHostKeyFingerprintSha256 = table.Column<string>(type: "TEXT", nullable: true),
                TrustedHostKeyName = table.Column<string>(type: "TEXT", nullable: true),
                TrustedHostKeyBits = table.Column<int>(type: "INTEGER", nullable: true),
                LocalShellPath = table.Column<string>(type: "TEXT", nullable: true),
                LocalShellArguments = table.Column<string>(type: "TEXT", nullable: true),
                LocalWorkingDirectory = table.Column<string>(type: "TEXT", nullable: true),
                CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_TerminalConnections", x => x.Id);
            });

        migrationBuilder.CreateIndex(
            name: "IX_TerminalConnections_Name",
            table: "TerminalConnections",
            column: "Name",
            unique: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "TerminalConnections");
    }
}
