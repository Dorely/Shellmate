using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.AI;
using Shellmate.Notes;

namespace Shellmate.Chat;

public sealed class AssistantNoteTools(IConnectionNoteService notes)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
        Converters = { new JsonStringEnumConverter() }
    };

    public IList<AITool> Build(AssistantToolContext context)
    {
        return new List<AITool>
        {
            AIFunctionFactory.Create(
                method: () => ListNotesAsync(context),
                name: "list_connection_notes",
                description: "List user-visible notes for the selected connection as JSON. This tool is scoped to the selected workspace connection and does not expose note contents."),

            AIFunctionFactory.Create(
                method: (string title) => ReadNoteAsync(context, title),
                name: "read_connection_note",
                description: "Read one user-visible note by title for the selected connection and return its Markdown text as JSON."),

            AIFunctionFactory.Create(
                method: (string title, string? content = null) => CreateNoteAsync(context, title, content),
                name: "create_connection_note",
                description: "Create a user-visible note for the selected connection. The title must be unique for that connection. Content is Markdown-style plain text."),

            AIFunctionFactory.Create(
                method: (string title, string newTitle) => RenameNoteAsync(context, title, newTitle),
                name: "rename_connection_note",
                description: "Rename a user-visible note for the selected connection. The new title must be unique for that connection."),

            AIFunctionFactory.Create(
                method: (string title, string content) => UpdateNoteAsync(context, title, content),
                name: "update_connection_note",
                description: "Replace the full Markdown-style plain text content of a user-visible note for the selected connection."),

            AIFunctionFactory.Create(
                method: (string title) => DeleteNoteAsync(context, title),
                name: "delete_connection_note",
                description: "Delete one user-visible note by title for the selected connection."),
        };
    }

    private async Task<string> ListNotesAsync(AssistantToolContext context)
    {
        var connectionId = ResolveConnectionId(context);
        if (connectionId is null)
            return Error("No workspace connection is selected.");

        var result = await notes.ListAsync(connectionId.Value, context.CancellationToken);
        return JsonSerializer.Serialize(new { notes = result }, JsonOptions);
    }

    private async Task<string> ReadNoteAsync(AssistantToolContext context, string title)
    {
        var connectionId = ResolveConnectionId(context);
        if (connectionId is null)
            return Error("No workspace connection is selected.");

        var note = await notes.GetByTitleAsync(connectionId.Value, title, context.CancellationToken);
        return note is null
            ? Error("Note was not found for the selected connection.")
            : JsonSerializer.Serialize(new { note }, JsonOptions);
    }

    private async Task<string> CreateNoteAsync(AssistantToolContext context, string title, string? content)
    {
        var connectionId = ResolveConnectionId(context);
        if (connectionId is null)
            return Error("No workspace connection is selected.");

        try
        {
            var note = await notes.CreateAsync(connectionId.Value, title, content ?? string.Empty, context.CancellationToken);
            return JsonSerializer.Serialize(new { note }, JsonOptions);
        }
        catch (InvalidOperationException ex)
        {
            return Error(ex.Message);
        }
    }

    private async Task<string> RenameNoteAsync(AssistantToolContext context, string title, string newTitle)
    {
        var connectionId = ResolveConnectionId(context);
        if (connectionId is null)
            return Error("No workspace connection is selected.");

        try
        {
            var note = await notes.RenameByTitleAsync(connectionId.Value, title, newTitle, context.CancellationToken);
            return JsonSerializer.Serialize(new { note }, JsonOptions);
        }
        catch (InvalidOperationException ex)
        {
            return Error(ex.Message);
        }
    }

    private async Task<string> UpdateNoteAsync(AssistantToolContext context, string title, string content)
    {
        var connectionId = ResolveConnectionId(context);
        if (connectionId is null)
            return Error("No workspace connection is selected.");

        try
        {
            var note = await notes.UpdateContentByTitleAsync(connectionId.Value, title, content, context.CancellationToken);
            return JsonSerializer.Serialize(new { note }, JsonOptions);
        }
        catch (InvalidOperationException ex)
        {
            return Error(ex.Message);
        }
    }

    private async Task<string> DeleteNoteAsync(AssistantToolContext context, string title)
    {
        var connectionId = ResolveConnectionId(context);
        if (connectionId is null)
            return Error("No workspace connection is selected.");

        try
        {
            await notes.DeleteByTitleAsync(connectionId.Value, title, context.CancellationToken);
            return JsonSerializer.Serialize(new { deleted = true, title }, JsonOptions);
        }
        catch (InvalidOperationException ex)
        {
            return Error(ex.Message);
        }
    }

    private static Guid? ResolveConnectionId(AssistantToolContext context) =>
        context.Workspace.SelectedConnectionId ?? context.Terminal.ActiveConnection?.Id;

    private static string Error(string message) =>
        JsonSerializer.Serialize(new { error = message }, JsonOptions);
}
