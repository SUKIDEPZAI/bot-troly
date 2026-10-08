# Discord AI Council v13

Bot Discord đa AI: **nhắn bình thường** → tự chấm độ khó và chọn model phù hợp; **@bot / reply bot** → **Hội đồng** nhiều AI trả lời song song rồi *judge* tổng hợp thành một đáp án.

## Tính năng
- **Auto Route**: chấm độ khó (DỄ/TB/KHÓ) → chọn tầng model; ưu tiên model miễn phí (tùy chọn); tự fallback qua provider khác khi lỗi.
- **Hội đồng + Judge**: gọi tối đa 5 AI song song (có hạn chót), một AI nhanh nhất tổng hợp đáp án; lỗi judge → chọn câu tốt nhất theo chấm điểm.
- **Trí nhớ hội thoại theo kênh** (RAM, 20 phút), nhớ ai đang nói; nút **🧠 Hỏi Hội đồng / 🔄 Làm lại / 🗑️ Xóa** dưới mỗi câu trả lời.
- **Persona**: Mặc định / Chuyên nghiệp / Vui vẻ / Giảng viên / Lập trình viên.
- **Sức khỏe provider/model**: cooldown đúng phạm vi (key sai → cả provider; model bị xóa → chỉ model đó), backoff theo số lần lỗi.
- **Slash**: `/ask` · `/status` · `/clear` · `/admin`.
- **/admin** (embed + select + phân trang): API (nhập/đổi/kiểm tra/xóa), đồng bộ model, bật/tắt model, kênh (thêm/gỡ), định tuyến, persona, kiểm tra, thống kê 7 ngày.
- 14 provider: Gemini, Groq, OpenRouter, DeepSeek, OpenAI, Anthropic, Mistral, xAI, Together, Cerebras, Fireworks, Hugging Face, NVIDIA NIM, SambaNova. API key mã hóa AES-256-GCM.

## Cài đặt
1. Discord Developer Portal → bật **Message Content Intent**; mời bot với quyền *View Channel, Send Messages, Read Message History, Embed Links*.
2. Sao chép `.env.example` → `.env` và điền giá trị.
3. `npm install && npm start` (cần PostgreSQL). Test: `npm test`.
4. Trong Discord: `/admin` → 🔑 API → chọn provider → dán key → bot tự đồng bộ model.

## Deploy Render
Ghi đè code vào repo → push. **Không xóa PostgreSQL.** Schema tự migrate (thêm bảng `ai_usage`).
> Lưu ý: gói `free` của Render có thể ngủ khi không có truy cập HTTP (bot sẽ offline) — dùng dịch vụ ping `/health` hoặc nâng gói; kiểm tra thêm chính sách hạn dùng của PostgreSQL free.

## Cấu trúc
```
src/index.js      Discord I/O, slash, nút, health server, vòng đời
src/chat.js       ghép prompt + lịch sử + giới hạn đồng thời
src/engine.js     routedChat / councilChat / judge
src/routing.js    chấm độ khó, xếp hạng model (thuần, có test)
src/health.js     cooldown provider/model trong RAM
src/providers.js  14 provider, build request/parse, catalog
src/admin.js      bảng /admin        src/ui.js  theme & embed
src/db.js         PostgreSQL         src/settings.js  cache cấu hình
legacy/           mã v11 không còn dùng (xem legacy/README.md)
```
