# Discord AI Council 11.0 — Free-first Admin

Bản Render-first: Discord + Render Web Service + Render PostgreSQL. Chỉ có `/admin`.

## Tính năng
- `/admin` duy nhất, dashboard bằng buttons/selects/modals.
- API/model tự lưu PostgreSQL.
- API key mã hóa AES-256-GCM; key không nằm trong GitHub.
- Model catalog và gợi ý model theo vai trò.
- Free-first metadata để ưu tiên model free-tier.
- Health check provider/model.
- Render Docker + PostgreSQL.

## Cài
1. Tạo PostgreSQL và Web Service trên Render.
2. Thêm `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `AI_SECRET_KEY` và `ADMIN_USER_IDS`/`ADMIN_ROLE_IDS`.
3. Deploy.
4. Vào Discord và gõ `/admin`.
5. Thêm API trước, sau đó thêm model.

`AI_SECRET_KEY` phải là secret dài, ổn định. Đổi key sẽ làm các API key đã mã hóa không giải mã được.

## Lưu ý
Bot không tự cấp API miễn phí. “Free-first” chỉ có nghĩa ưu tiên provider/model mà bạn đã cấu hình và đánh dấu free-tier. Không đưa API key thật vào GitHub.
