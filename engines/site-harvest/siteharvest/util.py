"""Small shared helpers: slugs, URLs, text, JSON/CSV IO."""

import csv
import hashlib
import json
import os
import re
import unicodedata
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl, urlencode, quote, unquote_plus

TRACKING_PARAMS = {
    "fbclid", "gclid", "msclkid", "yclid", "dclid", "twclid",
    "_ga", "_gl", "mc_cid", "mc_eid", "igshid", "ref_src",
}

# 任何一段路径/文件名只允许这些字符（Kooboo CmsFile 会改写其它字符）
SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def slugify(text, maxlen=60, fallback="site"):
    """ASCII slug；中文等非 ASCII 会被折叠成连字符，所以调用方要准备 fallback。"""
    text = unicodedata.normalize("NFKD", text or "")
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = SAFE_SEGMENT.sub("-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-.")
    return text[:maxlen].strip("-.") or fallback


def package_slug(host):
    host = (host or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return material_slug(host)


def material_slug(name):
    """与资料包插件 scan.ts 的 slugify 保持一致。"""
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-") or "site"


def safe_filename(name, fallback="file", maxlen=80):
    """图片/二进制文件名：必须满足 [A-Za-z0-9._-]，否则 Kooboo 会改写后 404。"""
    name = os.path.basename((name or "").replace("\\", "/"))
    stem, ext = os.path.splitext(name)
    stem = SAFE_SEGMENT.sub("-", stem).strip("-._") or fallback
    ext = SAFE_SEGMENT.sub("", ext).strip(".")
    if ext:
        return "%s.%s" % (stem[:maxlen], ext.lower()[:8])
    return stem[:maxlen]


def norm_text(value):
    if not value:
        return ""
    value = value.replace("\u00a0", " ").replace("\u3000", " ")
    value = re.sub(r"[ \t\r\f\v]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return "\n".join(line.strip() for line in value.split("\n")).strip()


def collapse(value):
    """HTML 里的换行只是空白：段落、标题、列表项都折成单行。"""
    return re.sub(r"\s+", " ", (value or "")).strip()


def is_blank(value):
    return not (value or "").strip()


def text_len(value):
    return len(re.sub(r"\s+", "", value or ""))


def sha1_bytes(data):
    return hashlib.sha1(data).hexdigest()


def sha1_text(text):
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()


def ensure_dir(path):
    if path and not os.path.isdir(path):
        os.makedirs(path, exist_ok=True)
    return path


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    ensure_dir(os.path.dirname(path))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def write_text(path, text):
    ensure_dir(os.path.dirname(path))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    os.replace(tmp, path)


def write_csv(path, header, rows):
    """UTF-8 with BOM，方便人工用 Excel 核对。"""
    ensure_dir(os.path.dirname(path))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        for row in rows:
            writer.writerow(["" if cell is None else cell for cell in row])
    os.replace(tmp, path)


def human_bytes(size):
    size = float(size or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return "%.1f %s" % (size, unit) if unit != "B" else "%d B" % size
        size /= 1024.0


# ---------------------------------------------------------------- URLs

SKIP_SCHEMES = ("mailto:", "tel:", "sms:", "javascript:", "data:", "whatsapp:", "geo:")


def is_http(url):
    return url.lower().startswith(("http://", "https://"))


def canonical_host(host):
    host = (host or "").lower().strip(".")
    if host.startswith("www."):
        host = host[4:]
    return host


def host_of(url):
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def resolve_url(base, href):
    """把 href 解析成绝对 URL；丢弃非 http、锚点、空值。"""
    if not href:
        return ""
    href = href.strip()
    if not href or href.startswith("#"):
        return ""
    low = href.lower()
    if low.startswith(SKIP_SCHEMES):
        return ""
    try:
        absolute = urljoin(base, href)
        parts = urlsplit(absolute)
    except ValueError:
        return ""
    if parts.scheme not in ("http", "https"):
        return ""
    if not parts.hostname:
        return ""
    # 去掉片段；保留原始 query 顺序；编码空格和中文，urllib 只接受 ASCII
    path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(parts.query, safe="=&%:@!$'()*+,;/?-._~")
    return urlunsplit((parts.scheme, parts.netloc.lower(), path, query, ""))


def strip_tracking(url):
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if not parts.query:
        return url
    kept = [part for part in parts.query.split("&")
            if not (unquote_plus(part.split("=", 1)[0]).lower() in TRACKING_PARAMS
                    or unquote_plus(part.split("=", 1)[0]).lower().startswith("utm_"))]
    if len(kept) == len(parts.query.split("&")):
        return url
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(kept), ""))


def url_key(url):
    """仅去掉跟踪参数与片段；不凭惯例合并路由、主机或查询顺序。"""
    try:
        parts = urlsplit(strip_tracking(url))
    except ValueError:
        return url
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(),
                       parts.path or "/", parts.query, ""))


def path_of(url):
    try:
        return urlsplit(url).path or "/"
    except ValueError:
        return "/"


def route_of(url):
    """站点内路由：路径 + 有意义的 query（不改写、不猜测）。"""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "/"
    path = parts.path or "/"
    return path + (("?" + parts.query) if parts.query else "")


def dirname_of(url):
    path = path_of(url)
    return path.rsplit("/", 1)[0] or "/"


def ext_of(url):
    path = path_of(url).lower()
    name = path.rsplit("/", 1)[-1]
    if "." not in name:
        return ""
    return name.rsplit(".", 1)[-1]


def md_escape(text):
    text = (text or "").replace("|", "\\|")
    # 只转义会改变结构的行首标记，别把正文里的 **bold** / [link](...) 弄坏
    text = re.sub(r"^(\s*)(#{1,6}\s|>\s|[-+]\s|\d+\.\s)", r"\1\\\2", text)
    return text


def one_line(text, limit=0):
    text = re.sub(r"\s+", " ", (text or "")).strip()
    if limit and len(text) > limit:
        return text[: limit - 1].rstrip() + "…"
    return text


def indent_lines(text, prefix="  "):
    return "\n".join(prefix + line if line else line for line in text.split("\n"))
