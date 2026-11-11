"""Homework rules derived from the MindX class code."""
import re
import unicodedata


def course_family(course_name):
    name = str(course_name or '').upper()
    if re.search(r'(?:^|[-_\s])ROB(?:OTICS)?(?=$|[-_\s]|\d)', name):
        return 'ROB'
    if re.search(r'(?:^|[-_\s])C4K(?=$|[-_\s]|\d)', name):
        return 'C4K'
    return ''


def course_homework_rules(course_name):
    family = course_family(course_name)
    if family == 'ROB':
        return (
            'Đây là lớp ROB (Robotics). Lớp KHÔNG CÓ BÀI TẬP VỀ NHÀ. '
            'Không giao bài, không nhắc làm/nộp/hoàn thành bài tập trên Denise. '
            'Không yêu cầu con lắp ráp, lập trình, mở lại dự án hoặc ôn/luyện tập ở nhà. '
            'Lời khuyên/dặn dò chỉ hướng tới buổi học tiếp theo: thực hành thêm tại lớp, '
            'trao đổi với thầy khi chưa rõ và chuẩn bị đi học đúng giờ. '
            'Trong tổng kết phụ huynh, trả homework là [] nếu không có dặn dò chuẩn bị buổi sau.'
        )
    if family == 'C4K':
        return (
            'Đây là lớp C4K (Code for Kid), có bài tập về nhà trên Denise. '
            'Lời khuyên/dặn dò cần nhắc con kiểm tra và hoàn thành bài tập đã được giao trên Denise. '
            'Chỉ nêu đề bài cụ thể hoặc hạn nộp khi đầu vào có thông tin; không tự bịa thêm bài tập.'
        )
    return 'Chưa xác định hệ lớp. Không tự suy đoán có bài tập về nhà hoặc có dùng Denise; chỉ bám dặn dò được cung cấp.'


def robotics_homework_conflict(text):
    text = unicodedata.normalize('NFD', text).lower().replace('đ', 'd')
    text = ''.join(c for c in text if not unicodedata.combining(c))
    return bool(re.search(r'\b(?:denise|bai tap ve nha|o nha|ve nha|lam bai|nop bai)\b', text))
