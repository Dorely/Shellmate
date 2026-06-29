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
            return new TerminalSnapshot(
                IsConnected,
                ActiveConnection?.Name,
                ActiveConnection?.Kind,
                ActiveConnection is null ? null : ResolveShellDescriptor(ActiveConnection),
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
                TimedOut: false,
                Cancelled: false,
                Output: string.Empty,
                OutputTruncated: false,
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
                return result;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                var result = execution.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    timedOut: false,
                    cancelled: true,
                    error: "Command was cancelled.");
                var completedByThisPath = execution.TryComplete(result);
                ClearPendingElevationPromptAndNotify("command cancelled");
                if (completedByThisPath)
                    await InterruptCommandAsync(session);
                result = execution.CurrentResultOr(result);
                UpdateCommandRecord(result);
                return result;
            }
            catch (OperationCanceledException)
            {
                var result = execution.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    timedOut: true,
                    cancelled: false,
                    error: $"Command timed out after {timeout.TotalSeconds:0} seconds.");
                var completedByThisPath = execution.TryComplete(result);
                ClearPendingElevationPromptAndNotify("command timed out");
                if (completedByThisPath)
                    await InterruptCommandAsync(session);
                result = execution.CurrentResultOr(result);
                UpdateCommandRecord(result);
                return result;
            }
            finally
            {
                lock (_historyGate)
                {
                    if (ReferenceEquals(_activeCommand, execution))
                        _activeCommand = null;
                }
            }
        }
        finally
        {
            _commandGate.Release();
        }
    }

    public async Task ResizeAsync(TerminalSize size, CancellationToken cancellationToken = default)
    {
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
            await MarkExitedAsync();
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

        if (activeCommand.ShouldCheckElevationPrompt
            && TryDetectPasswordPrompt(activeCommand.VisibleOutputTail(2_000), out var promptText))
        {
            logger.LogDebug(
                "Detected terminal elevation prompt for command {CommandId}: {PromptText}",
                activeCommand.Id,
                promptText);
            var reservation = activeCommand.TryReserveElevationPrompt(MaxElevationPromptAttempts, out var attempt);
            if (reservation == ElevationPromptReservation.AlreadyPending || reservation == ElevationPromptReservation.Completed)
                return;

            if (reservation == ElevationPromptReservation.TooManyAttempts)
            {
                var repeatedPromptResult = activeCommand.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    timedOut: false,
                    cancelled: true,
                    error: "Elevation prompt repeated too many times.");
                var completedByThisPath = activeCommand.TryComplete(repeatedPromptResult);
                logger.LogWarning(
                    "Terminal elevation prompt repeated too many times for command {CommandId}.",
                    activeCommand.Id);
                ClearPendingElevationPromptAndNotify("repeated elevation prompt");
                if (completedByThisPath)
                    await InterruptCommandAsync(_activeSession);
                return;
            }

            _ = Task.Run(
                () => HandleElevationPromptAsync(activeCommand, attempt, promptText, cancellationToken),
                CancellationToken.None);
        }

        if (activeCommand.TryBuildCompletedResult(EffectiveCommandOutputMaxChars(), out var completed))
        {
            activeCommand.TryComplete(completed);
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
            execution.TryComplete(execution.BuildResult(
                EffectiveCommandOutputMaxChars(),
                exitCode: null,
                timedOut: false,
                cancelled: true,
                error: "The command requested a password, but no terminal session is available."));
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
            execution.TryComplete(execution.BuildResult(
                EffectiveCommandOutputMaxChars(),
                exitCode: null,
                timedOut: false,
                cancelled: true,
                error: "Elevation prompt denied by user."));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            if (!execution.IsCompleted)
            {
                await InterruptCommandAsync(session);
                execution.TryComplete(execution.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    timedOut: false,
                    cancelled: true,
                    error: "Elevation prompt was cancelled."));
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Elevation prompt failed.");
            if (!execution.IsCompleted)
            {
                await InterruptCommandAsync(session);
                execution.TryComplete(execution.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    timedOut: false,
                    cancelled: true,
                    error: ex.Message));
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
        lock (_historyGate)
        {
            _activeCommand?.Completion.TrySetResult(_activeCommand.BuildResult(
                EffectiveCommandOutputMaxChars(),
                exitCode: null,
                timedOut: false,
                cancelled: true,
                error: "Terminal disconnected."));
            _activeCommand = null;
        }
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
            ClearPendingElevationPrompt("terminal exited");
            await session.DisposeAsync();
            NotifyStateChanged();
        }
        finally
        {
            _gate.Release();
        }
    }

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
            TimedOut: false,
            Cancelled: false,
            Output: string.Empty,
            OutputTruncated: false,
            Error: null));
    }

    private void AddCommandRecord(TerminalCommandRecord record)
    {
        lock (_historyGate)
            AddCommandRecordLocked(record);
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
                TimedOut = result.TimedOut,
                Cancelled = result.Cancelled,
                Output = result.Output,
                OutputTruncated = result.OutputTruncated,
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
            TimedOut: false,
            Cancelled: false,
            Output: string.Empty,
            OutputTruncated: false,
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

        public bool ShouldCheckElevationPrompt
        {
            get
            {
                lock (_gate)
                    return _seenStart && !Completion.Task.IsCompleted;
            }
        }

        public string VisibleOutput
        {
            get
            {
                lock (_gate)
                    return ExtractVisibleOutput(_raw.ToString(), StartToken, EndPrefix, includeIncomplete: true).Output;
            }
        }

        public string VisibleOutputTail(int maxChars)
        {
            lock (_gate)
            {
                var output = ExtractVisibleOutput(_raw.ToString(), StartToken, EndPrefix, includeIncomplete: true).Output;
                return output.Length <= maxChars ? output : output[^maxChars..];
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

        public ElevationPromptReservation TryReserveElevationPrompt(int maxAttempts, out int attempt)
        {
            lock (_gate)
            {
                attempt = _elevationPromptAttempts;
                if (Completion.Task.IsCompleted)
                    return ElevationPromptReservation.Completed;

                if (_elevationPromptPending)
                    return ElevationPromptReservation.AlreadyPending;

                if (_elevationPromptAttempts >= maxAttempts)
                {
                    return ElevationPromptReservation.TooManyAttempts;
                }

                _elevationPromptAttempts++;
                _elevationPromptPending = true;
                attempt = _elevationPromptAttempts;
                return ElevationPromptReservation.Reserved;
            }
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
                result = BuildResult(maxOutputChars, exitCode, timedOut: false, cancelled: false, error: null);
                return true;
            }
        }

        public TerminalCommandResult BuildResult(
            int maxOutputChars,
            int? exitCode,
            bool timedOut,
            bool cancelled,
            string? error)
        {
            string raw;
            lock (_gate)
                raw = _raw.ToString();

            var extracted = ExtractVisibleOutput(raw, StartToken, EndPrefix, includeIncomplete: true);
            var output = SanitizeCommandOutput(CleanTerminalText(extracted.Output));
            output = BoundCommandOutput(output, maxOutputChars, out var truncated);

            return new TerminalCommandResult(
                Id,
                Command,
                StartedAt,
                DateTime.UtcNow,
                exitCode,
                timedOut,
                cancelled,
                output,
                truncated,
                error);
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
