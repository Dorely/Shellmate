namespace Shellmate.Llm;

public sealed class AgentOptions
{
    public const string SectionName = "Agents";

    public int MaxToolIterations { get; set; } = 1;
    public int CodexRequestTimeoutSeconds { get; set; } = 600;
    public int TerminalRecentOutputMaxChars { get; set; } = 12_000;
    public int TerminalCommandOutputMaxChars { get; set; } = 20_000;
    public int TerminalRecentCommandCount { get; set; } = 12;
    public int TerminalCommandTimeoutSeconds { get; set; } = 5;
    public int TerminalWaitMaxSeconds { get; set; } = 30;
}
