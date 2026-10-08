# Báo cáo phân tích & nâng cấp — Discord AI Council (v12.5 → v13.0)

## 1. Phân tích dự án cũ
Bot Node.js (discord.js 14 + PostgreSQL, deploy Render): nhắn thường → tự định tuyến theo độ khó; @bot/reply → "Hội đồng"; `/admin` quản lý API/model/kênh.

**Phát hiện lớn nhất:** ~60% mã nguồn là **mã chết** của kiến trúc cũ (`ai.js`, `router.js`, `collaboration.js`, `web.js`, `pipeline/`, `integrations/`, `config.js`…). `index.js` không import chúng; chúng import các package **không có trong `package.json`** (`openai`, `@anthropic-ai/sdk`, `@google/genai`, `headroom-ai`) và gọi `saveAiRun` **không tồn tại** trong `db.js` → sẽ crash nếu bị gọi. `npm test` cũ cũng không chạy được. → đã chuyển sang `legacy/`, loại khỏi Docker image.

## 2. Lỗi & lỗi tiềm ẩn đã sửa
(✅ = đã chạy tái hiện/test xác nhận · 🔎 = phát hiện qua đọc code, đã có test bao phủ cách sửa)

| # | Mức | Lỗi | Cách sửa |
|---|---|---|---|
| 1 | 🔴 | ✅ Model 70B/405B/120B bị xếp **tầng 1 (nhẹ nhất)** do regex `\d+b`; mô tả model cũng làm phân loại sai | `classifyTier` dựa vào ID + đọc kích thước tham số (8x7b, 30b-a3b…) |
| 2 | 🔴 | ✅ Provider đang cooldown → **mỗi tin nhắn gọi lại `/models`** (timeout 10s×2) làm chậm mọi câu trả lời | Chỉ đồng bộ catalog cho provider khả dụng + negative-cache 60s |
| 3 | 🔴 | 🔎 Lỗi 404/400 của **một model** đặt cả **provider** vào cooldown 60s | Phân loại lỗi: 401→provider; 404/403/400→chỉ model; 429/5xx→backoff theo số lần lỗi |
| 4 | 🔴 | 🔎 Danh sách thử 3 tuyến có thể toàn model của cùng provider đang lỗi | Ưu tiên provider khác nhau trước (`pickAttempts`) |
| 5 | 🔴 | ✅ Regex `\b` không khớp chữ có dấu ("đánh giá", "toàn bộ") → chấm độ khó sai | Biên Unicode `(?<![\p{L}\p{N}])` |
| 6 | 🔴 | 🔎 OpenAI `gpt-5`/o-series từ chối `max_tokens` & `temperature` (400) — trong khi `gpt-5` nằm trong danh sách gợi ý | `max_completion_tokens`, bỏ temperature, thêm ngân sách cho reasoning |
| 7 | 🟠 | ✅ `slice(0,1900)` cắt ngang code block → Markdown vỡ; footer Hội đồng có thể bị cắt | `chunkText` chia nhiều tin, tự đóng/mở lại ``` |
| 8 | 🟠 | 🔎 `allowedMentions:{repliedUser:false}` không chặn `@everyone`/role do AI sinh ra (mention injection) | Chặn ở cấp client: `parse: []` |
| 9 | 🟠 | 🔎 Giải mã key lỗi (đổi `AI_SECRET_KEY`) → **gửi ciphertext đi như API key** | `safeDecrypt` trả rỗng + log rõ; chỉ coi plaintext khi không có định dạng mã hóa |
| 10 | 🟠 | 🔎 Handler admin chặn **mọi** nút/select (cả của chức năng khác) bằng "⛔ không có quyền" | Chỉ xử lý customId có tiền tố `adm_` |
| 11 | 🟠 | 🔎 `timeoutMs` của Hội đồng bị bỏ qua; phải chờ AI chậm nhất | Hạn chót 13s, trả sớm khi đủ ≥3 câu + 1.5s |
| 12 | 🟠 | ✅ Timeout bị coi là lỗi "không tạm thời" (cooldown sai) | `TimeoutError` + `isTransientError` |
| 13 | 🟠 | 🔎 Danh sách model Gemini (50/trang) & Anthropic (20/trang) bị **cắt** | `pageSize=1000` / `limit=1000` |
| 14 | 🟠 | 🔎 Model catalog ≥25 trong "Model đã lưu" không thể bật/tắt (không phân trang) | Phân trang + giữ trang sau khi bật/tắt |
| 15 | 🟠 | 🔎 `rankAnswer` phạt mọi câu có chữ "model"/"api key" (ví dụ hỏi về ML) | Chấm lại: hoàn chỉnh, code, từ chối, bị cắt |
| 16 | 🟡 | 🔎 "Xóa tất cả kênh" lại **bật khóa** → bot câm mọi nơi | Xóa danh sách + tắt khóa |
| 17 | 🟡 | 🔎 Thread không thừa hưởng quyền của kênh cha | `channelAllowedBy` kiểm tra `parentId` |
| 18 | 🟡 | 🔎 Có handler xóa API nhưng **không có nút** nào dẫn tới | Thêm luồng Xóa → chọn → xác nhận |
| 19 | 🟡 | 🔎 Discovery chèn từng model 1 query (60 lần); `addModel` reset `hidden` do admin đặt | `addModelsBulk` (1 query), giữ `enabled/hidden` |
| 20 | 🟡 | 🔎 Gemini API key nằm trong URL (`?key=`) | Header `x-goog-api-key` + `redact` key khỏi thông báo lỗi |
| 21 | 🟡 | 🔎 Model Claude 3.5 trong gợi ý đã ngừng; thiếu lọc `realtime/codex/o1-pro/dall-e…` | Cập nhật gợi ý, mở rộng bộ lọc non-chat |
| 22 | 🟡 | 🔎 Typing indicator chỉ ~10s; không rate-limit → có thể đốt quota; `ephemeral:true` deprecated; health server mở sau khi init DB; không tắt êm khi SIGTERM; `ChannelSelect` hết chỗ thread | Typing định kỳ, cooldown theo user, `MessageFlags.Ephemeral`, mở cổng trước, graceful shutdown, retry initDb |
| 23 | 🟡 | 🔎 Lỗi AI trả nguyên văn (tên provider/HTTP) cho mọi người trong kênh | Thông báo thân thiện; chi tiết chỉ ở log và `/admin` |

## 3. Nâng cấp chức năng
Trí nhớ hội thoại theo kênh · judge tổng hợp cho Hội đồng · nút Hỏi Hội đồng/Làm lại/Xóa · persona · `/ask` `/status` `/clear` · rate-limit + hàng đợi đồng thời · cooldown thông minh · thống kê dùng 7 ngày (`ai_usage`) · đồng bộ model tự động khi lưu key & khi khởi động · gỡ từng kênh · phát hiện câu trả lời bị cắt · lọc `<think>` · hỗ trợ thread · fallback plain-text khi thiếu quyền Embed.

## 4. Nâng cấp giao diện
Embed có màu theo độ khó/Hội đồng, footer provider·model·thời gian · panel `/admin` dạng dashboard (trạng thái 🟢🟡🟠🔴, thanh tiến trình, field) · chọn provider bằng select + trang chi tiết · phân trang model · xác nhận trước khi xóa · mọi thành phần đã kiểm tra với giới hạn Discord (≤5 nút/hàng, ≤25 option, ≤100 ký tự value, embed ≤6000).

## 5. Ý tưởng lấy từ GitHub
- **Valhalla-Development/Ragnarok** — lịch sử hội thoại bền, persona, bảng điều khiển AI, allow-list kênh → trí nhớ kênh, persona, panel.
- **Trungu/PRTS** — cửa sổ ngữ cảnh gần nhất, rate-limit/gates → history + cooldown.
- **mlibre/Unified-AI-Router** — fallback tự động giữa provider → `pickAttempts` + cooldown theo phạm vi.
- **calesthio/Crucix** — `/status`, graceful fallback khi LLM lỗi → `/status`, thông báo lỗi thân thiện.
(Chỉ lấy ý tưởng thiết kế, không sao chép mã; kiểm tra giấy phép riêng của từng repo nếu bạn muốn dùng mã.)

## 6. Cần biết trước khi deploy
- **Chưa chạy được với Discord/PostgreSQL/API thật** (môi trường làm việc không có mạng). Đã kiểm bằng: 39 unit/integration test (HTTP & DB giả lập), smoke test `/admin` (29 tương tác) và `index.js` (10 kịch bản) với stub discord.js có kiểm giới hạn API. Hãy thử trên **server Discord thử nghiệm** trước.
- Cần quyền *Embed Links* (không có thì tự dùng văn bản thường) và **Message Content Intent**.
- Mặc định **khóa kênh đang TẮT** → bot trả lời mọi kênh; nên bật khóa trong `/admin → KÊNH BOT`. (Chưa đổi mặc định để khỏi làm bot im lặng với bản đang chạy.)
- `AI_SECRET_KEY` hiện băm SHA-256 (không KDF); dùng chuỗi ngẫu nhiên dài. Đổi key = phải nhập lại API key.
- Danh sách model gợi ý chỉ là dự phòng; danh sách thật lấy từ API của bạn.
- Render free có thể ngủ → bot offline; cần ping `/health` hoặc nâng gói.
