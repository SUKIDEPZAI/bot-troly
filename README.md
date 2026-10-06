# Discord AI Council 2.0

Bot Discord kiểu chat tự nhiên: không cần slash command. Bot tự phân loại yêu cầu, chấm độ khó, chọn 1/2/nhiều AI, và với câu khó sẽ chạy **đúng 3 vòng tranh luận** rồi cho Judge tổng hợp. Có PostgreSQL memory, xuất file, giao diện Embed và Image Engine tách khỏi AI chat.

## Điểm chính

- Chat tự nhiên: có thể trả lời mọi message trong channel được cho phép.
- Adaptive Router: EASY / MEDIUM / HARD.
- Intent: chat, coding, research, file, math, explain, image.
- Multi-AI: OpenAI, Anthropic, Gemini + nhiều provider OpenAI-compatible.
- Có sẵn adapter cho DeepSeek, Groq, Mistral, OpenRouter, xAI, Together, Fireworks, Cerebras, Perplexity, SambaNova, NVIDIA.
- Có `CUSTOM_AI_PROVIDERS_JSON` để thêm provider OpenAI-compatible mà không sửa code lõi.
- HARD → 3 vòng: đề xuất → phản biện → chốt → Judge.
- PostgreSQL: user/channel/message/memory/AI stats.
- Người dùng nói “xuất file/tạo file/gửi file” → bot đính kèm file từ code blocks.
- Tạo ảnh: gọi ComfyUI self-hosted/GPU worker; không tiêu token AI chat.
- Beautiful Discord Embeds + một message trạng thái được edit thay vì spam channel.
- Retry + timeout + provider health statistics.

## 1) Local

Node.js 24.17+.

```bash
npm install
cp .env.example .env
npm start
```

Điền `DISCORD_TOKEN` và ít nhất một AI provider.

## 2) Discord Bot

Trong Discord Developer Portal bật **Message Content Intent**. Bot cần quyền đọc message và gửi message/files.

## 3) PostgreSQL / Render

`render.yaml` tạo service + Postgres. Render sẽ cung cấp `DATABASE_URL` qua `fromDatabase`.

Các API key phải để trong Render Environment Variables, không commit `.env`.

## 4) Multi-AI mở rộng

Chỉ cần đặt API key + model:

```env
OPENAI_API_KEY=...
OPENAI_MODEL=...
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=...
GEMINI_API_KEY=...
GEMINI_MODEL=...
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=...
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...
```

Provider nào không có key/model sẽ tự bị bỏ qua.

### Thêm provider mới không sửa code

```env
CUSTOM_AI_PROVIDERS_JSON=[{"name":"my-ai","apiKeyEnv":"MY_AI_KEY","modelEnv":"MY_AI_MODEL","baseURL":"https://example.com/v1","family":"compatible","speed":8,"quality":8}]
MY_AI_KEY=...
MY_AI_MODEL=...
```

## 5) Image Engine

Cài ComfyUI trên máy/GPU worker, bật API mặc định port 8188. Có thể dùng workflow từ dự án GitHub được phép sử dụng nhưng nên kiểm tra license/model/node trước khi đưa vào hệ thống.

Đặt:

```env
COMFYUI_URL=http://YOUR_GPU_HOST:8188
COMFYUI_WORKFLOW=workflows/txt2img_api.json
COMFYUI_CHECKPOINT=YOUR_CHECKPOINT.safetensors
```

Bot gửi workflow tới `/prompt`, chờ `/history/{prompt_id}`, rồi tải ảnh từ `/view`, theo cách ComfyUI minh họa trong repository chính thức.

**Không dùng model chat để sinh ảnh.** Chat AI chỉ xử lý tin nhắn; Image Engine mới thực sự render ảnh.

## 6) Lưu ý về model/provider

Tên model thay đổi theo provider. Hãy đặt model ID đang có sẵn trong tài khoản của bạn thay vì giữ giá trị mẫu trong `.env.example`.

## Luồng hoạt động

```text
Discord
  -> Intent + Difficulty
  -> PostgreSQL memory/stats
  -> Single AI / Medium review / 3-round Multi-AI
  -> Judge
  -> Beautiful Discord Embed + optional file

Image request
  -> ComfyUI worker
  -> PNG/JPG
  -> Discord attachment
```

## Discord permissions & targeted replies

The bot now checks channel permissions before processing messages. Recommended Discord bot permissions are:
- View Channel
- Send Messages
- Embed Links
- Attach Files
- Read Message History

The bot does **not** need the Administrator permission for normal AI features. Use `ADMIN_USER_IDS` / `ADMIN_ROLE_IDS` for the bot's own elevated configuration policy. `MODERATOR_ROLE_IDS` is reserved for future moderation/management tools.

Set `DISCORD_CLIENT_ID` and optionally `DISCORD_BOT_PERMISSIONS=118784` to build your invite URL manually. If you later add moderation tools, grant only the individual Discord permissions required by those tools rather than Administrator.

### Chỉ đích danh
Mention a user in a message, for example `@Minh hãy giải thích đoạn code này`. The bot detects the mentioned user, keeps the request context, and addresses the response to that target. The bot itself is excluded from target detection.

## 7) Headroom — giảm token cho TẤT CẢ AI

Project này đã tích hợp **Headroom** ở lớp context, không khóa vào Claude. Mỗi request AI đi qua lớp nén context trước khi gửi tới provider: OpenAI/ChatGPT, Anthropic/Claude, Gemini và các provider OpenAI-compatible như DeepSeek, Groq, Mistral, OpenRouter, xAI, Together, Fireworks, Cerebras, Perplexity, SambaNova, NVIDIA và provider custom.

Headroom hiện có TypeScript SDK `headroom-ai`. Project dùng trực tiếp API `compress()` chung ở lớp provider-neutral; không phụ thuộc vào một proxy riêng hoặc Claude-only adapter. SharedContext của Headroom cũng được dùng cho handoff giữa agent và giữ bản gốc để lấy lại khi cần. 

### Luồng mới

```text
Discord message
   -> Intent / Language / AI target
   -> Memory + history
   -> Headroom context compression
   -> Provider cụ thể
        ├─ OpenAI / ChatGPT
        ├─ Claude
        ├─ Gemini
        ├─ DeepSeek
        ├─ Groq / Mistral / OpenRouter / ...
        └─ Custom provider
   -> Answer / Debate / Judge
```

### Vì sao không còn "chỉ Claude"

Bot không dùng `withHeadroom()` riêng cho Claude. `src/headroom.js` gọi `compress()` với **model của provider hiện tại** rồi đưa message nén trở lại pipeline chung. Vì vậy khi router chọn DeepSeek thì Headroom nén cho model DeepSeek; khi chọn Gemini thì nén cho Gemini; khi người dùng chỉ đích danh ChatGPT thì nén context trước khi gửi ChatGPT.

### Render

Bản này dùng Docker chỉ cho Node bot; Headroom chạy qua SDK TypeScript ngay trong process, giảm thêm một process Python/proxy không cần thiết. Discord bot vẫn mở HTTP health endpoint ở `PORT` của Render.

Nếu Headroom gặp lỗi kết nối, `HEADROOM_FAIL_OPEN=true` sẽ cho bot gửi context gốc thay vì làm request AI thất bại. Điều này giúp lớp tiết kiệm token không trở thành điểm lỗi duy nhất.

### Theo dõi

Health endpoint `/health` vẫn báo bot đang chạy. Có thể xem thêm trạng thái Headroom trong log/health khi cần mở rộng dashboard thống kê token saved.


## Multi-AI Collaboration v5

Các AI không còn chỉ trả lời độc lập rồi đưa cho Judge. Trong medium/hard mode, các provider tham gia cùng một phòng cộng tác:

- Vòng 1: mỗi AI đưa đề xuất.
- Vòng 2: mỗi AI đọc và phản biện trực tiếp các AI còn lại.
- Vòng 3 (hard): mỗi AI đọc toàn bộ đề xuất + phản biện, sau đó sửa phương án của mình.
- Judge cũng nhận toàn bộ phương án cuối và chọn đáp án tốt nhất.
- Headroom `SharedContext` được dùng làm bộ nhớ trung gian nén cho handoff giữa các AI để giảm lượng context phải gửi lại. Headroom giữ bản gốc để có thể lấy lại khi cần.

AI được chỉ đích danh vẫn được ưu tiên: nếu chỉ định một AI, bot không tự ý đưa nhiệm vụ sang AI khác. Nếu chỉ định nhiều AI, các AI đó cộng tác với nhau.


## v6 — OmniRoute + agentic/human-like layer

This version keeps the existing Vanilla JS/Node.js architecture and adds optional integrations/patterns from several open-source AI projects rather than forcing a new framework into the bot:

- **OmniRoute** — optional universal OpenAI-compatible gateway. Configure `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY`, and `OMNIROUTE_MODEL=auto`; it can route across connected providers and expose fallback/combos behind one endpoint.
- **Headroom** — provider-neutral context compression and shared compressed context between agents.
- **LangGraph-inspired state orchestration** — explicit collaboration phases (proposal → peer critique → revision → judge) without replacing the Node architecture.
- **AutoGen / Microsoft Agent Framework-inspired multi-agent roles** — agents are assigned task roles and exchange messages directly; AutoGen itself is not bundled because its upstream README now recommends Microsoft Agent Framework for new projects.
- **Mem0 / Letta-inspired durable memory** — PostgreSQL now stores a lightweight user communication profile in addition to explicit memories, so the bot can adapt tone and continuity without another LLM call.

### OmniRoute setup

OmniRoute exposes an OpenAI-compatible `POST /v1/chat/completions` endpoint and supports model IDs such as `auto`, provider/model prefixes, and combos. Run OmniRoute separately (for example with Docker or npm), then point this bot at it. The bot treats OmniRoute as one provider; OmniRoute handles the downstream provider routing.

If the user explicitly says `OmniRoute`, it can be selected directly. If `OMNIROUTE_ENABLED=true` but no explicit AI is named, the router may select it as a normal provider.

### Human-like behavior

The bot now keeps three layers separate:
1. original user wording,
2. lightweight language/style interpretation,
3. long-term communication profile.

This means slang/abbreviations can be understood without forcing the AI to imitate slang. The profile records language/style/last intent in PostgreSQL and does not require an extra model call.

## v7 — Full audit / branch pipeline

This revision audits the v6 runtime and separates execution into smaller branches:
- `src/pipeline/branches.js`: branch selection and task branch labels.
- `src/pipeline/execution.js`: direct-target, single, medium collaboration and hard collaboration execution.

### Important fixes
- Fixed the channel queue cleanup bug that could leave a stale lock forever.
- Prevented the current user message from being inserted twice into model history.
- Added provider circuit cooldown after repeated failures.
- Added fallback across available providers for automatic easy tasks.
- Added resilient PostgreSQL startup/retry behavior; a temporary DB outage no longer prevents Discord from starting.
- Added Discord `fetchMe()` fallback when the bot member is not cached.
- Added an actual OmniRoute provider entry when OmniRoute is enabled and configured.
- Added model aliases such as Qwen/Kimi/GLM/MiniMax that can explicitly target OmniRoute when it is enabled.
- Added a Headroom minimum-size gate so tiny prompts do not pay compression latency for negligible savings.
- Added a concurrency limit to multi-AI collaboration rounds.
- Added provider health and DB health to `/health`.

### Branches
`image` → `direct-target` → `single` → `collaborative-2` → `collaborative-3`

Task labels are also tracked independently: coding, research, math, explain, translate, summary, creative, Discord/admin, file-output, target-AI, and language style.

## 6) Ba môi trường agent

Pipeline v9 tách ba môi trường thành các nhánh độc lập:

- **Reasoning Environment**: tạo `decision brief` ngắn gồm mục tiêu, giả định, ràng buộc, hướng giải quyết và tiêu chí kiểm chứng. Đây không phải chain-of-thought riêng tư.
- **Critique Environment**: reviewer độc lập đọc candidate và tìm lỗi, mâu thuẫn, điểm yếu, rồi đưa cách sửa.
- **Test Environment**: kiểm tra tĩnh các output code/JSON và tạo test cases + acceptance criteria. Không tự ý chạy code do người dùng/AI sinh ra.

Mặc định:

```env
REASONING_ENV_ENABLED=true
CRITIQUE_ENV_ENABLED=true
TEST_ENV_ENABLED=true
```

Các môi trường được bật tự động theo loại nhiệm vụ. Chat đơn giản không cần gọi thêm AI; coding/research/math/web và task phức tạp có thể kích hoạt reasoning/critique, còn coding/file-output kích hoạt test.

## 7) Test

```bash
npm test
```

Test suite tập trung vào việc chọn đúng environment branch. End-to-end với Discord, provider API, Headroom, Web và PostgreSQL cần được chạy trong môi trường triển khai thực tế.

## v10 AI Ecosystem Integration

The project now has `src/integrations/ecosystem.js`, a compatibility layer that adopts proven patterns from multiple open-source projects across multi-agent orchestration, evaluation, token optimization, persistent memory, and Discord administration. It intentionally does not bundle Python runtimes into the Node process.

The runtime now adds role plans, lightweight quality gates, professional system guidance, and a local semantic-cache pattern for safe non-time-sensitive requests. Headroom remains the primary live context compressor.
