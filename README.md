# Discord AI Council 12.0 — API/Model Fix

## Điểm sửa chính
- Sửa lỗi HTTP 404 do endpoint API bị ghép sai.
- Provider có endpoint riêng cho model và chat.
- Gemini dùng `/v1beta/models?key=...` và `models/{id}:generateContent`.
- OpenAI/Groq/OpenRouter dùng `/v1/models` và `/v1/chat/completions` theo provider.
- DeepSeek dùng base `https://api.deepseek.com`, model list `/models`, chat `/chat/completions`.
- Anthropic dùng `/v1/models` và `/v1/messages`.
- Tab AI & MODEL gọi danh sách model thật từ API sau khi chọn provider.
- Nếu API không hỗ trợ model discovery hoặc tạm lỗi, hệ thống fallback sang model đã lưu/gợi ý.
- Model được lưu kèm mô tả.
- API key mã hóa AES-256-GCM trong PostgreSQL.
- Có khóa kênh bot và hàm `isChannelAllowed(channelId)` để dùng trước khi phản hồi.
- `/admin` được đăng ký sau `ready`.

## Deploy
Up toàn bộ project này lên GitHub và redeploy Render. Giữ nguyên PostgreSQL hiện tại; schema tự migrate bằng `CREATE IF NOT EXISTS` và `ALTER TABLE ... IF NOT EXISTS`.
