using Shellmate.Components.Chat;

namespace Shellmate.Chat;

public sealed class WorkspaceChatRuntime(
    IServiceScopeFactory scopeFactory,
    ILogger<WorkspaceChatRuntime> logger) : IWorkspaceChatRuntime
{
    private readonly object _gate = new();
    private ChatLiveTurn? _live;
    private CancellationTokenSource? _turnCts;
    private string? _pendingUserText;
    private string? _error;
    private bool _running;

    public event Action? StateChanged;
    public event Action? NotesChanged;

    public bool IsRunning
    {
        get
        {
            lock (_gate)
                return _running;
        }
    }

    public WorkspaceChatRuntimeSnapshot GetSnapshot()
    {
        lock (_gate)
        {
            return new WorkspaceChatRuntimeSnapshot(
                _running,
                _live?.Clone(),
                _pendingUserText,
                _error);
        }
    }

    public async Task StartTurnAsync(string userText, CancellationToken cancellationToken = default)
    {
        var text = userText.Trim();
        if (string.IsNullOrWhiteSpace(text))
            throw new ArgumentException("Message cannot be empty.", nameof(userText));

        var persisted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CancellationTokenSource turnCts;
        lock (_gate)
        {
            if (_running)
                return;

            _running = true;
            _live = new ChatLiveTurn();
            _pendingUserText = text;
            _error = null;
            _turnCts = new CancellationTokenSource();
            turnCts = _turnCts;
            _ = Task.Run(() => RunTurnAsync(text, turnCts, persisted), CancellationToken.None);
        }
        NotifyStateChanged();

        using var registration = cancellationToken.Register(() => persisted.TrySetCanceled(cancellationToken));
        await persisted.Task;
    }

    public Task StopTurnAsync()
    {
        CancellationTokenSource? cts;
        lock (_gate)
            cts = _turnCts;

        cts?.Cancel();
        return Task.CompletedTask;
    }

    public async Task ResetConversationAsync(CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (_running)
                return;

            _live = null;
            _pendingUserText = null;
            _error = null;
        }

        using var scope = scopeFactory.CreateScope();
        var chat = scope.ServiceProvider.GetRequiredService<IAssistantChatService>();
        await chat.ResetAsync(cancellationToken);
        NotifyStateChanged();
    }

    public void ClearError()
    {
        lock (_gate)
            _error = null;

        NotifyStateChanged();
    }

    private async Task RunTurnAsync(
        string text,
        CancellationTokenSource turnCts,
        TaskCompletionSource persisted)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var chat = scope.ServiceProvider.GetRequiredService<IAssistantChatService>();
            await foreach (var update in chat.SendAsync(text, turnCts.Token))
            {
                if (update is AssistantUserMessagePersisted)
                {
                    persisted.TrySetResult();
                    continue;
                }

                ApplyUpdate(update);
                NotifyStateChanged();
            }

            persisted.TrySetResult();
        }
        catch (OperationCanceledException) when (turnCts.IsCancellationRequested)
        {
            persisted.TrySetResult();
            SetError("Cancelled.");
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Workspace chat turn failed.");
            persisted.TrySetException(ex);
            SetError(ex.Message);
        }
        finally
        {
            lock (_gate)
            {
                if (ReferenceEquals(_turnCts, turnCts))
                {
                    _running = false;
                    _live = null;
                    _pendingUserText = null;
                    _turnCts = null;
                }
            }

            turnCts.Dispose();
            NotifyStateChanged();
        }
    }

    private void ApplyUpdate(AssistantTurnUpdate update)
    {
        var notifyNotesChanged = false;
        lock (_gate)
        {
            switch (update)
            {
                case AssistantTextDelta delta:
                    _live?.AppendText(delta.Text);
                    break;
                case AssistantToolCallStarted started:
                    _live?.StartToolCall(
                        started.CallId,
                        started.ToolName,
                        started.ArgumentsJson,
                        started.ArgumentsComplete);
                    break;
                case AssistantToolCallArgumentsDelta delta:
                    _live?.AppendToolArguments(
                        delta.CallId,
                        delta.ArgumentsDelta,
                        delta.ArgumentsComplete);
                    break;
                case AssistantToolCallCompleted completed:
                    _live?.CompleteToolCall(
                        completed.CallId,
                        completed.Result,
                        completed.Error,
                        completed.DurationMs);
                    notifyNotesChanged = IsNoteTool(completed.ToolName);
                    break;
                case AssistantTurnError error:
                    _error = error.Message;
                    break;
            }
        }

        if (notifyNotesChanged)
            NotifyNotesChanged();
    }

    private void SetError(string message)
    {
        lock (_gate)
            _error = message;

        NotifyStateChanged();
    }

    private void NotifyStateChanged() => Notify(StateChanged, "Workspace chat state subscriber failed.");

    private void NotifyNotesChanged() => Notify(NotesChanged, "Workspace chat notes subscriber failed.");

    private void Notify(Action? handlers, string failureMessage)
    {
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
                logger.LogDebug(ex, failureMessage);
            }
        }
    }

    private static bool IsNoteTool(string toolName) => toolName is
        "list_connection_notes" or
        "read_connection_note" or
        "create_connection_note" or
        "rename_connection_note" or
        "update_connection_note" or
        "delete_connection_note";
}
