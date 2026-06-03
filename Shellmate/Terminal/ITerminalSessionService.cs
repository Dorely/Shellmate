using Shellmate.Models;

namespace Shellmate.Terminal;

public interface ITerminalSessionService : IAsyncDisposable
{
    TerminalConnection? ActiveConnection { get; }
    bool IsConnected { get; }
    IAsyncEnumerable<TerminalOutput> ReadOutputAsync(CancellationToken cancellationToken = default);
    Task<TerminalConnectResult> ConnectAsync(
        Guid connectionId,
        TerminalSize size,
        bool trustPresentedHostKey = false,
        CancellationToken cancellationToken = default);
    Task SendAsync(string data, CancellationToken cancellationToken = default);
    Task ResizeAsync(TerminalSize size, CancellationToken cancellationToken = default);
    Task DisconnectAsync(CancellationToken cancellationToken = default);
}
