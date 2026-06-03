using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Shellmate.Persistence.Migrations;

[Migration("20260603000000_AddAssistantToolCallsAndShellKind")]
[DbContext(typeof(AppDbContext))]
public partial class AddAssistantToolCallsAndShellKind : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "ToolCallId",
            table: "AssistantMessages",
            type: "TEXT",
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "ToolCallsJson",
            table: "AssistantMessages",
            type: "TEXT",
            nullable: false,
            defaultValue: "[]");

        migrationBuilder.AddColumn<string>(
            name: "ToolName",
            table: "AssistantMessages",
            type: "TEXT",
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "ShellKind",
            table: "TerminalConnections",
            type: "TEXT",
            nullable: false,
            defaultValue: "Auto");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "ToolCallId",
            table: "AssistantMessages");

        migrationBuilder.DropColumn(
            name: "ToolCallsJson",
            table: "AssistantMessages");

        migrationBuilder.DropColumn(
            name: "ToolName",
            table: "AssistantMessages");

        migrationBuilder.DropColumn(
            name: "ShellKind",
            table: "TerminalConnections");
    }
}
