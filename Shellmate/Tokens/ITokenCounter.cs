namespace Shellmate.Tokens;

public interface ITokenCounter
{
    TokenCountResult Count(string text, TokenCountRequest? request = null);
}
