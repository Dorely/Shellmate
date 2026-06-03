namespace Shellmate.Connections;

public sealed class WorkspaceConnectionContext : IWorkspaceConnectionContext
{
    public Guid? SelectedConnectionId { get; private set; }

    public event Action? SelectedConnectionChanged;

    public void SetSelectedConnection(Guid? connectionId)
    {
        if (SelectedConnectionId == connectionId)
            return;

        SelectedConnectionId = connectionId;
        SelectedConnectionChanged?.Invoke();
    }
}
