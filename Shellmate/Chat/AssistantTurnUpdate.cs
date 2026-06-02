namespace Shellmate.Chat;

public abstract record AssistantTurnUpdate;

public sealed record AssistantTextDelta(string Text) : AssistantTurnUpdate;

public sealed record AssistantMessageCompleted(Guid MessageId) : AssistantTurnUpdate;

public sealed record AssistantTurnError(string Message, bool Cancelled) : AssistantTurnUpdate;
