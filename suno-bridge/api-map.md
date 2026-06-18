# Suno "Sound" 接口逆向map(实测 2026-06-14)

通过 Claude-in-Chrome 在已登录会话里嗅探 suno.com 的 Sounds 生成流程得到。
**会变**,坏了就重新嗅探。

## Base & 鉴权

- Base: `https://studio-api-prod.suno.com`
- 每个请求都带这几个头:
  - `authorization: Bearer <Clerk JWT>` — **短命**(~1761 字符的 Clerk 会话 token,几分钟过期,Clerk 自动刷新)
  - `browser-token: <…>`
  - `device-id: <…>`
  - `content-type: application/json`
- ⚠️ Claude-in-Chrome 的安全过滤会**拦截**把原始 token/cookie 回传出来 —— 这对桥接没影响:插件在页面里直接用活 token,本来就不该把它泄露到浏览器外。

## 完整流程

```
POST /api/c/check          额度/资格预检
POST /api/generate/v2-web/ 发起生成 → 拿 clip ids
POST /api/feed/v3          轮询 → status: submitted→streaming→complete，拿 audio_url
（complete 后）下载 cdn1.suno.ai/<id>.mp3
GET  /api/video/generate/<clip_id>/status/   缩略图视频(做 loop 用不到)
```

### 1) 预检 — `POST /api/c/check`
```json
{ "ctype": "generation" }
```

### 2) 生成 — `POST /api/generate/v2-web/`
请求体(实测,Type=Loop / BPM=Auto / Key=Any）:
```json
{
  "token": null,
  "task": "sound",                ← Sound 功能
  "generation_type": "TEXT",
  "title": "Dusty Jazz Rhodes Chords, Lo-fi Boom Bap Loop",
  "tags": "dusty jazz rhodes chords, lo-fi boom bap loop",   ← 描述/prompt
  "negative_tags": "",
  "mv": "chirp-fenix",            ← 模型版本(对应 v5.5)
  "prompt": "",
  "make_instrumental": true,
  "user_uploaded_images_b64": null,
  "metadata": {
    "web_client_pathname": "/create",
    "is_max_mode": false,
    "is_mumble": false,
    "create_mode": "custom",
    "user_tier": "<uuid>",
    "create_session_token": "<uuid，客户端生成>",
    "disable_volume_normalization": false,
    "sound_configs": {
      "user_loop": true,     ← Loop=true / One-Shot=false
      "user_tempo": 85,      ← BPM(整数);留 Auto 时省略此字段
      "user_key": "Am"       ← Key,如 A minor→"Am"、大调→"A"(C#m / F# 等);留 Any 时省略此字段
    }
  },
  "override_fields": [],
  "cover_clip_id": null, "cover_start_s": null, "cover_end_s": null,
  "persona_id": null, "artist_clip_id": null, "artist_start_s": null, "artist_end_s": null,
  "continue_clip_id": null, "continued_aligned_prompt": null, "continue_at": null,
  "transaction_uuid": "<uuid，客户端生成>"
}
```
响应:
```json
{ "id": "<batch id>",
  "clips": [ { "id": "<clip uuid>", "status": "submitted", "model_name": "chirp-seeds",
               "title": "...", "audio_url": "", "metadata": { "task":"sound", "sound_configs":{"user_loop":true}, ... } } ] }
```
→ 取 `clips[].id`。一次生成默认出 2 条变体。

### 3) 轮询 — `POST /api/feed/v3`
```json
{ "filters": { "ids": { "presence": "True", "clipIds": ["<clip id>"] } }, "limit": 1 }
```
响应里每个 clip 的 `status`:`submitted → streaming → complete`。
- streaming 阶段:`audio_url = https://audiopipe.suno.ai/?item_id=<id>`(流式 mp3)
- complete 阶段:
```json
{ "status": "complete",
  "audio_url": "https://cdn1.suno.ai/<id>.mp3",
  "media_urls": [
    { "url": "https://d2lwuy8qc234o3.cloudfront.net/1/clip/<id>.m4a", "content_type": "m4a-opus", "delivery": "progressive" },
    { "url": "https://cdn1.suno.ai/<id>.mp3", "content_type": "mp3", "delivery": "progressive" }
  ],
  "metadata": { "duration": 2.52 } }
```

### 4) 下载
`audio_url`(complete 时即 `cdn1.suno.ai/<id>.mp3`)直接 GET 下载,接进 loop 库。

## 模型版本对照
- v5.5 → `mv: "chirp-fenix"`；生成时 `model_name` 经历 `chirp-seeds`(submitted)→ `chirp-sfx`(streaming/complete)

## UI 控件 → 字段
- Type: One-Shot / Loop 按钮 → `sound_configs.user_loop` (bool)
- BPM: 文本框(可输整数,默认 "Auto")→ `sound_configs.user_tempo` (int);Auto 时省略
- Key: 按钮弹出钢琴键选择器(音名 + Major/Minor + Apply,默认 "Any")→ `sound_configs.user_key` (如 "Am" / "A");Any 时省略
