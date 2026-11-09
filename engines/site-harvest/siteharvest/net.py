"""HTTP fetching for legacy sites: redirect chains, encoding, retries, politeness."""

import gzip
import io
import os
import re
import shutil
import socket
import subprocess
import tempfile
import ssl
import threading
import time
import urllib.error
import urllib.request
import zlib
from urllib.parse import urljoin

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 site-harvest/1.0"
)

HTML_TYPES = ("text/html", "application/xhtml+xml")


class Response(object):
    def __init__(self, url):
        self.url = url
        self.final_url = url
        self.status = 0
        self.headers = {}
        self.content_type = ""
        self.charset = ""
        self.body = b""
        self.text = ""
        self.chain = []
        self.error = ""
        self.tls_insecure = False
        self.bytes = 0
        self.elapsed = 0.0

    @property
    def ok(self):
        return 200 <= self.status < 300 and not self.error

    @property
    def is_html(self):
        ctype = (self.content_type or "").lower()
        return any(ctype.startswith(item) for item in HTML_TYPES) or (
            not ctype and self.text.lstrip()[:1] == "<"
        )

    def header(self, name):
        for key, value in self.headers.items():
            if key.lower() == name.lower():
                return value
        return ""

    def to_meta(self):
        return {
            "url": self.url,
            "finalUrl": self.final_url,
            "status": self.status,
            "contentType": self.content_type,
            "charset": self.charset,
            "bytes": self.bytes,
            "error": self.error,
            "tlsInsecure": self.tls_insecure,
            "chain": self.chain,
        }


class _RedirectRecorder(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        self.chain = []

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.chain.append({"from": req.full_url, "status": code, "to": newurl})
        return urllib.request.HTTPRedirectHandler.redirect_request(
            self, req, fp, code, msg, headers, newurl
        )


def _decode(raw, content_type):
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8", "replace"), "utf-8-sig"
    declared = ""
    match = re.search(r'charset\s*=\s*["\']?([\w.:-]+)', content_type or "", re.I)
    if match:
        declared = match.group(1).strip()
    if not declared:
        head = raw[:4096].decode("latin-1", "ignore")
        match = re.search(r'<meta[^>]+charset\s*=\s*["\']?([\w.:-]+)', head, re.I)
        if match:
            declared = match.group(1).strip()

    # 现代站大多是 UTF-8，即使 meta 写错；先试严格 UTF-8 能避免把 UTF-8 当 GBK 解码。
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        pass

    candidates = []
    if declared:
        candidates.append(declared)
    candidates.extend(["gb18030", "big5", "shift_jis", "euc-kr", "windows-1252"])
    for charset in candidates:
        try:
            return raw.decode(charset), charset
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", "replace"), "utf-8"


def _read_body(response, limit):
    """超限或读失败必须显式失败，不能把截断页面/文档当成成功。"""
    raw = response.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("response-too-large: limit=%d" % limit)
    encoding = (response.headers.get("Content-Encoding") or "").lower()
    if encoding == "gzip" or raw[:2] == b"\x1f\x8b":
        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read(limit + 1)
    elif encoding == "deflate":
        try:
            decoder = zlib.decompressobj()
            raw = decoder.decompress(raw, limit + 1)
        except zlib.error:
            decoder = zlib.decompressobj(-zlib.MAX_WBITS)
            raw = decoder.decompress(raw, limit + 1)
        if decoder.unconsumed_tail:
            raise ValueError("response-too-large: limit=%d" % limit)
    if len(raw) > limit:
        raise ValueError("response-too-large: limit=%d" % limit)
    return raw


class Fetcher(object):
    def __init__(self, delay=0.3, timeout=25, retries=2, max_bytes=8 * 1024 * 1024):
        self.delay = max(0.0, float(delay))
        self.timeout = timeout
        self.retries = retries
        self.max_bytes = max_bytes
        self._lock = threading.Lock()
        self._next_at = 0.0
        self._insecure_context = ssl._create_unverified_context()

    def _wait(self):
        if self.delay <= 0:
            return
        with self._lock:
            now = time.monotonic()
            wait = self._next_at - now
            self._next_at = max(now, self._next_at) + self.delay
        if wait > 0:
            time.sleep(wait)

    def _request(self, url, referer, insecure, timeout=None):
        context = self._insecure_context if insecure else None
        handlers = []
        recorder = _RedirectRecorder()
        handlers.append(recorder)
        if context is not None:
            handlers.append(urllib.request.HTTPSHandler(context=context))
        opener = urllib.request.build_opener(*handlers)
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept-Encoding": "identity",
        }
        if referer:
            headers["Referer"] = referer
        request = urllib.request.Request(url, headers=headers)
        try:
            return opener.open(request, timeout=timeout or self.timeout), recorder, ""
        except urllib.error.HTTPError as error:
            return error, recorder, ""
        except urllib.error.URLError as error:
            reason = getattr(error, "reason", error)
            text = str(reason)
            if "CERTIFICATE_VERIFY_FAILED" in text.upper() or "SSL" in text.upper():
                return None, recorder, "tls:" + text
            return None, recorder, text
        except (socket.timeout, TimeoutError) as error:
            return None, recorder, "timeout:" + str(error)
        except (ConnectionError, OSError) as error:
            return None, recorder, str(error)

    def fetch(self, url, referer="", binary=False, max_bytes=None, retries=None, timeout=None):
        limit = max_bytes or self.max_bytes
        attempts = (self.retries if retries is None else retries) + 1
        last = Response(url)
        for attempt in range(attempts):
            self._wait()
            started = time.time()
            response, recorder, error = self._request(url, referer, False, timeout)
            insecure_used = False
            if response is None and error.startswith("tls:"):
                response, recorder, error = self._request(url, referer, True, timeout)
                insecure_used = response is not None
            last.elapsed = time.time() - started
            last.chain = list(recorder.chain)

            if response is None:
                last.error = error or "request failed"
                last.status = 0
                if attempt + 1 < attempts:
                    time.sleep(1.0 + attempt)
                    continue
                return last

            status = getattr(response, "status", None) or getattr(response, "code", 0)
            last.status = int(status or 0)
            last.headers = dict(response.headers.items()) if response.headers else {}
            last.content_type = (response.headers.get("Content-Type") or "") if response.headers else ""
            last.final_url = response.geturl() if hasattr(response, "geturl") else url
            last.tls_insecure = insecure_used
            try:
                raw = _read_body(response, limit)
            except (ValueError, OSError, EOFError, zlib.error) as error:
                last.error = str(error)
                return last
            finally:
                try:
                    response.close()
                except Exception:
                    pass
            last.bytes = len(raw)
            # Retain the undecoded, decompressed response body as distinct evidence.
            last.body = raw

            if not binary:
                last.text, last.charset = _decode(raw, last.content_type)

            retryable = last.status in (408, 425, 429, 500, 502, 503, 504)
            if retryable and attempt + 1 < attempts:
                time.sleep((2.0 if last.status == 429 else 1.0) * (attempt + 1))
                continue
            return last
        return last


def parse_robots(text):
    """极简 robots：把内容按 User-agent 分组，只取 * 组的规则，外加所有 Sitemap。"""
    sitemaps = []
    groups = []          # [{"agents": [...], "disallow": [...], "allow": [...]}]
    current = None
    for raw in (text or "").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower()
        value = value.strip()
        if key == "user-agent":
            if current is None or current["rules"]:
                current = {"agents": [], "rules": False, "disallow": [], "allow": []}
                groups.append(current)
            current["agents"].append(value.lower())
        elif key == "sitemap":
            if value:
                sitemaps.append(value)
        elif key in ("allow", "disallow") and value:
            if current is None:
                current = {"agents": ["*"], "rules": False, "disallow": [], "allow": []}
                groups.append(current)
            current["rules"] = True
            (current["allow"] if key == "allow" else current["disallow"]).append(value)

    disallow = []
    allow = []
    for group in groups:
        if "*" in group["agents"]:
            disallow.extend(group["disallow"])
            allow.extend(group["allow"])
    return {
        "sitemaps": list(dict.fromkeys(sitemaps)),
        "disallow": list(dict.fromkeys(disallow)),
        "allow": list(dict.fromkeys(allow)),
    }


CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
    "chromium-browser",
]


def find_chrome():
    for candidate in CHROME_CANDIDATES:
        if os.path.sep in candidate:
            if os.path.exists(candidate):
                return candidate
        else:
            found = shutil.which(candidate)
            if found:
                return found
    return ""


class ChromeFetcher(object):
    """用系统 Chrome 的 --dump-dom 抓渲染后的 DOM。二进制仍走普通 HTTP。"""

    def __init__(self, delay=0.3, timeout=90, virtual_time=8000):
        self.base = Fetcher(delay=delay, timeout=min(timeout, 30))
        self.timeout = timeout
        self.virtual_time = virtual_time
        self.chrome = find_chrome()
        if not self.chrome:
            raise RuntimeError("找不到 Chrome/Chromium，不能用 --browser")

    def fetch(self, url, referer="", binary=False, max_bytes=None, retries=None, timeout=None):
        if binary:
            return self.base.fetch(url, referer=referer, binary=True, max_bytes=max_bytes, retries=retries)
        last = self.base.fetch(url, referer=referer, retries=retries, timeout=timeout)
        if not last.ok or not last.is_html:
            return last
        profile = tempfile.mkdtemp(prefix="site-harvest-chrome-")
        command = [
            self.chrome, "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
            "--window-size=1440,900", "--virtual-time-budget=%d" % self.virtual_time,
            "--user-data-dir=" + profile, "--dump-dom", last.final_url,
        ]
        try:
            for attempt in range(2):
                try:
                    result = subprocess.run(command, capture_output=True,
                                            timeout=timeout or self.timeout)
                except subprocess.TimeoutExpired:
                    last.status = 0
                    last.error = "chrome-timeout"
                    continue
                text = (result.stdout or b"").decode("utf-8", "replace")
                if text.strip() and result.returncode == 0 and "chrome-error://" not in text:
                    last.text = text
                    last.body = text.encode("utf-8")
                    last.bytes = len(last.body)
                    last.content_type = "text/html"
                    last.charset = "utf-8"
                    last.browser_rendered = True
                    last.error = ""
                    return last
                last.status = 0
                last.error = "empty-dom: " + (result.stderr or b"").decode("utf-8", "replace")[-300:]
                time.sleep(1 + attempt)
        finally:
            shutil.rmtree(profile, ignore_errors=True)
        return last
