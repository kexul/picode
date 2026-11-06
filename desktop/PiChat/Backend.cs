using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Threading;

namespace PiChat;

/// <summary>一条「有事」：跑完一轮、在等你答一句，或者你自己说的一句话。</summary>
internal sealed class Note
{
    public long Seq { get; set; }
    public string SessionId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Text { get; set; } = "";
    public long At { get; set; }
    public string? From { get; set; }
    public Ask? Ask { get; set; }
    /// <summary>这句话「怎么画」：后端解析好的一份结构（见 src/markdownBlocks.ts）。</summary>
    public List<MdBlock>? Blocks { get; set; }
    /// <summary>压成一句话的预览（会话列表上那一行）。</summary>
    public string? Plain { get; set; }
    /// <summary>这道题已经在别处（网页上、另一台设备上）答过了：那几个选项直接置灰。</summary>
    public bool Settled { get; set; }
}

/// <summary>正文里的一个块（后端解析好的；键名短，见 src/markdownBlocks.ts）。</summary>
internal sealed class MdBlock
{
    [JsonPropertyName("k")] public string Kind { get; set; } = "";
    /// <summary>段落 / 标题 / 引用里的那几截字。</summary>
    [JsonPropertyName("r")] public List<MdRun>? Runs { get; set; }
    /// <summary>标题级数（1~6）。</summary>
    [JsonPropertyName("n")] public int Level { get; set; }
    /// <summary>列表是不是有序的。</summary>
    [JsonPropertyName("o")] public bool Ordered { get; set; }
    [JsonPropertyName("i")] public List<MdItem>? Items { get; set; }
    /// <summary>代码块的原文。</summary>
    [JsonPropertyName("v")] public string? Value { get; set; }
    /// <summary>表格每一列的对齐（0 左 / 1 中 / 2 右）。</summary>
    [JsonPropertyName("a")] public List<int>? Align { get; set; }
    /// <summary>表格的格子：行 → 列 → 那几截字。</summary>
    [JsonPropertyName("g")] public List<List<List<MdRun>>>? Grid { get; set; }
}

/// <summary>列表里的一项。</summary>
internal sealed class MdItem
{
    [JsonPropertyName("m")] public string? Marker { get; set; }
    [JsonPropertyName("r")] public List<MdRun>? Runs { get; set; }
}

/// <summary>行内的一截字（同一个样式的连续几个字）。</summary>
internal sealed class MdRun
{
    [JsonPropertyName("v")] public string? Value { get; set; }
    [JsonPropertyName("b")] public int Bold { get; set; }
    [JsonPropertyName("i")] public int Italic { get; set; }
    [JsonPropertyName("s")] public int Strike { get; set; }
    [JsonPropertyName("c")] public int Code { get; set; }
    [JsonPropertyName("l")] public int Link { get; set; }
}

/// <summary>模型问的那道题。</summary>
internal sealed class Ask
{
    public string CardId { get; set; } = "";
    public List<string>? Options { get; set; }
    public bool Multi { get; set; }
    /// <summary>推荐项的下标，从 1 数起。</summary>
    public List<int>? Recommended { get; set; }
    public bool AllowText { get; set; }
}

/// <summary>列表里的一个会话。</summary>
internal sealed class SessionInfo
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Running { get; set; }
    /// <summary>正在干什么（thinking / working / idle）。</summary>
    public string? Activity { get; set; }
    /// <summary>更具体一点：正在改哪个文件、在跑什么命令。</summary>
    public string? ActivityDetail { get; set; }
    /// <summary>别的机器推来的会话：这台没有它，回不了话。</summary>
    public bool Remote { get; set; }
    public Note? Last { get; set; }
    /// <summary>只有「现在是什么样」那一份里带；列表变化推来的那份不带。</summary>
    public List<Note>? Notes { get; set; }
}

internal sealed class SessionsPayload
{
    public List<SessionInfo>? Sessions { get; set; }
}

internal sealed class SessionPayload
{
    public SessionInfo? Session { get; set; }
    public List<Note>? Notes { get; set; }
    /// <summary>最近一条回复的原话（跑着的时候会跟着变）。</summary>
    public LastReplyPayload? LastReply { get; set; }
    public bool Ok { get; set; }
    public string? Reason { get; set; }
}

/// <summary>最近一条回复：原文 + 后端解析好的「怎么画」。</summary>
internal sealed class LastReplyPayload
{
    public string? Text { get; set; }
    public List<MdBlock>? Blocks { get; set; }
}

internal sealed class OkPayload
{
    public bool Ok { get; set; }
    public string? Reason { get; set; }
}

internal static class Json
{
    public static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };
}

/// <summary>
/// 后端那一头：一条收事件的长连接，加上拉列表、发一句话、答一道题这几条普通请求。
/// 断了自己重连（2 秒起、最多 30 秒一次）。事件都切到界面线程再交出去。
/// </summary>
internal sealed class Backend
{
    private readonly HttpClient _http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly Dispatcher _ui;
    private readonly CancellationTokenSource _stop = new();
    private readonly string _client;
    private CancellationTokenSource? _attempt;
    private string _url;

    public Backend(string url, Dispatcher ui)
    {
        _url = Normalize(url);
        _ui = ui;
        // 同一台机器重连时让后端把旧的那条安静收掉
        _client = Environment.MachineName + "-desktop";
    }

    public string Url => _url;

    /// <summary>状态行上那句话；第二个参数表示是不是「已连上」。</summary>
    public event Action<string, bool>? StatusChanged;
    /// <summary>会话列表到了；第二个参数表示这份是不是带着每个会话留着的那几条（只有「现在是什么样」那份带）。</summary>
    public event Action<List<SessionInfo>, bool>? SessionsArrived;
    public event Action<Note>? NoteArrived;
    /// <summary>某道题在别处答过了（后端推的 `askdone`）：把那张卡片置灰。</summary>
    public event Action<string>? AskDone;
    /// <summary>后端自己说停了，不用再重连。</summary>
    public event Action<string>? Ended;

    public static string Normalize(string raw)
    {
        var text = (raw ?? "").Trim();
        if (text.Length == 0) { return "http://127.0.0.1:51883"; }
        if (!text.Contains("://", StringComparison.Ordinal)) { text = "http://" + text; }
        return text.TrimEnd('/');
    }

    public static bool IsValid(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == "http" || uri.Scheme == "https");

    public void Start()
    {
        _ = Task.Run(() => LoopAsync(_stop.Token));
    }

    public void Stop()
    {
        try { _stop.Cancel(); } catch { /* 已经停了 */ }
        try { _attempt?.Cancel(); } catch { /* 已经断了 */ }
    }

    /// <summary>换一个后端地址：正在连的那条断掉，拿新地址立刻重连。</summary>
    public void SetUrl(string url)
    {
        var next = Normalize(url);
        if (next == _url) { return; }
        _url = next;
        try { _attempt?.Cancel(); } catch { /* 已经断了 */ }
    }

    /// <summary>把动作切到界面线程再做。</summary>
    private void Post(Action action)
    {
        if (_ui.HasShutdownStarted || _ui.HasShutdownFinished) { return; }
        if (_ui.CheckAccess())
        {
            try { action(); } catch { /* 界面正在收摊 */ }
            return;
        }
        try { _ui.BeginInvoke(DispatcherPriority.Normal, action); } catch { /* 界面已经关了 */ }
    }

    private async Task LoopAsync(CancellationToken stop)
    {
        var delay = 0;
        while (!stop.IsCancellationRequested)
        {
            if (delay > 0)
            {
                using var wait = CancellationTokenSource.CreateLinkedTokenSource(stop);
                _attempt = wait;
                try
                {
                    await Task.Delay(delay, wait.Token);
                }
                catch (OperationCanceledException)
                {
                    // 被 SetUrl 叫醒就立刻用新地址连；真退出就收工
                    if (stop.IsCancellationRequested) { break; }
                    delay = 0;
                    continue;
                }
                finally
                {
                    if (ReferenceEquals(_attempt, wait)) { _attempt = null; }
                }
            }

            using var attempt = CancellationTokenSource.CreateLinkedTokenSource(stop);
            _attempt = attempt;
            var connected = false;
            var restarting = false;
            try
            {
                // 第一次试（或者刚换了地址）才写「正在连接」；重试时留着「连不上后端…」那句
                if (delay == 0) { Post(() => StatusChanged?.Invoke("正在连接后端…", false)); }
                // 长连接还没连上时先拉一份简版列表兜底
                try
                {
                    var list = await FetchSessionsAsync(attempt.Token);
                    Post(() => SessionsArrived?.Invoke(list, false));
                }
                catch (OperationCanceledException) when (attempt.IsCancellationRequested) { throw; }
                catch { /* 兜底拉不到不算错，接着连长连接 */ }

                connected = await StreamOnceAsync(attempt.Token);
            }
            catch (OperationCanceledException)
            {
                // 退出或者换了地址
                restarting = !stop.IsCancellationRequested;
            }
            catch (Exception)
            {
                // 具体原因不上界面，下面统一写「连不上后端，正在重连…」
            }
            finally
            {
                if (ReferenceEquals(_attempt, attempt)) { _attempt = null; }
            }

            if (stop.IsCancellationRequested) { break; }
            if (restarting)
            {
                delay = 0;
                continue;
            }

            delay = connected ? 2000 : (delay == 0 ? 2000 : Math.Min(delay * 2, 30000));
            if (connected)
            {
                Post(() => StatusChanged?.Invoke("连接断了，正在重连…", false));
            }
            else
            {
                var seconds = delay / 1000;
                Post(() => StatusChanged?.Invoke("连不上后端，正在重连…（" + seconds + " 秒后再试）", false));
            }
        }
    }

    /// <summary>连一次长连接，一直读到断。连上过就返回 true。</summary>
    private async Task<bool> StreamOnceAsync(CancellationToken ct)
    {
        var url = _url + "/phone?client=" + Uri.EscapeDataString(_client);
        using var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        connectTimeout.CancelAfter(TimeSpan.FromSeconds(15));

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Accept.ParseAdd("text/event-stream");
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, connectTimeout.Token);
        response.EnsureSuccessStatusCode();

        Post(() => StatusChanged?.Invoke("已连上", true));

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);

        string? eventName = null;
        var data = new StringBuilder();
        while (!ct.IsCancellationRequested)
        {
            // 后端 25 秒一次心跳；70 秒什么都没来就当这条断了
            idle.CancelAfter(TimeSpan.FromSeconds(70));
            string? line;
            try
            {
                line = await reader.ReadLineAsync(idle.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return true; // 静默超时：当成断了，重连
            }

            if (line == null) { return true; } // 后端把连接关了

            if (line.Length == 0)
            {
                if (data.Length > 0)
                {
                    HandleEvent(eventName ?? "message", data.ToString());
                    eventName = null;
                    data.Clear();
                }
                continue;
            }

            if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                eventName = line[6..].Trim();
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (data.Length > 0) { data.Append('\n'); }
                data.Append(line[5..].TrimStart());
            }
            // retry: 这类行不关心
        }
        return true;
    }

    private void HandleEvent(string name, string json)
    {
        try
        {
            switch (name)
            {
                case "hello":
                    Post(() => StatusChanged?.Invoke("已连上", true));
                    break;

                case "snapshot":
                {
                    var payload = JsonSerializer.Deserialize<SessionsPayload>(json, Json.Options);
                    var list = payload?.Sessions ?? new List<SessionInfo>();
                    Post(() => SessionsArrived?.Invoke(list, true));
                    break;
                }

                case "sessions":
                {
                    var payload = JsonSerializer.Deserialize<SessionsPayload>(json, Json.Options);
                    var list = payload?.Sessions ?? new List<SessionInfo>();
                    Post(() => SessionsArrived?.Invoke(list, false));
                    break;
                }

                case "note":
                {
                    var note = JsonSerializer.Deserialize<Note>(json, Json.Options);
                    if (note != null) { Post(() => NoteArrived?.Invoke(note)); }
                    break;
                }

                case "tick":
                    break;

                case "askdone":
                {
                    // 先把字取出来，再交给界面线程：那个 JsonDocument 出了这个块就了，
                    // 在 Post 里再去读它只能撞上 ObjectDisposedException（见 app.log 里那几条）
                    var cardId = "";
                    using (var doc = JsonDocument.Parse(json))
                    {
                        if (doc.RootElement.TryGetProperty("cardId", out var card)) { cardId = card.GetString() ?? ""; }
                    }
                    Post(() => AskDone?.Invoke(cardId));
                    break;
                }

                case "end":
                {
                    var reason = "";
                    try
                    {
                        using var doc = JsonDocument.Parse(json);
                        if (doc.RootElement.TryGetProperty("note", out var note)) { reason = note.GetString() ?? ""; }
                    }
                    catch { /* 没带原因也照停 */ }
                    Stop();
                    Post(() => Ended?.Invoke(reason));
                    break;
                }
            }
        }
        catch (JsonException)
        {
            // 一段坏的就丢掉，别把整条连接带下去
        }
    }

    private async Task<List<SessionInfo>> FetchSessionsAsync(CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        var text = await _http.GetStringAsync(_url + "/phone/sessions", timeout.Token);
        var payload = JsonSerializer.Deserialize<SessionsPayload>(text, Json.Options);
        return payload?.Sessions ?? new List<SessionInfo>();
    }

    /// <summary>进去时拉一次这个会话的完整一份；不在了把后端给的原因带回来。</summary>
    public async Task<(SessionInfo? Session, List<Note>? Notes, string Reason, LastReplyPayload? LastReply)> LoadSessionAsync(string sessionId)
    {
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            using var response = await _http.GetAsync(_url + "/phone/session?id=" + Uri.EscapeDataString(sessionId), timeout.Token);
            var text = await response.Content.ReadAsStringAsync(timeout.Token);
            if (!response.IsSuccessStatusCode)
            {
                var reason = "";
                try { reason = JsonSerializer.Deserialize<OkPayload>(text, Json.Options)?.Reason ?? ""; } catch { /* 不是 JSON */ }
                return (null, null, reason.Length > 0 ? reason : "后端回了 " + (int)response.StatusCode, null);
            }
            var payload = JsonSerializer.Deserialize<SessionPayload>(text, Json.Options);
            if (payload?.Session == null) { return (null, null, payload?.Reason ?? "后端没给这个会话", null); }
            return (payload.Session, payload.Notes ?? new List<Note>(), "", payload.LastReply);
        }
        catch (Exception ex)
        {
            return (null, null, "连不上后端：" + ex.Message, null);
        }
    }

    /// <summary>回一句。成功返回空原因。</summary>
    public async Task<(bool Ok, string Reason)> SendAsync(string sessionId, string text)
    {
        return await PostJsonAsync("/phone/send", new { sessionId, text });
    }

    /// <summary>答一道题。选项传选项原文，「自己写」那一句单独传。</summary>
    public async Task<(bool Ok, string Reason)> AnswerAsync(string cardId, List<string> picks, string text)
    {
        return await PostJsonAsync("/phone/answer", new { cardId, picks, text });
    }

    private async Task<(bool Ok, string Reason)> PostJsonAsync(string path, object body)
    {
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            using var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
            using var response = await _http.PostAsync(_url + path, content, timeout.Token);
            var text = await response.Content.ReadAsStringAsync(timeout.Token);
            OkPayload? result = null;
            try { result = JsonSerializer.Deserialize<OkPayload>(text, Json.Options); } catch { /* 不是 JSON */ }

            if (result != null && result.Ok) { return (true, ""); }
            if (result?.Reason is { Length: > 0 } reason) { return (false, reason); }

            var plain = (text ?? "").Trim();
            return (false, plain.Length > 0 ? plain : "后端回了 " + (int)response.StatusCode + "，没说是为什么");
        }
        catch (Exception ex)
        {
            return (false, "连不上后端：" + ex.Message);
        }
    }
}
