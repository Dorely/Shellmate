using System.Threading.Channels;
using Shellmate.Connections;
using Shellmate.Models;
using Shellmate.Persistence.Repositories;
using Shellmate.Secrets;

namespace Shellmate.Terminal;

public sealed class TerminalSessionService(
    ITerminalConnectionRepository connections,
    ITerminalConnectionService connectionService,
    ISecretStore secrets,
    ILogger<TerminalSessionService> logger) : ITerminalSessionService
{
    private readonly Channel<TerminalOutput> _output = Channel.CreateUnbounded<TerminalOutput>();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private ITerminalBackendSession? _activeSession;
    private CancellationTokenSource? _pumpCts;
    private Task? _pumpTask;
    private bool _disposed;

    public TerminalConnection? ActiveConnection { get; private set; }
    public bool IsConnected => _activeSession is not null;

    public IAsyncEnumerable<TerminalOutput> ReadOutputAsync(CancellationToken cancellationToken = default) =>
        _output.Reader.ReadAllAsync(cancellationToken);

    public async Task<TerminalConnectResult> ConnectAsync(
        Guid connectionId,
        TerminalSize size,
        bool trustPresentedHostKey = false,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ThrowIfDisposed();
            await DisconnectCoreAsync(cancellationToken);

            var connection = await connections.GetByIdAsync(connectionId, cancellationToken);
            if (connection is null)
                return TerminalConnectResult.Error("Connection was not found.");

            await _output.Writer.WriteAsync(
                new TerminalOutput(TerminalOutputKind.Status, $"Connecting to {connection.Name}..."),
                cancellationToken);

            ITerminalBackendSession session;
            if (connection.Kind == TerminalConnectionKind.LocalShell)
            {
                session = await LocalTerminalSession.StartAsync(connection, size, logger, cancellationToken);
            }
            else
            {
                var resolved = new ResolvedSshConnection(
                    connection,
                    await secrets.GetAsync(ConnectionSecretNames.SshPassword(connection.Id), cancellationToken),
                    await secrets.GetAsync(ConnectionSecretNames.SshPrivateKeyPassphrase(connection.Id), cancellationToken));
                var sshResult = await SshTerminalSession.StartAsync(
                    resolved,
                    size,
                    trustPresentedHostKey,
                    logger,
                    cancellationToken);

                if (sshResult.HostKeyPrompt is not null)
                    return TerminalConnectResult.HostKeyRequired(sshResult.HostKeyPrompt);
                if (sshResult.ErrorMessage is not null)
                    return TerminalConnectResult.Error(sshResult.ErrorMessage);
                if (sshResult.Session is null)
                    return TerminalConnectResult.Error("SSH session did not start.");

                if (sshResult.Trust is not null)
                    await connectionService.TrustHostKeyAsync(connection.Id, sshResult.Trust, cancellationToken);

                session = sshResult.Session;
            }

            _activeSession = session;
            ActiveConnection = connection;
            _pumpCts = new CancellationTokenSource();
            _pumpTask = Task.Run(
                async () =>
                {
                    await session.PumpOutputAsync(_output.Writer, _pumpCts.Token);
                    await MarkExitedAsync();
                },
                CancellationToken.None);

            await _output.Writer.WriteAsync(
                new TerminalOutput(TerminalOutputKind.Status, $"Connected to {connection.Name}."),
                cancellationToken);
            return TerminalConnectResult.Success();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Terminal connection failed.");
            return TerminalConnectResult.Error(ex.Message);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SendAsync(string data, CancellationToken cancellationToken = default)
    {
        if (_activeSession is null)
            return;

        await _activeSession.SendAsync(data, cancellationToken);
    }

    public async Task ResizeAsync(TerminalSize size, CancellationToken cancellationToken = default)
    {
        if (_activeSession is null)
            return;

        await _activeSession.ResizeAsync(size, cancellationToken);
    }

    public async Task DisconnectAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await DisconnectCoreAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
            return;

        _disposed = true;
        await DisconnectAsync();
        _output.Writer.TryComplete();
        _gate.Dispose();
    }

    private async Task DisconnectCoreAsync(CancellationToken cancellationToken)
    {
        var session = _activeSession;
        if (session is null)
            return;

        _activeSession = null;
        ActiveConnection = null;
        _pumpCts?.Cancel();

        try
        {
            await session.StopAsync(cancellationToken);
        }
        finally
        {
            await session.DisposeAsync();
            _pumpCts?.Dispose();
            _pumpCts = null;
            _pumpTask = null;
        }

        await _output.Writer.WriteAsync(new TerminalOutput(TerminalOutputKind.Status, "Disconnected."), CancellationToken.None);
    }

    private async Task MarkExitedAsync()
    {
        await _gate.WaitAsync();
        try
        {
            if (_activeSession is null)
                return;

            var session = _activeSession;
            _activeSession = null;
            ActiveConnection = null;
            await session.DisposeAsync();
        }
        finally
        {
            _gate.Release();
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }
}
