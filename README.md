# Discord AI Council v12.5 – Auto Router + Council + API/Model Recovery

## Chat
- Trong kênh được phép: nhắn **bình thường, không cần @bot** và bot tự phản hồi.
- `@bot` hoặc reply trực tiếp vào bot: chạy **Council**, gọi song song các AI/provider đã cấu hình và chọn câu trả lời tốt nhất.
- Tin nhắn bình thường: tự chấm độ khó DỄ/TRUNG BÌNH/KHÓ và chọn tuyến/model phù hợp.
- Khi model/provider lỗi, bot tự retry, cooldown, refresh model catalog và fallback sang tuyến khác. Không còn bắt người dùng chỉnh model chỉ vì một tuyến lỗi.

## API & MODEL
- Provider registry mở rộng: Gemini, Groq, OpenRouter, DeepSeek, OpenAI, Anthropic, Mistral, xAI, Together, Cerebras, Fireworks, Hugging Face, NVIDIA NIM, SambaNova.
- Chọn provider rồi chỉ nhập API key; Base URL được tự động chọn.
- Model lấy trực tiếp từ endpoint `/models` khi provider hỗ trợ.
- Model được lọc khỏi danh sách nếu metadata/ID cho thấy là subscription-only/consumer-only/Plus/Pro-only; model không chat như embedding/audio/image cũng được loại.
- Có phân trang catalog model (25 model/trang), metadata free/tier/context.

## Render / reliability
- PostgreSQL giữ nguyên và tự migrate schema cũ.
- Provider có health state, latency trung bình, fail count và cooldown.
- API request có timeout, retry cho 429/5xx/timeout.
- `/health` và `/ready` phản hồi nhanh.

## Deploy
Ghi đè code trong GitHub repo hiện tại rồi commit/push. **Không xóa PostgreSQL.**

## Discord
Phải bật `Message Content Intent` trong Discord Developer Portal để bot đọc tin nhắn và phản hồi như chat bình thường.
