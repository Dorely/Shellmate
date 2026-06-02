using System.Text;

namespace Shellmate.Components.Chat;

public enum ChatMessageRole
{
    User,
    Assistant
}

public enum ChatMessageStatus
{
    Pending,
    Completed,
    Failed,
    Cancelled
}

public sealed record ChatRenderableMessage(
    Guid Id,
    ChatMessageRole Role,
    ChatMessageStatus Status,
    List<ChatMessagePart> Parts);

public abstract class ChatMessagePart;

public sealed class ChatTextPart : ChatMessagePart
{
    public ChatTextPart(string text) => Text.Append(text);

    public StringBuilder Text { get; } = new();

    public void Append(string text) => Text.Append(text);
}

public sealed class ChatLiveTurn
{
    public List<ChatLiveMessage> Messages { get; } = [];
    public bool HasContent => Messages.Any(message => message.Parts.Count > 0);
    public bool IsThinking { get; private set; } = true;

    public void AppendText(string text)
    {
        if (string.IsNullOrEmpty(text))
            return;

        IsThinking = false;
        CurrentMessage().AppendText(text);
    }

    private ChatLiveMessage CurrentMessage()
    {
        if (Messages.Count == 0)
            Messages.Add(new ChatLiveMessage());

        return Messages[^1];
    }
}

public sealed class ChatLiveMessage
{
    public List<ChatMessagePart> Parts { get; } = [];

    public void AppendText(string text)
    {
        if (Parts.LastOrDefault() is ChatTextPart textPart)
            textPart.Append(text);
        else
            Parts.Add(new ChatTextPart(text));
    }
}
