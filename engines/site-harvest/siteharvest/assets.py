"""Content assets with bounded downloads, provenance, and safe cache reuse."""

import os
import re
from collections import deque
from lxml import etree

from . import util

IMAGE_EXTS = {"jpg", "jpeg", "png", "gif", "webp", "svg", "avif", "bmp", "ico", "tif", "tiff"}
FILE_EXTS = {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "txt", "rtf", "zip", "rar", "7z", "epub"}
MIME_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
            "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tif",
            "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "application/pdf": "pdf"}
TRACKER_RE = re.compile(r"(google-analytics|googletagmanager|doubleclick|facebook\.com/tr|/pixel|spacer|blank\.gif)", re.I)
CSS_URL_RE = re.compile(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", re.I)
CSS_IMPORT_RE = re.compile(r"@import\s+(?:url\(\s*)?['\"]?([^'\"\s);]+)", re.I)


def _ext_from_mime(content_type, fallback_url=""):
    ctype = (content_type or "").split(";")[0].strip().lower()
    if ctype in ("text/html", "application/xhtml+xml"):
        return ""
    if ctype in MIME_EXT:
        return MIME_EXT[ctype]
    ext = util.ext_of(fallback_url)
    return ("jpg" if ext == "jpeg" else ext) if ext in IMAGE_EXTS else ""


def _dimensions(data):
    try:
        from PIL import Image
        import io
        with Image.open(io.BytesIO(data)) as image:
            return image.width, image.height
    except Exception:
        return 0, 0


def _image_ext(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    if data.startswith(b"BM"):
        return "bmp"
    if data.startswith((b"II*\x00", b"MM\x00*")):
        return "tif"
    if data.startswith(b"\x00\x00\x01\x00"):
        return "ico"
    if data[4:8] == b"ftyp" and (data[8:12] in (b"avif", b"avis") or b"avif" in data[8:40]):
        return "avif"
    try:
        root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
        return "svg" if etree.QName(root).localname == "svg" else ""
    except (etree.XMLSyntaxError, ValueError):
        return ""


def _unique_path(path, taken):
    stem, ext = os.path.splitext(path)
    candidate, index = path, 2
    while candidate in taken:
        candidate = "%s-%d%s" % (stem, index, ext)
        index += 1
    return candidate


def collect_plan(state, out_dir):
    images, documents, stylesheets = [], [], []
    seen_images, seen_docs = set(), set()

    def add(target, seen, url, page, **extra):
        key = util.url_key(url)
        if not url or not util.is_http(url) or key in seen:
            return
        seen.add(key)
        entry = dict(extra)
        entry.update(url=url, pageId=page["id"], pageUrl=page["url"],
                     pageSlug=page.get("pageSlug", page["id"]))
        target.append(entry)

    pages = [r for r in state["urls"].values() if r["action"] == "keep"]
    for record in pages:
        data = util.read_json(os.path.join(out_dir, ".work", "extract", record["id"] + ".json")) or {}
        for image in data.get("images", []):
            add(images, seen_images, image["url"], record,
                **{k: v for k, v in image.items() if k != "url"})
        for link in data.get("links", []):
            if util.ext_of(link["url"]) in FILE_EXTS:
                add(documents, seen_docs, link["url"], record, text=link.get("text", ""))
        for url in data.get("stylesheets", []):
            stylesheets.append(dict(url=url, page=record))
    for record in state["urls"].values():
        if record.get("reason") not in ("asset", "non-html") or not pages:
            continue
        ext = util.ext_of(record["url"])
        ctype = record.get("contentType", "").split(";")[0].lower()
        if ext in IMAGE_EXTS or ctype.startswith("image/"):
            add(images, seen_images, record["url"], pages[0], where="discovery")
        elif ext in FILE_EXTS or ctype in ("application/pdf", "application/octet-stream"):
            add(documents, seen_docs, record["url"], pages[0], text="")
    state["imagePlan"], state["documentPlan"], state["stylesheetPlan"] = images, documents, stylesheets
    return images, documents


def collect_css_images(state, fetcher):
    """Read CSS only to discover images; layout and fonts stay outside the package."""
    images = state["imagePlan"]
    image_keys = {util.url_key(i["url"]) for i in images}
    queue = deque(state.get("stylesheetPlan", []))
    seen, evidence = set(), []
    limit = state["limits"].get("maxStylesheets", 100)
    while queue and len(seen) < limit:
        item = queue.popleft()
        key = util.url_key(item["url"])
        if key in seen:
            continue
        seen.add(key)
        try:
            response = fetcher.fetch(item["url"], referer=item["page"]["url"], max_bytes=1024**2)
            if not response.ok or not response.text or response.is_html:
                raise ValueError(response.error or "http-%s / not-css" % response.status)
            text = re.sub(r"/\*.*?\*/", "", response.text, flags=re.S)
            base = response.final_url
            imports = {util.resolve_url(base, u) for u in CSS_IMPORT_RE.findall(text)}
            for url in sorted(imports):
                if url:
                    queue.append(dict(url=url, page=item["page"]))
            for raw in CSS_URL_RE.findall(text):
                url = util.resolve_url(base, raw)
                if not url or url in imports or util.ext_of(url) in ("css", "woff", "woff2", "ttf", "otf", "eot"):
                    continue
                if util.url_key(url) in image_keys:
                    continue
                image_keys.add(util.url_key(url))
                page = item["page"]
                images.append(dict(url=url, pageId=page["id"], pageUrl=page["url"],
                                   pageSlug=page.get("pageSlug", page["id"]), where="css",
                                   context=item["url"], alt=""))
            evidence.append(dict(url=item["url"], status="read", note=""))
        except Exception as error:
            evidence.append(dict(url=item["url"], status="failed", note=str(error)[:200]))
    for item in queue:
        if util.url_key(item["url"]) not in seen:
            evidence.append(dict(url=item["url"], status="over-limit", note="stylesheet-limit"))
    state["stylesheets"] = evidence


def run(state, fetcher, out_dir, log=print, max_assets=None, max_total_bytes=None):
    max_assets = max_assets if max_assets is not None else state["limits"].get("maxAssets", 5000)
    max_total_bytes = max_total_bytes if max_total_bytes is not None else state["limits"].get("maxTotalBytes", 2 * 1024**3)
    collect_plan(state, out_dir)
    collect_css_images(state, fetcher)
    plans = [("image", i) for i in state["imagePlan"]] + [("document", i) for i in state["documentPlan"]]
    log("assets: 图片 %d，文档 %d" % (len(state["imagePlan"]), len(state["documentPlan"])))
    old = {util.url_key(i["url"]): i for i in state.get("assets", []) + state.get("files", [])}
    taken = {i.get("localPath") for i in old.values() if i.get("localPath")}
    mappings, results = {"image": {}, "document": {}}, {"image": [], "document": []}
    by_hash, counted_paths, total_bytes = {}, set(), 0
    for index, (kind, item) in enumerate(plans):
        key = util.url_key(item["url"])
        entry = dict(url=item["url"], localPath="", pageId=item["pageId"], pageUrl=item["pageUrl"],
                     role=item.get("where", ""), alt=item.get("alt", ""), text=item.get("text", ""),
                     context=item.get("context", ""), bytes=0, hash="", width=0, height=0, status="failed", note="")
        results[kind].append(entry)
        if TRACKER_RE.search(item["url"]):
            entry.update(status="skipped", note="tracker")
            continue
        if index >= max_assets:
            entry.update(status="over-limit", note="asset-count-limit")
            continue
        cached = old.get(key, {})
        local = cached.get("localPath")
        if local and os.path.isfile(os.path.join(out_dir, local)):
            size = os.path.getsize(os.path.join(out_dir, local))
            if total_bytes + (0 if local in counted_paths else size) <= max_total_bytes:
                entry.update(cached)
                entry.update(status="cached", bytes=size)
                if local not in counted_paths:
                    total_bytes += size
                    counted_paths.add(local)
                mappings[kind][key] = local
                if entry.get("hash"):
                    by_hash[(kind, entry["hash"])] = local
                continue
        remaining = max_total_bytes - total_bytes
        if remaining <= 0:
            entry.update(status="over-limit", note="asset-byte-limit")
            continue
        try:
            response = fetcher.fetch(item["url"], referer=item["pageUrl"], binary=True,
                                     max_bytes=min(remaining, (15 if kind == "image" else 25) * 1024**2))
            if not response.ok or not response.body:
                raise ValueError(response.error or "http-%s" % response.status)
            if response.is_html or response.body.lstrip()[:32].lower().startswith((b"<!doctype html", b"<html")):
                raise ValueError("html-instead-of-asset")
            digest = util.sha1_bytes(response.body)
            ext = _image_ext(response.body) if kind == "image" else (
                util.ext_of(item["url"]) or MIME_EXT.get(response.content_type.split(";")[0], "bin"))
            if not ext:
                raise ValueError("not-an-image")
            if kind == "document" and ext == "pdf" and not response.body.lstrip().startswith(b"%PDF-"):
                raise ValueError("not-a-pdf")
            width, height = _dimensions(response.body) if kind == "image" else (0, 0)
            if (width and width <= 2) or (height and height <= 2):
                entry.update(status="skipped", note="tracking-pixel")
                continue
            local, status = by_hash.get((kind, digest)), "deduped"
            if not local:
                base = util.safe_filename(os.path.basename(util.path_of(item["url"])), fallback="asset")
                stem = os.path.splitext(base)[0] or "asset"
                proposed = ("images/%s/%04d-%s.%s" % (item["pageSlug"], index + 1, stem, ext)
                            if kind == "image" else "files/%s.%s" % (stem, ext))
                local = _unique_path(proposed, taken)
                taken.add(local)
                util.ensure_dir(os.path.dirname(os.path.join(out_dir, local)))
                with open(os.path.join(out_dir, local), "wb") as handle:
                    handle.write(response.body)
                total_bytes += len(response.body)
                counted_paths.add(local)
                by_hash[(kind, digest)], status = local, "saved"
            mappings[kind][key] = local
            entry.update(localPath=local, bytes=len(response.body), hash=digest,
                         width=width, height=height, status=status)
        except Exception as error:
            entry["note"] = str(error)[:200]
    state["assets"], state["files"] = results["image"], results["document"]
    state["imageMap"], state["fileMap"] = mappings["image"], mappings["document"]
    good = {"saved", "cached", "deduped"}
    state["assetStats"] = {
        "images": sum(i["status"] in good for i in state["assets"]),
        "imagesFailed": sum(i["status"] == "failed" for i in state["assets"]),
        "documents": sum(i["status"] in good for i in state["files"]),
        "documentsFailed": sum(i["status"] == "failed" for i in state["files"]),
        "overLimit": sum(i["status"] == "over-limit" for i in state["assets"] + state["files"]),
        "bytes": total_bytes,
    }
    return state
