# Discord AI Council v12.8 — Admin Chat + Model Controls

Bản này xây trên v12.7/Motapis. Nó giữ PostgreSQL hiện tại, không cần reset database. API key vẫn nằm trong Render Environment; tuyệt đối không gửi key vào Discord/GitHub.

## 1. Thiết lập Render

Mở Render → service `bot-troly` → **Environment**, giữ các biến đang chạy và kiểm tra các biến sau:

```env
DISCORD_TOKEN=...              # Token bot Discord
DISCORD_CLIENT_ID=...          # Application ID của bot
DATABASE_URL=...               # PostgreSQL đang dùng, không thay database
AI_SECRET_KEY=...              # Giữ nguyên key mã hóa đang dùng
MOTAPIS_API_KEY=...            # API key từ Motapis
ADMIN_USER_IDS=...             # Tùy chọn: ID người được phép, nhiều ID ngăn cách bằng dấu phẩy
ADMIN_ROLE_IDS=...             # Tùy chọn: ID role quản trị, nhiều ID ngăn cách bằng dấu phẩy
```

**Không đổi `AI_SECRET_KEY`** nếu PostgreSQL đang chứa API key đã mã hóa từ phiên bản trước. Bot sẽ tự tạo bảng nhật ký quản trị/cảnh cáo còn thiếu khi khởi động; không xóa dữ liệu hiện tại.

Sau khi thay code trên GitHub, commit/push và chờ Render deploy xong.

## 2. Bật Gateway Intents trong Discord

Vào <https://discord.com/developers/applications> → chọn ứng dụng bot → **Bot** → **Privileged Gateway Intents**:

- Bật **Message Content Intent** để bot đọc câu chat bình thường.
- Bật **Server Members Intent** để tìm thành viên theo tên khi cần.
- Bấm **Save Changes**.

Nếu không bật các intent trên, bot có thể không đọc nội dung tin nhắn hoặc không tra cứu thành viên được.

## 3. Cấp quyền cho bot

Mở Server Settings → Roles → role của bot. Cấp tối thiểu các quyền cần dùng:

- View Channels, Send Messages, Read Message History, Embed Links.
- Manage Channels, Manage Roles, Manage Messages.
- Moderate Members, Kick Members, Ban Members.
- View Audit Log, Manage Server nếu muốn đổi tên server/xem audit log.

Đặt role bot **cao hơn các role mà bot cần gán/gỡ/quản lý**. Discord luôn áp dụng role hierarchy và quyền trên từng kênh; code không thể vượt qua giới hạn đó. Không bắt buộc cấp Administrator cho bot nếu đã cấp đúng quyền cần thiết.

Quản trị viên con người phải có quyền **Administrator** trong server, hoặc được thêm vào `ADMIN_USER_IDS` / `ADMIN_ROLE_IDS` trên Render.

## 4. Bật/tắt các model trong `/admin`

1. Gõ `/admin`.
2. Chọn **AI & MODEL**.
3. Bấm **Bật/tắt model**.
4. Chọn model trong menu để đổi trạng thái: 🟢 **BẬT** nghĩa là Auto Router được dùng; ⚪ **TẮT** nghĩa là không được chọn.
5. Có thể bấm **Bật tất cả** hoặc **Tắt tất cả**.
6. Nút **Danh sách/chọn model** dùng để đặt model mặc định; khi chọn một model đang tắt, bot sẽ bật model đó rồi lưu làm mặc định.

Nếu tắt tất cả model, bot không còn model AI nào để trả lời; hãy bật ít nhất một model. Model ID đã được khai báo trong bản này chưa đảm bảo tài khoản Motapis có quyền gọi model đó — quyền thật chỉ xác nhận được bằng API của gateway.

## 5. Quản trị Discord bằng chat bình thường

Trong server, admin chỉ cần gửi một câu tự nhiên; không cần slash command cho các tác vụ dưới đây. Hệ thống gửi câu quản trị qua model Motapis để phân loại intent, đồng thời có parser dự phòng cho câu lệnh thông dụng, tiếng Việt không dấu, từ viết tắt và một số lỗi chính tả. Các hành động phá hủy/yếu tố rủi ro sẽ yêu cầu bấm **Xác nhận thực hiện**; chỉ người đã tạo yêu cầu có thể xác nhận, nút hết hạn sau 2 phút.

### Kênh và tin nhắn

- `khóa kênh này` / `mở khóa kênh này`
- `đổi tên kênh này thành thong-bao`
- `đặt topic kênh này thành Thông báo chính thức`
- `đặt slowmode 5 giây` / `tắt slowmode`
- `tạo kênh text thong-bao`
- `tạo kênh thoại Họp nhóm`
- `tạo category Cộng đồng`
- `xóa kênh #kenh-cu` — cần xác nhận
- `dọn 10 tin nhắn gần nhất` — cần xác nhận; Discord không cho bulk-delete tin cũ hơn 14 ngày
- `liệt kê kênh trong server`

Nếu câu nhắc một kênh cụ thể, hãy tag kênh bằng `#kênh`; nếu không, thao tác kênh thường áp dụng cho kênh hiện tại.

### Thành viên và kiểm duyệt

- `timeout @thanhvien 10 phút vì spam`
- `gỡ timeout @thanhvien`
- `kick @thanhvien vì spam` — cần xác nhận
- `ban @thanhvien vì phá hoại` — cần xác nhận
- `unban 123456789012345678` — cần Discord user ID dạng số
- `đổi nickname @thanhvien thành Người mới`
- `cảnh cáo @thanhvien vì spam link`
- `xem cảnh cáo @thanhvien`
- `xóa cảnh cáo @thanhvien` — cần xác nhận
- `thông tin thành viên @thanhvien`

Cảnh cáo do bot ghi vào PostgreSQL và sẽ còn sau khi Render restart. Đây là nhật ký riêng của bot; nó không tự tạo bản ghi cảnh cáo trong hệ thống Discord gốc.

### Role và server

- `tạo role VIP`
- `gán role VIP cho @thanhvien`
- `gỡ role VIP khỏi @thanhvien`
- `xóa role VIP` — cần xác nhận
- `liệt kê role`
- `thông tin server`
- `xem audit log 10`
- `đổi tên server thành Tên mới` — cần xác nhận

Role/tag thành viên nên được mention rõ ràng nếu có người/role trùng tên. Bot không thể quản lý chủ server, role được tích hợp, hoặc thành viên/role ngang cao hơn role cao nhất của bot.

## 6. Phạm vi và giới hạn

Bản này thêm bộ quản trị hội thoại cho nhóm chức năng phổ biến: kênh, tin nhắn, role, timeout/kick/ban, cảnh cáo, biệt danh, thông tin server/thành viên, audit log, cộng với xác nhận hành động nguy hiểm và kiểm tra quyền bot.

Discord có nhiều hệ thống độc lập (ví dụ webhook, integrations, AutoMod nâng cao, onboarding, scheduled events, subscription/monetization, soundboard, stickers/emojis, ticket workflows). Bản này **không tuyên bố đã triển khai toàn bộ mọi API/feature Discord hay mọi module của các bot quản trị khác**. Những nhóm tính năng đó cần module, quyền và kiểm thử riêng.

## 7. Kiểm tra

Chạy kiểm tra cú pháp source:

```bash
npm run check
```

Sau deploy, xem Render Logs để tìm `✅ Bot online`, `✅ /admin đã sẵn sàng` và lỗi `❌`. Thử quản trị bằng admin trước; nếu Discord trả `Missing Permissions`, cấp đúng quyền và chỉnh role hierarchy. Không xóa PostgreSQL để xử lý lỗi triển khai.


## v12.8.1 hotfix: Render schema migration
Nếu log Render báo `column updated_at of relation ai_settings does not exist`, hãy cập nhật source v12.8.1 và redeploy. Migration tự thêm cột còn thiếu và điền timestamp cho hàng cũ; không xóa bảng hoặc dữ liệu.
