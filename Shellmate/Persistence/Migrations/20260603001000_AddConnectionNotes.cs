using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Shellmate.Persistence.Migrations;

[Migration("20260603001000_AddConnectionNotes")]
[DbContext(typeof(AppDbContext))]
public partial class AddConnectionNotes : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "ConnectionNotes",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                TerminalConnectionId = table.Column<Guid>(type: "TEXT", nullable: false),
                Title = table.Column<string>(type: "TEXT", nullable: false),
                NormalizedTitle = table.Column<string>(type: "TEXT", nullable: false),
                Content = table.Column<string>(type: "TEXT", nullable: false),
                CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_ConnectionNotes", x => x.Id);
                table.ForeignKey(
                    name: "FK_ConnectionNotes_TerminalConnections_TerminalConnectionId",
                    column: x => x.TerminalConnectionId,
                    principalTable: "TerminalConnections",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateIndex(
            name: "IX_ConnectionNotes_TerminalConnectionId_NormalizedTitle",
            table: "ConnectionNotes",
            columns: new[] { "TerminalConnectionId", "NormalizedTitle" },
            unique: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "ConnectionNotes");
    }
}
