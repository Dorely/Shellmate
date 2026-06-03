namespace Shellmate.Connections;

public interface IWorkspaceConnectionContext
{
    Guid? SelectedConnectionId { get; }
    event Action? SelectedConnectionChanged;
    void SetSelectedConnection(Guid? connectionId);
}
