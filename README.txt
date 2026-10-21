THUẬN TRUNG v3.3.0

Các thay đổi chính:
- Bỏ 4 thẻ số liệu trên trang chủ.
- Bỏ dải nút lọc nhanh lĩnh vực bên dưới tiêu đề danh mục.
- Bỏ mục Cài đặt và Trợ giúp khỏi nhóm Tiện ích khác trên thanh bên.
- Thêm thanh điều hướng Quay lại / Trang chính ngay trên giao diện.
- Quản trị viên hệ thống có thể xem lại mật khẩu tài khoản con được tạo/đặt lại từ phiên bản 3.3.0.
- Mật khẩu đăng nhập vẫn được lưu dạng bcrypt; bản dùng để xem lại được mã hóa AES-256-GCM bằng khóa dẫn xuất từ AUTH_SECRET.
- Tài khoản con tạo từ phiên bản cũ không thể khôi phục mật khẩu cũ do bcrypt một chiều; cần đặt lại mật khẩu một lần.
- Giữ các tính năng quản trị lĩnh vực, thủ tục, chọn thủ tục có sẵn, xóa mục lớn, phân quyền và lịch sử thay đổi.

Triển khai Vercel:
- server.js
- package.json
- vercel.json
- public/index.html
- public/watch.html

Khuyến nghị: cấu hình AUTH_SECRET dài và ổn định trên Vercel. Nếu đổi AUTH_SECRET, các mật khẩu con đã lưu để xem lại trước đó sẽ không giải mã được.
