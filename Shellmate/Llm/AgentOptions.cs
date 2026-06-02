namespace Shellmate.Llm;

public sealed class AgentOptions
{
    public const string SectionName = "Agents";

    public int MaxToolIterations { get; set; } = 1;
    public int CodexRequestTimeoutSeconds { get; set; } = 600;
}
