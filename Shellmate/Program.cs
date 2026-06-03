using ElectronNET.API;
using ElectronNET.API.Entities;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Shellmate.Auth;
using Shellmate.Chat;
using Shellmate.Components;
using Shellmate.Connections;
using Shellmate.Llm;
using Shellmate.Persistence;
using Shellmate.Persistence.Repositories;
using Shellmate.Secrets;
using Shellmate.Terminal;
using Shellmate.Tokens;

var builder = WebApplication.CreateBuilder(args);
var isElectronMode = IsElectronMode(args);
var desktopUrl = isElectronMode ? GetDesktopUrl(builder.Configuration) : null;
var maxInteractiveServerMessageSize = builder.Configuration.GetValue<long?>("Blazor:MaximumReceiveMessageSizeBytes")
    ?? 64L * 1024 * 1024;

// Add services to the container.
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options => options.MaximumReceiveMessageSize = maxInteractiveServerMessageSize);

builder.Services.AddHttpClient();

if (isElectronMode)
{
    builder.Services.AddElectron();
    builder.UseElectron(args, () => ElectronAppReady(desktopUrl!));
    builder.WebHost.UseUrls(desktopUrl!);
}

builder.Services.AddShellmatePersistence(builder.Configuration);
builder.Services.AddScoped<ILlmProviderRepository, LlmProviderRepository>();
builder.Services.AddScoped<IOAuthTokenRepository, OAuthTokenRepository>();
builder.Services.AddScoped<IAssistantConversationRepository, AssistantConversationRepository>();
builder.Services.AddScoped<ITerminalConnectionRepository, TerminalConnectionRepository>();
builder.Services.AddScoped<ISecretStore, SqliteSecretStore>();
builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection(AgentOptions.SectionName));
builder.Services.Configure<TokenCountingOptions>(builder.Configuration.GetSection(TokenCountingOptions.SectionName));
builder.Services.AddSingleton<TiktokenTokenCounter>();
builder.Services.AddSingleton<CharEstimateTokenCounter>();
builder.Services.AddSingleton<ITokenCounter, CompositeTokenCounter>();
builder.Services.AddScoped<ILlmProviderService, LlmProviderService>();
builder.Services.AddScoped<ICodexAuthService, CodexAuthService>();
builder.Services.AddScoped<IChatClientFactory, ChatClientFactory>();
builder.Services.AddScoped<AssistantShellTools>();
builder.Services.AddScoped<IAssistantChatService, AssistantChatService>();
builder.Services.AddScoped<ITerminalConnectionService, TerminalConnectionService>();
builder.Services.AddScoped<ITerminalSessionService, TerminalSessionService>();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await DatabaseMigrationBootstrapper.MigrateAsync(db);
    if (db.Database.GetDbConnection() is SqliteConnection sqliteConnection)
    {
        await sqliteConnection.OpenAsync();
        SqliteConnectionSettings.ConfigureDatabase(sqliteConnection);
        await sqliteConnection.CloseAsync();
    }
}

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    if (!isElectronMode)
        app.UseHsts();
}
app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
if (!isElectronMode)
    app.UseHttpsRedirection();
app.UseAntiforgery();

app.MapStaticAssets();
app.MapRazorComponents<Shellmate.Components.App>()
    .AddInteractiveServerRenderMode();

app.MapCodexOAuth();

app.Run();

static async Task ElectronAppReady(string desktopUrl)
{
    var options = new BrowserWindowOptions
    {
        Title = "Shellmate",
        Show = false,
        Width = 1440,
        Height = 960,
        MinWidth = 1024,
        MinHeight = 700,
        Center = true,
        IsRunningBlazor = true
    };

    if (OperatingSystem.IsWindows() || OperatingSystem.IsLinux())
        options.AutoHideMenuBar = true;

    var browserWindow = await Electron.WindowManager.CreateWindowAsync(options, desktopUrl);
    browserWindow.OnReadyToShow += () => browserWindow.Show();
}

static bool IsElectronMode(string[] args) =>
    args.Any(IsElectronArgument);

static bool IsElectronArgument(string arg)
{
    var normalized = arg.TrimStart('-', '/');
    return normalized.Equals("electron", StringComparison.OrdinalIgnoreCase)
        || normalized.StartsWith("electronPort=", StringComparison.OrdinalIgnoreCase)
        || normalized.StartsWith("electronPID=", StringComparison.OrdinalIgnoreCase)
        || normalized.StartsWith("electronAuthToken=", StringComparison.OrdinalIgnoreCase);
}

static string GetDesktopUrl(IConfiguration configuration)
{
    var bindHost = configuration["Desktop:BindHost"];
    if (string.IsNullOrWhiteSpace(bindHost))
        throw new InvalidOperationException("Desktop:BindHost must be configured to run the desktop shell.");

    if (bindHost.Contains("://", StringComparison.Ordinal))
        throw new InvalidOperationException("Desktop:BindHost must be a host name only, without a URL scheme.");

    var httpPort = configuration.GetValue<int?>("Desktop:HttpPort")
        ?? throw new InvalidOperationException("Desktop:HttpPort must be configured to run the desktop shell.");
    if (httpPort is <= 0 or > 65535)
        throw new InvalidOperationException("Desktop:HttpPort must be between 1 and 65535.");

    return $"http://{bindHost.Trim()}:{httpPort}";
}
