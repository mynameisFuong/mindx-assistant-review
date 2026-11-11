"""Catch common unaccented Vietnamese in generated education text."""
import json
import re
import unicodedata
from difflib import SequenceMatcher


class VietnameseTextError(ValueError):
    pass


# Detect phrases, not isolated ASCII words: names such as Python, Scratch and
# Game Maker, code and URLs must remain intact. Check every generated field so
# accented headings cannot conceal an unaccented paragraph underneath them.
_PHRASES = (
    "trong buoi hoc", "noi dung", "buoi hoc", "cac con", "cac ban", "hoc vien",
    "phu huynh", "giao vien", "thao luan", "lap rap", "mo hinh", "huong dan",
    "thuc hien", "thuc hanh", "lap trinh", "vong lap", "the lenh", "cau lenh",
    "kien thuc", "ky nang", "san pham", "du an", "nang cap", "hoan thien",
    "hoan thanh", "kiem thu", "kiem tra", "sua loi", "on tap", "on lai",
    "tap trung", "chu dong", "can than", "tu duy", "thuoc tinh", "phuong thuc",
    "doi tuong", "cai thien", "diem manh", "loi khuyen", "dan do", "nhan xet",
    "chu de", "vuon bach thu", "su dung", "phan cung", "phan mem", "dieu khien",
    "chuc nang", "tiep tuc", "thoi gian", "trao doi", "phat trien", "van dung",
    "nho hon", "tot hon", "muc tieu", "tien do", "tien bo", "nang luc",
)
_UNACCENTED = re.compile(r"(?<!\w)(?:" + "|".join(map(re.escape, _PHRASES)) + r")(?!\w)", re.I)


def has_unaccented_vietnamese(text):
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"https?://\S+|`[^`]*`", " ", text)
    return bool(_UNACCENTED.search(re.sub(r"\s+", " ", text)))


def _normalize(value):
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize(item) for key, item in value.items()}
    return value


def _needs_repair(value):
    if isinstance(value, str):
        return has_unaccented_vietnamese(value)
    if isinstance(value, list):
        return any(_needs_repair(item) for item in value)
    if isinstance(value, dict):
        return any(_needs_repair(item) for item in value.values())
    return False


def _without_accents(text):
    text = unicodedata.normalize("NFD", text).replace("đ", "d").replace("Đ", "D")
    return re.sub(r"\s+", " ", "".join(c for c in text if not unicodedata.combining(c))).strip()


def _same_content(before, after):
    if type(before) is not type(after):
        return False
    if isinstance(before, str):
        # Protect URLs exactly, including query parameters and case.
        if re.findall(r"https?://\S+", before) != re.findall(r"https?://\S+", after):
            return False
        return _without_accents(before) == _without_accents(after)
    if isinstance(before, dict):
        return before.keys() == after.keys() and all(_same_content(before[key], after[key]) for key in before)
    if isinstance(before, list):
        return len(before) == len(after) and all(_same_content(a, b) for a, b in zip(before, after))
    return before == after


def _merge_accents(before, after):
    """Take only added accents; retain original words, punctuation and facts."""
    if type(before) is not type(after):
        raise VietnameseTextError("Bước sửa dấu trả sai cấu trúc. Hãy tạo lại nhận xét.")
    if isinstance(before, str):
        original = list(re.finditer(r"\w+", before))
        suggested = list(re.finditer(r"\w+", after))
        protected = [m.span() for m in re.finditer(r"https?://\S+|`[^`]*`", before)]
        matcher = SequenceMatcher(None,
            [_without_accents(m.group()).casefold() for m in original],
            [_without_accents(m.group()).casefold() for m in suggested], autojunk=False)
        replacements = {}
        for a, b, size in matcher.get_matching_blocks():
            for offset in range(size):
                old, new = original[a + offset], suggested[b + offset].group()
                if any(start <= old.start() < end for start, end in protected):
                    continue
                def accent_count(text):
                    return sum(unicodedata.combining(c) != 0 or c in 'đĐ' for c in unicodedata.normalize('NFD', text))
                if accent_count(new) <= accent_count(old.group()):
                    continue
                if old.group().isupper():
                    new = new.upper()
                elif old.group().islower():
                    new = new.lower()
                elif old.group().istitle():
                    new = new[0].upper() + new[1:].lower()
                replacements[old.start()] = new
        pieces, end = [], 0
        for word in original:
            pieces.extend((before[end:word.start()], replacements.get(word.start(), word.group())))
            end = word.end()
        return ''.join(pieces) + before[end:]
    if isinstance(before, dict):
        if before.keys() != after.keys():
            raise VietnameseTextError("Bước sửa dấu trả sai cấu trúc. Hãy tạo lại nhận xét.")
        return {key: _merge_accents(before[key], after[key]) for key in before}
    if isinstance(before, list):
        if len(before) != len(after):
            raise VietnameseTextError("Bước sửa dấu trả sai số nhận xét. Hãy tạo lại nhận xét.")
        return [_merge_accents(a, b) for a, b in zip(before, after)]
    if before != after:
        raise VietnameseTextError("Bước sửa dấu thay đổi ID hoặc số liệu. Hãy tạo lại nhận xét.")
    return before


REPAIR_RULES = """
Bạn chỉ khôi phục dấu tiếng Việt cho các giá trị văn bản trong JSON được cung cấp.
Viết tiếng Việt đầy đủ dấu, đúng chính tả. Không viết lại câu, không thêm/bớt/đổi từ.
Giữ nguyên chữ hoa/chữ thường, dấu câu, Markdown, số liệu, ID, thứ tự và số phần tử.
Giữ nguyên mọi URL, tên riêng và thuật ngữ tiếng Anh như Python, Scratch, Game Maker.
Chỉ bổ sung dấu vào từ tiếng Việt còn thiếu dấu; không thay đổi phần đã viết đúng.
Trả đúng cấu trúc JSON đầu vào theo schema yêu cầu, không kèm lời giải thích.
""".strip()


def repair_prompt(data):
    return "Bổ sung dấu tiếng Việt cho JSON này, giữ nguyên nội dung:\n" + json.dumps(data, ensure_ascii=False)


def ensure_vietnamese_json(data, repair):
    data = _normalize(data)
    if not _needs_repair(data):
        return data
    fixed = _merge_accents(data, _normalize(repair(data)))
    if not _same_content(data, fixed):
        raise VietnameseTextError("Bước sửa dấu đã thay đổi nội dung. Hãy tạo lại nhận xét.")
    if _needs_repair(fixed):
        raise VietnameseTextError("AI vẫn trả đoạn tiếng Việt thiếu dấu sau khi sửa. Hãy tạo lại nhận xét.")
    return fixed
