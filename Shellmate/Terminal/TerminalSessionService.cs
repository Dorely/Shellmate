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
    ITerminalConnectionRepository connections,
    ITerminalConnectionService connectionService,
    ISecretStore secrets,
    IOptions<AgentOptions> options,
    ILogger<TerminalSessionService> logger) : ITerminalSessionService
{
    private const string SentinelPrefix = "__SHELLMATE_";
    private const string Interrupt = "\x03";
    private const int MaxElevationPromptAttempts = 3;

    private readonly Channel<TerminalOutput> _output = Channel.CreateUnbounded<TerminalOutput>();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly SemaphoreSlim _commandGate = new(1, 1);
    private readonly object _historyGate = new();
    private readonly StringBuilder _recentOutput = new();
    private readonly StringBuilder _userInputBuffer = new();
    private readonly List<TerminalCommandRecord> _recentCommands = [];
    private ITerminalBackendSession? _activeSession;
    private CancellationTokenSource? _pumpCts;
    private Task? _pumpTask;
    private ShellCommandExecution? _activeCommand;
    private Func<TerminalElevationPrompt, CancellationToken, Task<TerminalElevationResponse>>? _elevationPromptHandler;
    private bool _disposed;

    public TerminalConnection? ActiveConnection { get; private set; }
    public bool IsConnected => _activeSession is not null;

    public void SetElevationPromptHandler(Func<TerminalElevationPrompt, CancellationToken, Task<TerminalElevationResponse>>? handler) =>
        _elevationPromptHandler = handler;

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
                UpdateCommandRecord(result);
                return result;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                await InterruptCommandAsync(session);
                var result = execution.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    timedOut: false,
                    cancelled: true,
                    error: "Command was cancelled.");
                UpdateCommandRecord(result);
                return result;
            }
            catch (OperationCanceledException)
            {
                await InterruptCommandAsync(session);
                var result = execution.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    timedOut: true,
                    cancelled: false,
                    error: $"Command timed out after {timeout.TotalSeconds:0} seconds.");
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
                await RecordOutputAsync(output, cancellationToken);
                await _output.Writer.WriteAsync(output, CancellationToken.None);
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
        if (activeCommand.TryBuildCompletedResult(EffectiveCommandOutputMaxChars(), out var completed))
        {
            activeCommand.Completion.TrySetResult(completed);
            return;
        }

        if (activeCommand.ShouldCheckElevationPrompt && DetectPasswordPrompt(activeCommand.VisibleOutput))
        {
            if (!activeCommand.TryReserveElevationPrompt(MaxElevationPromptAttempts, out var attempt))
            {
                activeCommand.Completion.TrySetResult(activeCommand.BuildResult(
                    EffectiveCommandOutputMaxChars(),
                    exitCode: null,
                    timedOut: false,
                    cancelled: true,
                    error: "Elevation prompt repeated too many times."));
                await InterruptCommandAsync(_activeSession);
                return;
            }

            await HandleElevationPromptAsync(activeCommand, attempt, cancellationToken);
        }
    }

    private async Task HandleElevationPromptAsync(
        ShellCommandExecution execution,
        int attempt,
        CancellationToken cancellationToken)
    {
        var handler = _elevationPromptHandler;
        var session = _activeSession;
        if (handler is null || session is null)
        {
            execution.Completion.TrySetResult(execution.BuildResult(
                EffectiveCommandOutputMaxChars(),
                exitCode: null,
                timedOut: false,
                cancelled: true,
                error: "The command requested a password, but no approval prompt is available."));
            await InterruptCommandAsync(session);
            return;
        }

        try
        {
            var prompt = new TerminalElevationPrompt(
                Guid.NewGuid(),
                ActiveConnection?.Name ?? "terminal",
                execution.Command,
                LastPromptLine(execution.VisibleOutput),
                attempt);
            var response = await handler(prompt, cancellationToken);
            if (response.Approved && !string.IsNullOrEmpty(response.Password))
            {
                await session.SendAsync(response.Password + "\n", cancellationToken);
                return;
            }

            await InterruptCommandAsync(session);
            execution.Completion.TrySetResult(execution.BuildResult(
                EffectiveCommandOutputMaxChars(),
                exitCode: null,
                timedOut: false,
                cancelled: true,
                error: "Elevation prompt denied by user."));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await InterruptCommandAsync(session);
            execution.Completion.TrySetResult(execution.BuildResult(
                EffectiveCommandOutputMaxChars(),
                exitCode: null,
                timedOut: false,
                cancelled: true,
                error: "Elevation prompt was cancelled."));
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Elevation prompt failed.");
            await InterruptCommandAsync(session);
            execution.Completion.TrySetResult(execution.BuildResult(
                EffectiveCommandOutputMaxChars(),
                exitCode: null,
                timedOut: false,
                cancelled: true,
                error: ex.Message));
        }
    }

    private async Task DisconnectCoreAsync(CancellationToken cancellationToken)
    {
        var session = _activeSession;
        if (session is null)
            return;

        _activeSession = null;
        ActiveConnection = null;
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

    private async Task WriteUiOutputAsync(TerminalOutput output, CancellationToken cancellationToken)
    {
        AppendRecentOutput(output);
        await _output.Writer.WriteAsync(output, cancellationToken);
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
        var delimiter = $"{SentinelPrefix}SCRIPT_{id}__";
        var script = NormalizeNewlines(command);

        return string.Join(
            "\n",
            $"__sm_id='{id}'",
            "printf '\\n%s%s%s\\n' '__SHELLMATE_START_' \"$__sm_id\" '__'",
            $"sh <<'{delimiter}'",
            script,
            delimiter,
            "__sm_code=$?",
            "printf '\\n%s%s%s:%s\\n' '__SHELLMATE_END_' \"$__sm_id\" '__' \"$__sm_code\"",
            string.Empty);
    }

    private static string EscapePowerShellSingleQuoted(string value) =>
        value.Replace("'", "''", StringComparison.Ordinal);

    private static string NormalizeNewlines(string value) =>
        value
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n');

    private static bool DetectPasswordPrompt(string text)
    {
        var clean = StripAnsi(text);
        var tail = clean.Length > 800 ? clean[^800..] : clean;
        return PasswordPromptRegex().IsMatch(tail);
    }

    private static string LastPromptLine(string text)
    {
        var clean = StripAnsi(text).Replace("\r", string.Empty);
        var lines = clean.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return lines.LastOrDefault() ?? "Password required.";
    }

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

    private int EffectiveCommandOutputMaxChars() =>
        Math.Max(2_000, options.Value.TerminalCommandOutputMaxChars);

    private int EffectiveRecentCommandCount() =>
        Math.Clamp(options.Value.TerminalRecentCommandCount, 1, 50);

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

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

    [GeneratedRegex(@"(?i)(?:^|[\r\n])(?:\[sudo\]\s*)?password(?:\s+for\s+[^:\r\n]+)?\s*:[ \t]*\z")]
    private static partial Regex PasswordPromptRegex();

    [GeneratedRegex(@"(?m)^.*__SHELLMATE_(?:START|END)_[A-Fa-f0-9]+__.*(?:\r?\n)?")]
    private static partial Regex SentinelLineRegex();

    private sealed class ShellCommandExecution
    {
        private readonly object _gate = new();
        private readonly StringBuilder _raw = new();
        private int _elevationPromptAttempts;
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

        public bool TryReserveElevationPrompt(int maxAttempts, out int attempt)
        {
            lock (_gate)
            {
                if (Completion.Task.IsCompleted || _elevationPromptAttempts >= maxAttempts)
                {
                    attempt = _elevationPromptAttempts;
                    return false;
                }

                _elevationPromptAttempts++;
                attempt = _elevationPromptAttempts;
                return true;
            }
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
