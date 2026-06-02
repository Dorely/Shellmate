namespace Shellmate.Models;

public class AssistantMessage
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ConversationId { get; set; }
    public int Order { get; set; }
    public AssistantMessageRole Role { get; set; }
    public string Content { get; set; } = string.Empty;
    public AssistantMessageStatus Status { get; set; }
    public string? ErrorMessage { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public AssistantConversation Conversation { get; set; } = null!;
}

public enum AssistantMessageRole
{
    System,
    User,
    Assistant
}

public enum AssistantMessageStatus
{
    Pending,
    Completed,
    Failed,
    Cancelled
}
