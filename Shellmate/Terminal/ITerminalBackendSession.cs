using System.Threading.Channels;

namespace Shellmate.Terminal;

public interface ITerminalBackendSession : IAsyncDisposable
{
    Task PumpOutputAsync(ChannelWriter<TerminalOutput> output, CancellationToken cancellationToken);
    Task SendAsync(string data, CancellationToken cancellationToken);
    Task ResizeAsync(TerminalSize size, CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
