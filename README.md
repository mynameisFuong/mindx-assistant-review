# MindX Review Assistant v0.6

## Thay đổi ở v0.6

### Hỗ trợ form checkpoint
Extension tự nhận diện các buổi checkpoint:

- C4K: buổi `#5` và `#9`
- ROB/Robotics: buổi `#4` và `#8`

Khi là buổi checkpoint, panel sẽ hiện thêm các trường cho từng học viên:

- Điểm năng lực: dùng để chọn các radio 1-5 trong nhóm tiêu chí.
- Thực hành: nhập vào ô `Điểm thực hành`.
- Trắc nghiệm đúng: tick số câu checkpoint tương ứng.

Khi lưu, extension điền các trường checkpoint trước, sau đó điền đúng ô **Đánh giá chung** và bấm **Lưu** như form thường.

Bản sửa tập trung vào đúng lỗi của LMS MindX hiện tại.

## Thay đổi ở v0.5

### 1. Đọc được cả “Tổng kết” và lỗi chính tả “Tổng két”
MindX LMS có màn hình hiển thị tiêu đề **Tổng két** thay vì **Tổng kết**. Extension giờ chuẩn hóa dấu tiếng Việt trước khi nhận diện tiêu đề, vì vậy các biến thể sau đều được nhận:

- `Tổng kết`
- `Tổng két`
- `TỔNG KẾT`
- `TỔNG KÉT`

Sau khi tìm được tiêu đề, extension lấy phần nội dung nằm trước **Bài về nhà** như trước.

### 2. Ô “Nội dung buổi học” luôn nhập thủ công được
- textarea được bật tương tác rõ ràng (`pointer-events`, `focus`, `user-select`);
- chặn listener click/keydown của LMS truyền xuyên qua panel;
- thêm nút **✍ Nhập thủ công** để focus thẳng vào ô;
- có thể gõ hoặc paste nội dung trực tiếp;
- nội dung thủ công không bị xóa khi đồng bộ LMS thất bại.

### 3. Đồng bộ vẫn ưu tiên LMS
Nếu đọc được **Tổng kết/Tổng két**, badge hiển thị `Nguồn: LMS`.
Nếu không đọc được, bạn có thể dùng **✍ Nhập thủ công**, badge chuyển thành `Nguồn: nhập thủ công`.

## Cài đặt

1. Tắt/xóa extension cũ trong `chrome://extensions`.
2. Bật **Developer mode**.
3. **Load unpacked** và chọn thư mục `extension` của bản v0.5.
4. Refresh LMS bằng `Cmd + Shift + R` (Mac) hoặc `Ctrl + Shift + R` (Windows).
5. Kiểm tra badge trên panel phải là **v0.6**.

Backend Gemini giữ nguyên như v0.4; không cần cài lại nếu backend hiện tại vẫn chạy.
