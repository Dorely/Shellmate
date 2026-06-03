using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using Microsoft.ML.Tokenizers;

namespace Shellmate.Tokens;

public sealed class TiktokenTokenCounter(IOptions<TokenCountingOptions> options)
{
    private readonly ConcurrentDictionary<string, Tokenizer> _tokenizers = new(StringComparer.OrdinalIgnoreCase);

    public TokenCountResult? TryCount(string text, TokenCountRequest request)
    {
        var encodingName = ResolveEncodingName(request);
        if (encodingName is null)
            return null;

        var tokenizer = _tokenizers.GetOrAdd(encodingName, encoding => TiktokenTokenizer.CreateForEncoding(encoding));
        var warning = string.IsNullOrWhiteSpace(request.ModelName) && !string.IsNullOrWhiteSpace(request.EncodingName)
            ? $"No model was supplied; used explicit encoding '{encodingName}'."
            : null;

        return new TokenCountResult(
            tokenizer.CountTokens(text ?? string.Empty),
            Method: "tiktoken",
            IsExact: true,
            EncodingName: encodingName,
            ModelName: request.ModelName,
            Warning: warning);
    }

    private string? ResolveEncodingName(TokenCountRequest request)
    {
        if (!string.IsNullOrWhiteSpace(request.EncodingName))
            return request.EncodingName.Trim();

        if (string.IsNullOrWhiteSpace(request.ModelName))
            return null;

        var modelName = request.ModelName.Trim();
        if (options.Value.ModelEncodings.TryGetValue(modelName, out var exactEncoding))
            return exactEncoding;

        var prefixMatch = options.Value.ModelEncodings
            .Where(kv => modelName.StartsWith(kv.Key, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(kv => kv.Key.Length)
            .FirstOrDefault();

        return prefixMatch.Key is null ? null : prefixMatch.Value;
    }
}
