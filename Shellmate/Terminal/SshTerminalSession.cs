using System.Text;
using System.Threading.Channels;
using Renci.SshNet;
using Renci.SshNet.Common;
using Shellmate.Connections;
using Shellmate.Models;

namespace Shellmate.Terminal;

public sealed class SshTerminalSession : ITerminalBackendSession
{
    private readonly SshClient _client;
    private readonly ShellStream _shell;
    private readonly ILogger _logger;
    private readonly Decoder _decoder = Encoding.UTF8.GetDecoder();

    private SshTerminalSession(SshClient client, ShellStream shell, ILogger logger)
    {
        _client = client;
        _shell = shell;
        _logger = logger;
    }

    public static async Task<SshSessionStartResult> StartAsync(
        ResolvedSshConnection resolved,
        TerminalSize size,
        bool trustPresentedHostKey,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        var connection = resolved.Connection;
        var auth = CreateAuthentication(connection, resolved);
        var connectionInfo = new Renci.SshNet.ConnectionInfo(connection.Host!, connection.Port, connection.Username!, auth)
        {
            Timeout = TimeSpan.FromSeconds(20)
        };

        TerminalHostKeyPrompt? presentedHostKey = null;
        var hostKeyTrustRequired = false;
        var hostKeyMismatch = false;
        var trustedFingerprint = connection.TrustedHostKeyFingerprintSha256;
        var trustedName = connection.TrustedHostKeyName;

        var client = new SshClient(connectionInfo);
        client.HostKeyReceived += (_, args) =>
        {
            presentedHostKey = ToPrompt(connection, args);
            var presentedFingerprint = args.FingerPrintSHA256;

            if (string.IsNullOrWhiteSpace(trustedFingerprint))
            {
                hostKeyTrustRequired = !trustPresentedHostKey;
                args.CanTrust = trustPresentedHostKey;
                return;
            }

            var fingerprintMatches = string.Equals(
                trustedFingerprint,
                presentedFingerprint,
                StringComparison.Ordinal);
            var nameMatches = string.IsNullOrWhiteSpace(trustedName)
                || string.Equals(trustedName, args.HostKeyName, StringComparison.Ordinal);

            args.CanTrust = fingerprintMatches && nameMatches;
            hostKeyMismatch = !args.CanTrust;
        };

        try
        {
            await Task.Run(client.Connect, cancellationToken);
        }
        catch when (presentedHostKey is not null && hostKeyTrustRequired)
        {
            client.Dispose();
            return SshSessionStartResult.HostKeyRequired(presentedHostKey);
        }
        catch when (presentedHostKey is not null && hostKeyMismatch)
        {
            client.Dispose();
            return SshSessionStartResult.Error(
                "The SSH host key changed or no longer matches the trusted key. Clear the trusted host key in connection settings before trusting a new key.");
        }
        catch (Exception ex)
        {
            client.Dispose();
            return SshSessionStartResult.Error(ex.Message);
        }

        if (trustPresentedHostKey && presentedHostKey is not null)
            return SshSessionStartResult.ConnectedWithTrust(
                new SshTerminalSession(
                    client,
                    client.CreateShellStream(
                        "xterm-256color",
                        (uint)Math.Max(2, size.Cols),
                        (uint)Math.Max(1, size.Rows),
                        0,
                        0,
                        8192),
                    logger),
                new SshHostKeyTrust(
                    presentedHostKey.FingerprintSha256,
                    presentedHostKey.HostKeyName,
                    presentedHostKey.KeyBits));

        return SshSessionStartResult.Connected(new SshTerminalSession(
            client,
            client.CreateShellStream(
                "xterm-256color",
                (uint)Math.Max(2, size.Cols),
                (uint)Math.Max(1, size.Rows),
                0,
                0,
                8192),
            logger));
    }

    public async Task PumpOutputAsync(ChannelWriter<TerminalOutput> output, CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        var charBuffer = new char[8192];

        try
        {
            while (!cancellationToken.IsCancellationRequested && _client.IsConnected)
            {
                var read = await _shell.ReadAsync(buffer, cancellationToken);
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
            _logger.LogWarning(ex, "SSH terminal session output pump failed.");
            await output.WriteAsync(new TerminalOutput(TerminalOutputKind.Error, ex.Message), CancellationToken.None);
        }
        finally
        {
            await output.WriteAsync(new TerminalOutput(TerminalOutputKind.Exited, "SSH session ended."), CancellationToken.None);
        }
    }

    public async Task SendAsync(string data, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(data);
        await _shell.WriteAsync(bytes, cancellationToken);
        await _shell.FlushAsync(cancellationToken);
    }

    public Task ResizeAsync(TerminalSize size, CancellationToken cancellationToken)
    {
        _shell.ChangeWindowSize(
            (uint)Math.Max(2, size.Cols),
            (uint)Math.Max(1, size.Rows),
            0,
            0);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            _shell.Dispose();
            if (_client.IsConnected)
                _client.Disconnect();
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to stop SSH terminal session cleanly.");
        }

        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        _shell.Dispose();
        if (_client.IsConnected)
            _client.Disconnect();
        _client.Dispose();
        return ValueTask.CompletedTask;
    }

    private static AuthenticationMethod CreateAuthentication(
        TerminalConnection connection,
        ResolvedSshConnection resolved)
    {
        return connection.SshAuthType switch
        {
            SshAuthenticationType.Password => new PasswordAuthenticationMethod(
                connection.Username!,
                resolved.Password ?? throw new InvalidOperationException("SSH password is required.")),
            SshAuthenticationType.PrivateKeyPath => new PrivateKeyAuthenticationMethod(
                connection.Username!,
                string.IsNullOrEmpty(resolved.PrivateKeyPassphrase)
                    ? new PrivateKeyFile(connection.PrivateKeyPath!)
                    : new PrivateKeyFile(connection.PrivateKeyPath!, resolved.PrivateKeyPassphrase)),
            _ => throw new InvalidOperationException("Unsupported SSH authentication type.")
        };
    }

    private static TerminalHostKeyPrompt ToPrompt(TerminalConnection connection, HostKeyEventArgs args) =>
        new(
            connection.Id,
            connection.Host!,
            connection.Port,
            args.HostKeyName,
            args.FingerPrintSHA256,
            args.KeyLength);
}

public sealed record SshSessionStartResult(
    SshTerminalSession? Session,
    string? ErrorMessage,
    TerminalHostKeyPrompt? HostKeyPrompt,
    SshHostKeyTrust? Trust)
{
    public static SshSessionStartResult Connected(SshTerminalSession session) =>
        new(session, null, null, null);

    public static SshSessionStartResult ConnectedWithTrust(SshTerminalSession session, SshHostKeyTrust trust) =>
        new(session, null, null, trust);

    public static SshSessionStartResult Error(string message) =>
        new(null, message, null, null);

    public static SshSessionStartResult HostKeyRequired(TerminalHostKeyPrompt prompt) =>
        new(null, null, prompt, null);
}
