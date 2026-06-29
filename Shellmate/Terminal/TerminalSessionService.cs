using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Microsoft.Extensions.Options;
using Shellmate.Connections;
using Shellmate.Llm;
using Shellmate.Models;
using Shellmate.Persistence.Repositories;
using Shellmate.Secrets;

namespace Shellmate.Terminal;

public sealed partial class TerminalSessionService(
    IServiceScopeFactory scopeFactory,
    IOptions<AgentOptions> options,
    ILogger<TerminalSessionService> logger) : ITerminalSessionService
{
    private const string SentinelPrefix = "__SHELLMATE_";
    private const string Interrupt = "\x03";
    private const int MaxElevationPromptAttempts = 3;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly SemaphoreSlim _commandGate = new(1, 1);
    private readonly object _historyGate = new();
    private readonly object _outputGate = new();
    private readonly object _stateGate = new();
    private readonly StringBuilder _recentOutput = new();
    private readonly StringBuilder _userInputBuffer = new();
    private readonly List<TerminalCommandRecord> _recentCommands = [];
    private readonly List<TerminalOutput> _replayOutputs = [];
    private readonly List<Channel<TerminalOutput>> _subscribers = [];
    private ITerminalBackendSession? _activeSession;
    private CancellationTokenSource? _pumpCts;
    private Task? _pumpTask;
    private ShellCommandExecution? _activeCommand;
    private TaskCompletionSource<TerminalElevationResponse>? _elevationResponse;
    private TerminalSize _lastSize = TerminalSize.Default;
    private int _replayCharacterCount;
    private bool _disposed;

    public TerminalConnection? ActiveConnection { get; private set; }
    public bool IsConnected => _activeSession is not null;
    public event Action? StateChanged;

    public TerminalElevationPrompt? PendingElevationPrompt { get; private set; }

    public TerminalSnapshot GetSnapshot()
    {
        lock (_historyGate)
        {
            var recentOutput = CleanTerminalText(_recentOutput.ToString());
            var activeCommand = _activeCommand?.BuildActiveSnapshot(EffectiveCommandOutputMaxChars());
            return new TerminalSnapshot(
                IsConnected,
                ActiveConnection?.Name,
                ActiveConnection?.Kind,
                ActiveConnection is null ? null : ResolveShellDescriptor(ActiveConnection),
                activeCommand,
                _recentCommands.ToList(),
                recentOutput,
                _recentOutput.Length >= EffectiveRecentOutputMaxChars());
        }
    }

    public async IAsyncEnumerable<TerminalOutput> SubscribeOutputAsync(
        bool includeReplay = true,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var channel = Channel.CreateUnbounded<TerminalOutput>();
        lock (_outputGate)
        {
            if (includeReplay)
            {
                foreach (var output in _replayOutputs)
                    channel.Writer.TryWrite(output);
            }

            _subscribers.Add(channel);
        }

        try
        {
            await foreach (var output in channel.Reader.ReadAllAsync(cancellationToken))
                yield return output;
        }
        finally
        {
            lock (_outputGate)
                _subscribers.Remove(channel);

            channel.Writer.TryComplete();
        }
    }

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
            return await ConnectCoreAsync(connectionId, size, trustPresentedHostKey, cancellationToken);
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

        TrackUserInput(data);
        await _activeSession.SendAsync(data, cancellationToken);
    }

    private async Task<TerminalConnectResult> ConnectCoreAsync(
        Guid connectionId,
        TerminalSize size,
        bool trustPresentedHostKey,
        CancellationToken cancellationToken)
    {
        _lastSize = size;

        using var scope = scopeFactory.CreateScope();
        var connections = scope.ServiceProvider.GetRequiredService<ITerminalConnectionRepository>();
        var connectionService = scope.ServiceProvider.GetRequiredService<ITerminalConnectionService>();
        var secrets = scope.ServiceProvider.GetRequiredService<ISecretStore>();
        var connection = await connections.GetByIdAsync(connectionId, cancellationToken);
        if (connection is null)
            return TerminalConnectResult.Error("Connection was not found.");

        await WriteUiOutputAsync(
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
        _pumpTask = Task.Run(() => PumpAndRelayOutputAsync(session, _pumpCts.Token), CancellationToken.None);

        await WriteUiOutputAsync(
            new TerminalOutput(TerminalOutputKind.Status, $"Connected to {connection.Name}."),
            cancellationToken);
        NotifyStateChanged();
        return TerminalConnectResult.Success();
    }

    public async Task<TerminalCommandResult> ExecuteCommandAsync(
        string command,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command))
            return DisconnectedCommandResult(command, "Command is required.");

        await _commandGate.WaitAsync(cancellationToken);
        try
        {
            var session = _activeSession;
            var connection = ActiveConnection;
            if (session is null || connection is null)
                return DisconnectedCommandResult(command, "No terminal is connected.");

            if (TryGetActiveRunningCommand(out var activeCommand))
            {
                return activeCommand.BuildRunningResult(
                    EffectiveCommandOutputMaxChars(),
                    "Command was not sent because another assistant command is still running.");
            }

            if (HasPendingElevationPrompt())
            {
                return DisconnectedCommandResult(
                    command,
                    "Terminal is waiting for a password prompt; respond to or deny the prompt before running another command.");
            }

            var shell = ResolveShellDescriptor(connection);
            var execution = ShellCommandExecution.Create(command.Trim(), shell.Kind);
            AddCommandRecord(new TerminalCommandRecord(
                execution.Id,
                TerminalCommandOrigin.Assistant,
                execution.Command,
                execution.StartedAt,
                CompletedAt: null,
                ExitCode: null,
                Status: TerminalCommandStatus.Running,
                Output: string.Empty,
                OutputTruncated: false,
                Message: "Command started.",
                Error: null));

            lock (_historyGate)
                _activeCommand = execution;

            var wrapper = BuildCommandWrapper(execution);
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(timeout);

            try
            {
                await session.SendAsync(wrapper, cancellationToken);
                var result = await execution.Completion.Task.WaitAsync(timeoutCts.Token);
                ClearPendingElevationPromptAndNotify("command completed");
                UpdateCommandRecord(result);
                ClearActiveCommand(execution);
                return result;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                var result = execution.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    status: TerminalCommandStatus.Cancelled,
                    message: "Command was cancelled.",
                    error: "Command was cancelled.");
                var completedByThisPath = execution.TryComplete(result);
                ClearPendingElevationPromptAndNotify("command cancelled");
                if (completedByThisPath)
                    await InterruptCommandAsync(session);
                result = execution.CurrentResultOr(result);
                UpdateCommandRecord(result);
                ClearActiveCommand(execution);
                return result;
            }
            catch (OperationCanceledException)
            {
                var result = execution.CurrentResultOr(execution.BuildRunningResult(
                    EffectiveCommandOutputMaxChars(),
                    $"Command still running after {timeout.TotalSeconds:0} seconds."));
                UpdateCommandRecord(result);
                if (result.Status != TerminalCommandStatus.Running)
                {
                    ClearPendingElevationPromptAndNotify("command completed after timeout race");
                    ClearActiveCommand(execution);
                }

                return result;
            }
        }
        finally
        {
            _commandGate.Release();
        }
    }

    public async Task ResizeAsync(TerminalSize size, CancellationToken cancellationToken = default)
    {
        _lastSize = size;

        if (_activeSession is null)
            return;

        await _activeSession.ResizeAsync(size, cancellationToken);
    }

    public Task RespondToElevationPromptAsync(TerminalElevationResponse response)
    {
        TaskCompletionSource<TerminalElevationResponse>? completion;
        lock (_stateGate)
            completion = _elevationResponse;

        logger.LogDebug(
            "Terminal elevation prompt response received: {Approved}.",
            response.Approved ? "approved" : "denied");
        completion?.TrySetResult(response);
        return Task.CompletedTask;
    }

    public async Task<TerminalResetResult> ResetConnectionAsync(
        string? reason = null,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ThrowIfDisposed();

            var connectionId = ActiveConnection?.Id;
            if (connectionId is null)
                return TerminalResetResult.Failed("No terminal is connected.", GetSnapshot());

            var message = string.IsNullOrWhiteSpace(reason)
                ? "Resetting terminal connection..."
                : $"Resetting terminal connection: {reason.Trim()}";
            await WriteUiOutputAsync(new TerminalOutput(TerminalOutputKind.Status, message), cancellationToken);

            var size = _lastSize;
            await DisconnectCoreAsync(cancellationToken);

            TerminalConnectResult connectResult;
            try
            {
                connectResult = await ConnectCoreAsync(connectionId.Value, size, trustPresentedHostKey: false, cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Terminal reset reconnect failed.");
                return TerminalResetResult.Failed(ex.Message, GetSnapshot());
            }

            if (connectResult.Connected)
                return TerminalResetResult.ReconnectedSnapshot(GetSnapshot());

            if (connectResult.HostKeyPrompt is not null)
                return TerminalResetResult.HostKeyRequired(connectResult.HostKeyPrompt, GetSnapshot());

            return TerminalResetResult.Failed(connectResult.ErrorMessage ?? "Terminal reconnect failed.", GetSnapshot());
        }
        finally
        {
            _gate.Release();
        }
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
        CompleteSubscribers();
        _gate.Dispose();
        _commandGate.Dispose();
    }

    private async Task PumpAndRelayOutputAsync(ITerminalBackendSession session, CancellationToken cancellationToken)
    {
        var backendOutput = Channel.CreateUnbounded<TerminalOutput>();
        var pumpTask = Task.Run(
            async () =>
            {
                try
                {
                    await session.PumpOutputAsync(backendOutput.Writer, cancellationToken);
                }
                finally
                {
                    backendOutput.Writer.TryComplete();
                }
            },
            CancellationToken.None);

        try
        {
            await foreach (var output in backendOutput.Reader.ReadAllAsync(CancellationToken.None))
            {
                if (!IsActiveSession(session))
                    continue;

                PublishOutput(output);
                await RecordOutputAsync(output, cancellationToken);
            }

            await pumpTask;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Terminal output relay failed.");
            await WriteUiOutputAsync(new TerminalOutput(TerminalOutputKind.Error, ex.Message), CancellationToken.None);
        }
        finally
        {
            await MarkExitedAsync(session);
        }
    }

    private async Task RecordOutputAsync(TerminalOutput output, CancellationToken cancellationToken)
    {
        AppendRecentOutput(output);

        ShellCommandExecution? activeCommand;
        lock (_historyGate)
            activeCommand = _activeCommand;

        if (activeCommand is null || output.Kind != TerminalOutputKind.Data)
            return;

        activeCommand.Append(output.Text);

        var reservation = activeCommand.TryReserveNewElevationPrompt(
            MaxElevationPromptAttempts,
            2_000,
            out var attempt,
            out var promptText);

        if (reservation == ElevationPromptReservation.TooManyAttempts)
        {
            var repeatedPromptResult = activeCommand.BuildResult(
                EffectiveCommandOutputMaxChars(),
                exitCode: null,
                status: TerminalCommandStatus.Cancelled,
                message: "Elevation prompt repeated too many times.",
                error: "Elevation prompt repeated too many times.");
            var completedByThisPath = activeCommand.TryComplete(repeatedPromptResult);
            logger.LogWarning(
                "Terminal elevation prompt repeated too many times for command {CommandId}.",
                activeCommand.Id);
            ClearPendingElevationPromptAndNotify("repeated elevation prompt");
            if (completedByThisPath)
            {
                await InterruptCommandAsync(_activeSession);
                UpdateCommandRecord(repeatedPromptResult);
                ClearActiveCommand(activeCommand);
            }
            return;
        }

        if (reservation == ElevationPromptReservation.Reserved)
        {
            logger.LogDebug(
                "Detected terminal elevation prompt for command {CommandId}: {PromptText}",
                activeCommand.Id,
                promptText);
            _ = Task.Run(
                () => HandleElevationPromptAsync(activeCommand, attempt, promptText, cancellationToken),
                CancellationToken.None);
        }

        if (activeCommand.TryBuildCompletedResult(EffectiveCommandOutputMaxChars(), out var completed))
        {
            if (activeCommand.TryComplete(completed))
            {
                ClearPendingElevationPromptAndNotify("command completed");
                UpdateCommandRecord(completed);
                ClearActiveCommand(activeCommand);
            }

            return;
        }
    }

    private async Task HandleElevationPromptAsync(
        ShellCommandExecution execution,
        int attempt,
        string promptText,
        CancellationToken cancellationToken)
    {
        var session = _activeSession;
        if (session is null)
        {
            var result = execution.BuildResult(
                EffectiveCommandOutputMaxChars(),
                exitCode: null,
                status: TerminalCommandStatus.Cancelled,
                message: "The command requested a password, but no terminal session is available.",
                error: "The command requested a password, but no terminal session is available.");
            if (execution.TryComplete(result))
            {
                UpdateCommandRecord(result);
                ClearActiveCommand(execution);
            }

            execution.MarkElevationPromptHandled();
            return;
        }

        try
        {
            var prompt = new TerminalElevationPrompt(
                Guid.NewGuid(),
                ActiveConnection?.Name ?? "terminal",
                execution.Command,
                promptText,
                attempt);
            var response = await RequestElevationAsync(prompt, cancellationToken);
            if (execution.IsCompleted)
                return;

            if (response.Approved && !string.IsNullOrEmpty(response.Password))
            {
                await session.SendAsync(response.Password + "\n", cancellationToken);
                return;
            }

            await InterruptCommandAsync(session);
            var result = execution.BuildResult(
                EffectiveCommandOutputMaxChars(),
                exitCode: null,
                status: TerminalCommandStatus.Cancelled,
                message: "Elevation prompt denied by user.",
                error: "Elevation prompt denied by user.");
            if (execution.TryComplete(result))
            {
                UpdateCommandRecord(result);
                ClearActiveCommand(execution);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            if (!execution.IsCompleted)
            {
                await InterruptCommandAsync(session);
                var result = execution.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    status: TerminalCommandStatus.Cancelled,
                    message: "Elevation prompt was cancelled.",
                    error: "Elevation prompt was cancelled.");
                if (execution.TryComplete(result))
                {
                    UpdateCommandRecord(result);
                    ClearActiveCommand(execution);
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Elevation prompt failed.");
            if (!execution.IsCompleted)
            {
                await InterruptCommandAsync(session);
                var result = execution.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    status: TerminalCommandStatus.Failed,
                    message: ex.Message,
                    error: ex.Message);
                if (execution.TryComplete(result))
                {
                    UpdateCommandRecord(result);
                    ClearActiveCommand(execution);
                }
            }
        }
        finally
        {
            execution.MarkElevationPromptHandled();
        }
    }

    private async Task<TerminalElevationResponse> RequestElevationAsync(
        TerminalElevationPrompt prompt,
        CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource<TerminalElevationResponse>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        lock (_stateGate)
        {
            PendingElevationPrompt = prompt;
            _elevationResponse = completion;
        }
        logger.LogDebug(
            "Terminal elevation prompt state set. PromptId={PromptId}, Attempt={Attempt}, Connection={ConnectionName}.",
            prompt.Id,
            prompt.Attempt,
            prompt.ConnectionName);
        NotifyStateChanged();

        using var registration = cancellationToken.Register(() =>
            completion.TrySetResult(new TerminalElevationResponse(Approved: false, Password: null)));

        var response = await completion.Task;
        logger.LogDebug(
            "Terminal elevation prompt completed. PromptId={PromptId}, Approved={Approved}.",
            prompt.Id,
            response.Approved);

        lock (_stateGate)
        {
            if (ReferenceEquals(_elevationResponse, completion))
            {
                PendingElevationPrompt = null;
                _elevationResponse = null;
                logger.LogDebug(
                    "Terminal elevation prompt cleared after response. PromptId={PromptId}.",
                    prompt.Id);
            }
        }
        NotifyStateChanged();

        return response;
    }

    private async Task DisconnectCoreAsync(CancellationToken cancellationToken)
    {
        var session = _activeSession;
        if (session is null)
        {
            ClearPendingElevationPromptAndNotify("disconnect with no active session");
            return;
        }

        _activeSession = null;
        ActiveConnection = null;
        ClearPendingElevationPrompt("disconnect");
        TerminalCommandResult? disconnectedCommand = null;
        lock (_historyGate)
        {
            var activeCommand = _activeCommand;
            if (activeCommand is not null)
            {
                disconnectedCommand = activeCommand.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    status: TerminalCommandStatus.Cancelled,
                    message: "Terminal disconnected.",
                    error: "Terminal disconnected.");
                activeCommand.Completion.TrySetResult(disconnectedCommand);
            }

            _activeCommand = null;
        }
        if (disconnectedCommand is not null)
            UpdateCommandRecord(disconnectedCommand);

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

        await WriteUiOutputAsync(new TerminalOutput(TerminalOutputKind.Status, "Disconnected."), CancellationToken.None);
        NotifyStateChanged();
    }

    private async Task MarkExitedAsync(ITerminalBackendSession session)
    {
        await _gate.WaitAsync();
        try
        {
            if (!ReferenceEquals(_activeSession, session))
                return;

            _activeSession = null;
            ActiveConnection = null;
            ClearPendingElevationPrompt("terminal exited");
            TerminalCommandResult? exitedCommand = null;
            lock (_historyGate)
            {
                var activeCommand = _activeCommand;
                if (activeCommand is not null)
                {
                    exitedCommand = activeCommand.BuildResult(
                        EffectiveCommandOutputMaxChars(),
                        exitCode: null,
                        status: TerminalCommandStatus.Failed,
                        message: "Terminal exited before the command completed.",
                        error: "Terminal exited before the command completed.");
                    activeCommand.Completion.TrySetResult(exitedCommand);
                    _activeCommand = null;
                }
            }
            if (exitedCommand is not null)
                UpdateCommandRecord(exitedCommand);

            await session.DisposeAsync();
            NotifyStateChanged();
        }
        finally
        {
            _gate.Release();
        }
    }

    private bool IsActiveSession(ITerminalBackendSession session) =>
        ReferenceEquals(_activeSession, session);

    private async Task WriteUiOutputAsync(TerminalOutput output, CancellationToken cancellationToken)
    {
        AppendRecentOutput(output);
        cancellationToken.ThrowIfCancellationRequested();
        PublishOutput(output);
        await Task.CompletedTask;
    }

    private void PublishOutput(TerminalOutput output)
    {
        List<Channel<TerminalOutput>> subscribers;
        lock (_outputGate)
        {
            AppendReplayOutputLocked(output);
            subscribers = _subscribers.ToList();
        }

        foreach (var subscriber in subscribers)
            subscriber.Writer.TryWrite(output);
    }

    private void AppendReplayOutputLocked(TerminalOutput output)
    {
        _replayOutputs.Add(output);
        _replayCharacterCount += ReplayCharacterCount(output);

        var maxChars = EffectiveReplayOutputMaxChars();
        while (_replayCharacterCount > maxChars && _replayOutputs.Count > 0)
        {
            _replayCharacterCount -= ReplayCharacterCount(_replayOutputs[0]);
            _replayOutputs.RemoveAt(0);
        }
    }

    private void CompleteSubscribers()
    {
        lock (_outputGate)
        {
            foreach (var subscriber in _subscribers)
                subscriber.Writer.TryComplete();

            _subscribers.Clear();
        }
    }

    private bool HasPendingElevationPrompt()
    {
        lock (_stateGate)
            return PendingElevationPrompt is not null || _elevationResponse is not null;
    }

    private void ClearPendingElevationPromptAndNotify(string reason)
    {
        if (ClearPendingElevationPrompt(reason))
            NotifyStateChanged();
    }

    private bool ClearPendingElevationPrompt(string reason)
    {
        var changed = false;
        lock (_stateGate)
        {
            changed = PendingElevationPrompt is not null || _elevationResponse is not null;
            PendingElevationPrompt = null;
            _elevationResponse?.TrySetResult(new TerminalElevationResponse(Approved: false, Password: null));
            _elevationResponse = null;
        }

        if (changed)
            logger.LogDebug("Terminal elevation prompt cleared: {Reason}.", reason);
        return changed;
    }

    private void AppendRecentOutput(TerminalOutput output)
    {
        var text = output.Kind switch
        {
            TerminalOutputKind.Data => output.Text,
            TerminalOutputKind.Status => $"\n[status] {output.Text}\n",
            TerminalOutputKind.Error => $"\n[error] {output.Text}\n",
            TerminalOutputKind.Exited => $"\n[exited] {output.Text}\n",
            _ => output.Text
        };

        text = StripAnsi(text);
        lock (_historyGate)
        {
            _recentOutput.Append(text);
            TrimBuilder(_recentOutput, EffectiveRecentOutputMaxChars());
        }
    }

    private void TrackUserInput(string data)
    {
        if (string.IsNullOrEmpty(data))
            return;

        lock (_historyGate)
        {
            foreach (var ch in data)
            {
                switch (ch)
                {
                    case '\r':
                    case '\n':
                        AddUserCommandRecordLocked();
                        break;
                    case '\b':
                    case '\x7f':
                        if (_userInputBuffer.Length > 0)
                            _userInputBuffer.Length--;
                        break;
                    default:
                        if (!char.IsControl(ch))
                            _userInputBuffer.Append(ch);
                        break;
                }
            }
        }
    }

    private void AddUserCommandRecordLocked()
    {
        var command = _userInputBuffer.ToString().Trim();
        _userInputBuffer.Clear();
        if (string.IsNullOrWhiteSpace(command))
            return;

        var now = DateTime.UtcNow;
        AddCommandRecordLocked(new TerminalCommandRecord(
            Guid.NewGuid(),
            TerminalCommandOrigin.User,
            command,
            now,
            now,
            ExitCode: null,
            Status: TerminalCommandStatus.Completed,
            Output: string.Empty,
            OutputTruncated: false,
            Message: null,
            Error: null));
    }

    private void AddCommandRecord(TerminalCommandRecord record)
    {
        lock (_historyGate)
            AddCommandRecordLocked(record);
    }

    private bool TryGetActiveRunningCommand(out ShellCommandExecution activeCommand)
    {
        lock (_historyGate)
        {
            if (_activeCommand is { IsCompleted: false } command)
            {
                activeCommand = command;
                return true;
            }
        }

        activeCommand = null!;
        return false;
    }

    private void ClearActiveCommand(ShellCommandExecution execution)
    {
        lock (_historyGate)
        {
            if (ReferenceEquals(_activeCommand, execution))
                _activeCommand = null;
        }
    }

    private void AddCommandRecordLocked(TerminalCommandRecord record)
    {
        _recentCommands.Add(record);
        while (_recentCommands.Count > EffectiveRecentCommandCount())
            _recentCommands.RemoveAt(0);
    }

    private void UpdateCommandRecord(TerminalCommandResult result)
    {
        lock (_historyGate)
        {
            var index = _recentCommands.FindIndex(command => command.Id == result.Id);
            if (index < 0)
                return;

            _recentCommands[index] = _recentCommands[index] with
            {
                CompletedAt = result.CompletedAt,
                ExitCode = result.ExitCode,
                Status = result.Status,
                Output = result.Output,
                OutputTruncated = result.OutputTruncated,
                Message = result.Message,
                Error = result.Error
            };
        }
    }

    private static TerminalCommandResult DisconnectedCommandResult(string command, string error)
    {
        var now = DateTime.UtcNow;
        return new TerminalCommandResult(
            Guid.NewGuid(),
            command,
            now,
            now,
            ExitCode: null,
            Status: TerminalCommandStatus.Failed,
            Output: string.Empty,
            OutputTruncated: false,
            Message: error,
            Error: error);
    }

    private async Task InterruptCommandAsync(ITerminalBackendSession? session)
    {
        if (session is null)
            return;

        try
        {
            await session.SendAsync(Interrupt, CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Failed to send terminal interrupt.");
        }
    }

    private static TerminalShellDescriptor ResolveShellDescriptor(TerminalConnection connection)
    {
        if (connection.ShellKind != TerminalShellKind.Auto)
            return new TerminalShellDescriptor(connection.ShellKind, IsAssumed: false, ShellKindLabel(connection.ShellKind));

        if (connection.Kind == TerminalConnectionKind.Ssh)
            return new TerminalShellDescriptor(TerminalShellKind.Posix, IsAssumed: true, "Assumed POSIX shell over SSH");

        var shellPath = connection.LocalShellPath;
        if (string.IsNullOrWhiteSpace(shellPath))
        {
            if (OperatingSystem.IsWindows())
                return FindOnPath("pwsh.exe") is not null || FindOnPath("powershell.exe") is not null
                    ? new TerminalShellDescriptor(TerminalShellKind.PowerShell, IsAssumed: false, "Default Windows PowerShell shell")
                    : new TerminalShellDescriptor(TerminalShellKind.Cmd, IsAssumed: false, "Default Windows cmd shell");

            return new TerminalShellDescriptor(TerminalShellKind.Posix, IsAssumed: false, "Default POSIX shell");
        }

        var name = Path.GetFileName(shellPath).ToLowerInvariant();
        if (name is "pwsh" or "pwsh.exe" or "powershell" or "powershell.exe")
            return new TerminalShellDescriptor(TerminalShellKind.PowerShell, IsAssumed: false, "PowerShell");
        if (name is "cmd" or "cmd.exe")
            return new TerminalShellDescriptor(TerminalShellKind.Cmd, IsAssumed: false, "cmd.exe");
        if (name.Contains("bash", StringComparison.Ordinal) ||
            name.Contains("zsh", StringComparison.Ordinal) ||
            name.Contains("fish", StringComparison.Ordinal) ||
            name is "sh" or "sh.exe")
        {
            return new TerminalShellDescriptor(TerminalShellKind.Posix, IsAssumed: false, "POSIX shell");
        }

        return new TerminalShellDescriptor(TerminalShellKind.Posix, IsAssumed: true, $"Assumed POSIX shell from '{shellPath}'");
    }

    private static string ShellKindLabel(TerminalShellKind kind) => kind switch
    {
        TerminalShellKind.PowerShell => "PowerShell",
        TerminalShellKind.Cmd => "cmd.exe",
        TerminalShellKind.Posix => "POSIX shell",
        _ => "Auto"
    };

    private static string BuildCommandWrapper(ShellCommandExecution execution)
    {
        var id = execution.Token;
        return execution.ShellKind switch
        {
            TerminalShellKind.PowerShell => string.Join(
                "; ",
                $"$__sm_id = '{id}'",
                "Write-Output ('__SHELLMATE_START_' + $__sm_id + '__')",
                "$global:LASTEXITCODE = $null",
                $"$__sm_script = [scriptblock]::Create('{EscapePowerShellSingleQuoted(execution.Command)}')",
                "try { & $__sm_script; $__sm_code = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 } } catch { Write-Error $_; $__sm_code = 1 }",
                "Write-Output ('__SHELLMATE_END_' + $__sm_id + '__:' + $__sm_code)",
                "\r\n"),

            TerminalShellKind.Cmd => string.Join(
                "\r\n",
                $"set \"__SM_ID={id}\"",
                "echo __SHELLMATE_START_%__SM_ID%__",
                execution.Command,
                "set \"__SM_CODE=%ERRORLEVEL%\"",
                "echo __SHELLMATE_END_%__SM_ID%__:%__SM_CODE%",
                string.Empty),

            _ => BuildPosixCommandWrapper(id, execution.Command)
        };
    }

    private static string BuildPosixCommandWrapper(string id, string command)
    {
        var script = NormalizeNewlines(command);
        var delimiter = CreateHereDocumentDelimiter(id, script);
        var runScriptLine = string.Join(" ", new[]
        {
            "printf '\\n%s%s%s\\n' '__SHELLMATE_START_' \"$__sm_id\" '__';",
            "if [ \"$__sm_prepare\" -ne 0 ]; then",
            "printf '%s\\n' 'Shellmate failed to stage command script.' >&2; __sm_code=$__sm_prepare;",
            "elif [ \"$(head -c 2 \"$__sm_script\" 2>/dev/null)\" = '#!' ]; then",
            "\"$__sm_script\"; __sm_code=$?;",
            "else",
            "sh \"$__sm_script\"; __sm_code=$?;",
            "fi;",
            "rm -f \"$__sm_script\";",
            "printf '\\n%s%s%s:%s\\n' '__SHELLMATE_END_' \"$__sm_id\" '__' \"$__sm_code\""
        });

        return string.Join(
            "\n",
            $"__sm_id='{id}'",
            "umask 077",
            "__sm_script=\"$(mktemp \"${TMPDIR:-/tmp}/shellmate-$__sm_id.XXXXXX\" 2>/dev/null)\" || { __sm_script=\"${TMPDIR:-/tmp}/shellmate-$__sm_id.sh\"; rm -f \"$__sm_script\"; }",
            $"cat >\"$__sm_script\" <<'{delimiter}'",
            script,
            delimiter,
            "__sm_prepare=$?",
            "chmod 700 \"$__sm_script\" 2>/dev/null || true",
            runScriptLine,
            string.Empty);
    }

    private static string CreateHereDocumentDelimiter(string id, string script)
    {
        var baseDelimiter = $"{SentinelPrefix}SCRIPT_{id}__";
        var delimiter = baseDelimiter;
        var suffix = 0;
        while (ContainsExactLine(script, delimiter))
            delimiter = $"{baseDelimiter}{++suffix}__";

        return delimiter;
    }

    private static bool ContainsExactLine(string text, string candidate)
    {
        foreach (var line in text.Split('\n'))
        {
            if (line == candidate)
                return true;
        }

        return false;
    }

    private static string EscapePowerShellSingleQuoted(string value) =>
        value.Replace("'", "''", StringComparison.Ordinal);

    private static string NormalizeNewlines(string value) =>
        value
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n');

    private static bool TryDetectPasswordPrompt(string text, out string promptText)
    {
        promptText = string.Empty;
        var clean = StripAnsi(SanitizeCommandOutput(text));
        if (string.IsNullOrEmpty(clean))
            return false;

        var tail = clean.Length > 2_000 ? clean[^2_000..] : clean;
        var match = PasswordPromptTailRegex().Match(tail);
        if (!match.Success)
            return false;

        promptText = TrimTerminalPromptTail(match.Groups["prompt"].Value).Trim();
        return !string.IsNullOrWhiteSpace(promptText);
    }

    private static string TrimTerminalPromptTail(string text)
    {
        var end = text.Length;
        while (end > 0 && IsTerminalPromptTailCharacter(text[end - 1]))
            end--;

        return end == text.Length ? text : text[..end];
    }

    private static bool IsTerminalPromptTailCharacter(char ch) =>
        char.IsWhiteSpace(ch) || char.IsControl(ch);

    private static string CleanTerminalText(string text) =>
        SentinelLineRegex().Replace(StripAnsi(text), string.Empty).Trim();

    private static string SanitizeCommandOutput(string text)
    {
        if (!text.Contains('\b', StringComparison.Ordinal))
            return text;

        var sanitized = new StringBuilder(text.Length);
        foreach (var ch in text)
        {
            if (ch == '\b')
            {
                if (sanitized.Length > 0)
                    sanitized.Length--;
                continue;
            }

            sanitized.Append(ch);
        }

        return sanitized.ToString();
    }

    private static string BoundCommandOutput(string output, int maxChars, out bool truncated)
    {
        truncated = output.Length > maxChars;
        if (!truncated)
            return output;

        var marker = "\n\n--- Shellmate output truncated; omitted middle content. ---\n\n";
        var available = Math.Max(0, maxChars - marker.Length);
        var headLength = available / 2;
        var tailLength = available - headLength;
        var omitted = output.Length - headLength - tailLength;
        marker = $"\n\n--- Shellmate output truncated; omitted {omitted} characters from the middle. ---\n\n";

        available = Math.Max(0, maxChars - marker.Length);
        headLength = available / 2;
        tailLength = available - headLength;

        return output[..headLength] + marker + output[^tailLength..];
    }

    private static string StripAnsi(string text) =>
        AnsiRegex().Replace(text, string.Empty);

    private static void TrimBuilder(StringBuilder builder, int maxChars)
    {
        if (builder.Length <= maxChars)
            return;

        builder.Remove(0, builder.Length - maxChars);
    }

    private int EffectiveRecentOutputMaxChars() =>
        Math.Max(2_000, options.Value.TerminalRecentOutputMaxChars);

    private int EffectiveReplayOutputMaxChars() =>
        Math.Max(20_000, EffectiveRecentOutputMaxChars() * 2);

    private int EffectiveCommandOutputMaxChars() =>
        Math.Max(2_000, options.Value.TerminalCommandOutputMaxChars);

    private int EffectiveRecentCommandCount() =>
        Math.Clamp(options.Value.TerminalRecentCommandCount, 1, 50);

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

    private void NotifyStateChanged()
    {
        var handlers = StateChanged;
        if (handlers is null)
            return;

        foreach (Action handler in handlers.GetInvocationList())
        {
            try
            {
                handler();
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Terminal state subscriber failed.");
            }
        }
    }

    private static int ReplayCharacterCount(TerminalOutput output) =>
        output.Text.Length + 32;

    private static string? FindOnPath(string executable)
    {
        var paths = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        foreach (var path in paths)
        {
            var candidate = Path.Combine(path, executable);
            if (File.Exists(candidate))
                return candidate;
        }

        return null;
    }

    [GeneratedRegex(@"\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\a]*(?:\a|\x1B\\)|\x1B[@-_]")]
    private static partial Regex AnsiRegex();

    [GeneratedRegex(@"(?i)(?:^|[\r\n])\s*(?<prompt>(?:\[sudo\]\s*)?password(?:\s+for\s+[^:\r\n]+)?\s*:)[\s\x00-\x1F\x7F]*\z")]
    private static partial Regex PasswordPromptTailRegex();

    [GeneratedRegex(@"(?m)^.*__SHELLMATE_(?:START|END)_[A-Fa-f0-9]+__.*(?:\r?\n)?")]
    private static partial Regex SentinelLineRegex();

    private enum ElevationPromptReservation
    {
        Reserved,
        NoPrompt,
        AlreadyPending,
        TooManyAttempts,
        Completed
    }

    private sealed class ShellCommandExecution
    {
        private readonly object _gate = new();
        private readonly StringBuilder _raw = new();
        private int _elevationPromptAttempts;
        private bool _elevationPromptPending;
        private int _elevationHandledMeaningfulCount = -1;
        private bool _seenStart;

        private ShellCommandExecution(Guid id, string command, TerminalShellKind shellKind)
        {
            Id = id;
            Command = command;
            ShellKind = shellKind;
            Token = id.ToString("N");
            StartToken = $"{SentinelPrefix}START_{Token}__";
            EndPrefix = $"{SentinelPrefix}END_{Token}__:";
            StartedAt = DateTime.UtcNow;
        }

        public Guid Id { get; }
        public string Command { get; }
        public TerminalShellKind ShellKind { get; }
        public string Token { get; }
        public string StartToken { get; }
        public string EndPrefix { get; }
        public DateTime StartedAt { get; }
        public TaskCompletionSource<TerminalCommandResult> Completion { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public bool IsCompleted => Completion.Task.IsCompleted;

        public string VisibleOutput
        {
            get
            {
                lock (_gate)
                    return ExtractVisibleOutput(_raw.ToString(), StartToken, EndPrefix, includeIncomplete: true).Output;
            }
        }

        public static ShellCommandExecution Create(string command, TerminalShellKind shellKind) =>
            new(Guid.NewGuid(), command, shellKind);

        public void Append(string text)
        {
            lock (_gate)
            {
                _raw.Append(text);
                _seenStart |= _raw.ToString().Contains(StartToken, StringComparison.Ordinal);
            }
        }

        public bool TryComplete(TerminalCommandResult result) =>
            Completion.TrySetResult(result);

        public TerminalCommandResult CurrentResultOr(TerminalCommandResult fallback) =>
            Completion.Task.IsCompletedSuccessfully ? Completion.Task.Result : fallback;

        public ElevationPromptReservation TryReserveNewElevationPrompt(
            int maxAttempts,
            int tailChars,
            out int attempt,
            out string promptText)
        {
            promptText = string.Empty;
            lock (_gate)
            {
                attempt = _elevationPromptAttempts;
                if (!_seenStart || Completion.Task.IsCompleted)
                    return ElevationPromptReservation.Completed;

                if (_elevationPromptPending)
                    return ElevationPromptReservation.AlreadyPending;

                var visible = ExtractVisibleOutput(_raw.ToString(), StartToken, EndPrefix, includeIncomplete: true).Output;
                var cleaned = StripAnsi(SanitizeCommandOutput(visible));
                if (cleaned.Length == 0)
                    return ElevationPromptReservation.NoPrompt;

                // Only treat a tail match as a NEW prompt if genuinely new meaningful output
                // has arrived since the last handled prompt. Otherwise the same lingering
                // "[sudo] password for ...:" tail would re-open the modal after we already
                // sent the password, and the next response would leak into the shell.
                var meaningful = CountMeaningful(cleaned);
                if (_elevationHandledMeaningfulCount >= 0 && meaningful <= _elevationHandledMeaningfulCount)
                    return ElevationPromptReservation.NoPrompt;

                var tail = cleaned.Length > tailChars ? cleaned[^tailChars..] : cleaned;
                if (!TryDetectPasswordPrompt(tail, out promptText))
                    return ElevationPromptReservation.NoPrompt;

                if (_elevationPromptAttempts >= maxAttempts)
                    return ElevationPromptReservation.TooManyAttempts;

                _elevationPromptAttempts++;
                _elevationPromptPending = true;
                _elevationHandledMeaningfulCount = meaningful;
                attempt = _elevationPromptAttempts;
                return ElevationPromptReservation.Reserved;
            }
        }

        private static int CountMeaningful(string text)
        {
            var count = 0;
            foreach (var ch in text)
            {
                if (!char.IsWhiteSpace(ch) && !char.IsControl(ch))
                    count++;
            }

            return count;
        }

        public void MarkElevationPromptHandled()
        {
            lock (_gate)
                _elevationPromptPending = false;
        }

        public bool TryBuildCompletedResult(int maxOutputChars, out TerminalCommandResult result)
        {
            lock (_gate)
            {
                var raw = _raw.ToString();
                var endIndex = raw.IndexOf(EndPrefix, StringComparison.Ordinal);
                if (endIndex < 0)
                {
                    result = null!;
                    return false;
                }

                var exitCode = ParseExitCode(raw, endIndex + EndPrefix.Length);
                var status = exitCode is 0 ? TerminalCommandStatus.Completed : TerminalCommandStatus.Failed;
                var message = exitCode is 0
                    ? "Command completed."
                    : $"Command exited with code {exitCode?.ToString() ?? "unknown"}.";
                result = BuildResult(maxOutputChars, exitCode, status, message, error: null);
                return true;
            }
        }

        public TerminalActiveCommandSnapshot? BuildActiveSnapshot(int maxOutputChars)
        {
            if (IsCompleted)
                return null;

            var output = BuildBoundedOutput(maxOutputChars, out var truncated);
            return new TerminalActiveCommandSnapshot(
                Id,
                Command,
                StartedAt,
                Math.Max(0, (DateTime.UtcNow - StartedAt).TotalSeconds),
                TerminalCommandStatus.Running,
                output,
                truncated,
                "Command is still running.");
        }

        public TerminalCommandResult BuildRunningResult(int maxOutputChars, string message)
        {
            var output = BuildBoundedOutput(maxOutputChars, out var truncated);
            return new TerminalCommandResult(
                Id,
                Command,
                StartedAt,
                null,
                null,
                TerminalCommandStatus.Running,
                output,
                truncated,
                message,
                null);
        }

        public TerminalCommandResult BuildResult(
            int maxOutputChars,
            int? exitCode,
            TerminalCommandStatus status,
            string? message,
            string? error)
        {
            var output = BuildBoundedOutput(maxOutputChars, out var truncated);

            return new TerminalCommandResult(
                Id,
                Command,
                StartedAt,
                DateTime.UtcNow,
                exitCode,
                status,
                output,
                truncated,
                message,
                error);
        }

        private string BuildBoundedOutput(int maxOutputChars, out bool truncated)
        {
            string raw;
            lock (_gate)
                raw = _raw.ToString();

            var extracted = ExtractVisibleOutput(raw, StartToken, EndPrefix, includeIncomplete: true);
            var output = SanitizeCommandOutput(CleanTerminalText(extracted.Output));
            return BoundCommandOutput(output, maxOutputChars, out truncated);
        }

        private static (string Output, bool FoundStart) ExtractVisibleOutput(
            string raw,
            string startToken,
            string endPrefix,
            bool includeIncomplete)
        {
            var startIndex = raw.IndexOf(startToken, StringComparison.Ordinal);
            if (startIndex < 0)
                return includeIncomplete ? (raw, FoundStart: false) : (string.Empty, FoundStart: false);

            var outputStart = startIndex + startToken.Length;
            var endIndex = raw.IndexOf(endPrefix, outputStart, StringComparison.Ordinal);
            var outputEnd = endIndex >= 0 ? endIndex : raw.Length;
            return (raw[outputStart..outputEnd], FoundStart: true);
        }

        private static int? ParseExitCode(string raw, int startIndex)
        {
            var cursor = startIndex;
            var negative = false;
            if (cursor < raw.Length && raw[cursor] == '-')
            {
                negative = true;
                cursor++;
            }

            var value = 0;
            var hasDigit = false;
            while (cursor < raw.Length && char.IsDigit(raw[cursor]))
            {
                hasDigit = true;
                value = value * 10 + (raw[cursor] - '0');
                cursor++;
            }

            if (!hasDigit)
                return null;

            return negative ? -value : value;
        }
    }
}
