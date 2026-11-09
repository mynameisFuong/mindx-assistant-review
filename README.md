# MindX Review Assistant

Extension Chrome/Edge đọc nội dung buổi học và danh sách học viên từ MindX LMS. Backend chạy trên máy bạn, gửi nội dung buổi học và dữ liệu đánh giá tới Gemini, rồi trả nhận xét để bạn duyệt hoặc tự lưu vào LMS.

## 1. Khởi động trên Windows

1. Cài Python 3.10+ có lệnh `py` (kiểm tra bằng `py -3 --version`).
2. Tại thư mục dự án, chạy lệnh dưới đây để thử trước. Lần đầu, script tạo môi trường Python riêng, cài thư viện và tạo `backend/.env` nếu chưa có.

   ```powershell
   .\start-review.cmd --mock
   ```

3. Giữ cửa sổ backend mở. Truy cập [trang kiểm tra backend](http://127.0.0.1:8787/health): thử nghiệm sẽ thấy `ok: true` và `mock_mode: true`. Chế độ này sinh nhận xét mẫu, không gọi Gemini và không cho extension lưu các nhận xét mẫu lên LMS.
4. Để dùng Gemini thật, dừng backend bằng **Ctrl+C**. Tạo khóa mới tại [Google AI Studio](https://aistudio.google.com/api-keys). Điền khóa sau dấu `=` trong file **`backend/.env`**. File mẫu `backend/.env.example` chỉ để tham khảo. Nếu từng dùng khóa nằm trong file mẫu cũ hoặc từng commit khóa, hãy thu hồi khóa đó ở nơi đã cấp.
5. Kiểm tra `MXRA_MOCK_GEMINI=0`, rồi nhấp đúp `start-review.cmd` hoặc chạy `.\start-review.cmd`. Trang kiểm tra cần hiện `api_key_configured: true` và `mock_mode: false`. Kiểm tra này chỉ xác nhận đã có cấu hình; bấm **Tạo nhận xét** mới kiểm tra được khóa, quyền truy cập model và hạn mức.

Cấu hình mặc định dùng `gemini-3.5-flash-lite`. Nếu dự án có model khác hỗ trợ JSON, đặt `GEMINI_MODEL` trong `backend/.env` rồi khởi động lại. Backend có thể thử model dự phòng khi model đã chọn không khả dụng hoặc gặp lỗi tạm thời. `start-codex-9router.cmd` là lệnh riêng để mở Codex CLI, không cần chạy cho MindX Review Assistant.

## 2. Nạp extension

1. Mở `chrome://extensions` trong Chrome hoặc `edge://extensions` trong Edge.
2. Bật **Developer mode** → **Load unpacked** → chọn đúng thư mục **`extension`** (có file `manifest.json`). Nếu đã nạp thư mục này, bấm **Reload** trên thẻ extension. Tắt bản cũ nếu đang bật song song.
3. Mở hoặc tải lại [MindX LMS](https://lms.mindx.edu.vn/) bằng **Ctrl+Shift+R**. Mở **✨ MindX AI Review** ở góc dưới bên phải; panel hiển thị **v0.7.2**.

## 3. Tạo và lưu nhận xét

1. Trong LMS, mở lớp → **Nhận xét** → chọn đúng buổi. Mở panel hoặc bấm **Đồng bộ lại từ LMS**. Kiểm tra mã lớp, số buổi và danh sách học viên trước khi tiếp tục.
2. Đọc lại **Nội dung buổi học** từ mục **Tổng kết/Tổng két**. Nếu ô trống hoặc nội dung sai, bấm **Nhập thủ công** rồi gõ/dán nội dung. Muốn lấy lại bản LMS, bấm **Xóa nội dung** rồi đồng bộ lại.
3. Chọn mức đánh giá, tag và ghi chú theo quan sát của bạn. Nếu là checkpoint (C4K buổi **5/9**, ROB hoặc Robotics buổi **4/8**), kiểm tra và chỉnh điểm năng lực **1–5**, thực hành **0–5** và số câu đúng **0–10**. Điểm trong panel ban đầu chỉ là gợi ý theo mức đánh giá; đổi mức sẽ đặt lại các điểm gợi ý.
4. Lần đầu dùng thật, giữ **B — Sinh nhận xét → duyệt → lưu**. Bấm **Tạo nhận xét**, đọc và sửa từng bản nháp. Bạn có thể xóa trắng ô nhận xét của học viên muốn bỏ qua. Bấm **Lưu tất cả**, đợi báo hoàn tất, rồi mở lại một nhận xét trong LMS để đối chiếu.
5. Khi đã kiểm tra cách điền và lưu với loại form của lớp, có thể dùng **C — Sinh nhận xét → tự động lưu**. Nút **Tạo nhận xét** sẽ tạo và bấm **Lưu** cho từng học viên ngay khi nhận kết quả Gemini. Giữ nguyên lớp, buổi và tab trong khi chạy.

Tên học viên từ danh sách được giữ trong trình duyệt. Nội dung buổi học, mã lớp, buổi, ID thứ tự, điểm, tag và ghi chú được gửi tới Gemini. Hãy tránh đưa tên hoặc thông tin riêng của học viên vào nội dung và ghi chú.

## Khi gặp lỗi

| Dấu hiệu | Cách xử lý |
| --- | --- |
| Không thấy nút **MindX AI Review** | Kiểm tra đang ở `lms.mindx.edu.vn`, extension đã bật và đúng thư mục, rồi bấm **Reload** ở trang quản lý extension và tải lại LMS. |
| Không kết nối được backend | Giữ cửa sổ `start-review.cmd` mở và kiểm tra `/health`. Nếu cổng 8787 đang được dùng, đóng cửa sổ backend cũ trước khi khởi động bản mới. |
| Thiếu khóa, khóa sai hoặc lỗi hạn mức | Kiểm tra `backend/.env`, [Google AI Studio](https://aistudio.google.com/) và model được cấp quyền; khởi động lại sau khi sửa. |
| Học viên hoặc buổi không khớp | Chọn lại buổi trong tab **Nhận xét**, đóng form đang mở, bấm **Đồng bộ lại từ LMS** và đối chiếu trước khi tạo/lưu. |
| Dừng ở một học viên hoặc thiếu trường checkpoint | Xem số đã lưu trong panel; mở lại các nhận xét đó để kiểm tra. Xem trường bắt buộc trong form lỗi và điền/lưu thủ công nếu bố cục LMS khác với panel. Khi thử lưu tiếp trong cùng panel, extension bỏ qua nhận xét và điểm đã lưu không đổi. |
| Có nhận xét nhưng không lưu được vì đang thử | Dừng backend đang chạy với `--mock`, chạy lại ở chế độ thật, rồi bấm **Tạo nhận xét** lại. |
