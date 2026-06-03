using Microsoft.Extensions.AI;
using Shellmate.Connections;
using Shellmate.Terminal;

namespace Shellmate.Chat;

public sealed record AssistantToolContext(
    ITerminalSessionService Terminal,
    IWorkspaceConnectionContext Workspace,
    CancellationToken CancellationToken);

public sealed class AssistantToolRegistry(
    AssistantShellTools shellTools,
    AssistantNoteTools noteTools)
{
    public IList<AITool> Build(AssistantToolContext context)
    {
        var tools = new List<AITool>();
        tools.AddRange(shellTools.Build(new AssistantShellToolContext(context.Terminal, context.CancellationToken)));
        tools.AddRange(noteTools.Build(context));
        return tools;
    }
}
