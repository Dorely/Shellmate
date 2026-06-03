using Shellmate.Models;

namespace Shellmate.Terminal;

public interface ITerminalSessionService : IAsyncDisposable
{
    TerminalConnection? ActiveConnection { get; }
    bool IsConnected { get; }
    TerminalElevationPrompt? PendingElevationPrompt { get; }
    event Action? StateChanged;
    TerminalSnapshot GetSnapshot();
    IAsyncEnumerable<TerminalOutput> SubscribeOutputAsync(
        bool includeReplay = true,
        CancellationToken cancellationToken = default);
    Task<TerminalConnectResult> ConnectAsync(
        Guid connectionId,
        TerminalSize size,
        bool trustPresentedHostKey = false,
        CancellationToken cancellationToken = default);
    Task SendAsync(string data, CancellationToken cancellationToken = default);
    Task<TerminalCommandResult> ExecuteCommandAsync(
        string command,
        TimeSpan timeout,
        CancellationToken cancellationToken = default);
    Task ResizeAsync(TerminalSize size, CancellationToken cancellationToken = default);
    Task RespondToElevationPromptAsync(TerminalElevationResponse response);
    Task DisconnectAsync(CancellationToken cancellationToken = default);
}
