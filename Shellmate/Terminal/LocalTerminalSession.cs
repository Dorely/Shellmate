using System.Text;
using System.Threading.Channels;
using Pty.Net;
using Shellmate.Models;

namespace Shellmate.Terminal;

public sealed class LocalTerminalSession : ITerminalBackendSession
{
    private readonly IPtyConnection _pty;
    private readonly ILogger _logger;
    private readonly Decoder _decoder = Encoding.UTF8.GetDecoder();
    private bool _stopped;

    private LocalTerminalSession(IPtyConnection pty, ILogger logger)
    {
        _pty = pty;
        _logger = logger;
    }

    public static async Task<LocalTerminalSession> StartAsync(
        TerminalConnection connection,
        TerminalSize size,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        var shellPath = ResolveShellPath(connection.LocalShellPath);
        var workingDirectory = ResolveWorkingDirectory(connection.LocalWorkingDirectory);
        var options = new PtyOptions
        {
            App = shellPath,
            CommandLine = SplitCommandLine(connection.LocalShellArguments),
            Cwd = workingDirectory,
            Rows = Math.Max(1, size.Rows),
            Cols = Math.Max(2, size.Cols),
            Name = "xterm-256color",
            ForceWinPty = OperatingSystem.IsWindows()
        };

        var pty = await PtyProvider.SpawnAsync(options, cancellationToken);
        return new LocalTerminalSession(pty, logger);
    }

    public async Task PumpOutputAsync(ChannelWriter<TerminalOutput> output, CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        var charBuffer = new char[8192];

        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var read = await _pty.ReaderStream.ReadAsync(buffer, cancellationToken);
                if (read <= 0)
                    break;

                var chars = _decoder.GetChars(buffer, 0, read, charBuffer, 0, flush: false);
                if (chars > 0)
                    await output.WriteAsync(
                        new TerminalOutput(TerminalOutputKind.Data, new string(charBuffer, 0, chars)),
                        cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Local terminal session output pump failed.");
            await output.WriteAsync(new TerminalOutput(TerminalOutputKind.Error, ex.Message), CancellationToken.None);
        }
        finally
        {
            await output.WriteAsync(
                new TerminalOutput(TerminalOutputKind.Exited, $"Local shell exited with code {_pty.ExitCode}."),
                CancellationToken.None);
        }
    }

    public async Task SendAsync(string data, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(data);
        await _pty.WriterStream.WriteAsync(bytes, cancellationToken);
        await _pty.WriterStream.FlushAsync(cancellationToken);
    }

    public Task ResizeAsync(TerminalSize size, CancellationToken cancellationToken)
    {
        _pty.Resize(Math.Max(2, size.Cols), Math.Max(1, size.Rows));
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await Task.Run(StopCore, cancellationToken);
    }

    public ValueTask DisposeAsync()
    {
        StopCore();
        return ValueTask.CompletedTask;
    }

    private void StopCore()
    {
        if (_stopped)
            return;

        _stopped = true;

        try
        {
            _pty.Kill();
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to kill local terminal process.");
        }

        DisposeStream(_pty.WriterStream, "writer");
        DisposeStream(_pty.ReaderStream, "reader");

        try
        {
            if (!_pty.WaitForExit(2_000))
                _logger.LogDebug("Local terminal process did not exit within the wait window.");
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed while waiting for local terminal process exit.");
        }

        try
        {
            if (_pty is IDisposable disposable)
                disposable.Dispose();
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to dispose local terminal connection.");
        }
    }

    private void DisposeStream(Stream stream, string name)
    {
        try
        {
            stream.Dispose();
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to dispose local terminal {StreamName} stream.", name);
        }
    }

    private static string ResolveShellPath(string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured))
            return configured.Trim();

        if (OperatingSystem.IsWindows())
            return FindOnPath("pwsh.exe") ?? FindOnPath("powershell.exe") ?? "cmd.exe";

        var shell = Environment.GetEnvironmentVariable("SHELL");
        if (!string.IsNullOrWhiteSpace(shell) && File.Exists(shell))
            return shell;

        if (File.Exists("/bin/bash"))
            return "/bin/bash";
        return "/bin/sh";
    }

    private static string ResolveWorkingDirectory(string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured) && Directory.Exists(configured))
            return configured.Trim();

        return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
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

    private static string[] SplitCommandLine(string? arguments)
    {
        if (string.IsNullOrWhiteSpace(arguments))
            return [];

        var result = new List<string>();
        var current = new StringBuilder();
        var inQuotes = false;

        foreach (var ch in arguments)
        {
            if (ch == '"')
            {
                inQuotes = !inQuotes;
                continue;
            }

            if (char.IsWhiteSpace(ch) && !inQuotes)
            {
                AddCurrent();
                continue;
            }

            current.Append(ch);
        }

        AddCurrent();
        return result.Count == 0 ? [] : result.ToArray();

        void AddCurrent()
        {
            if (current.Length == 0)
                return;

            result.Add(current.ToString());
            current.Clear();
        }
    }
}
