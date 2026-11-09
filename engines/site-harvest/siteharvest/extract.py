"""Turn a raw HTML snapshot into a structured page record (content, images, forms, SEO)."""

import json
import re
from copy import deepcopy
from urllib.parse import urljoin, urlsplit

import lxml.html

from . import util

DROP_TAGS = {"script", "style", "noscript", "template", "svg", "canvas", "object", "embed"}
# 老站的 <map> 经常不闭合，会把后面整页吞进去；不能删，只能摊平。
UNWRAP_TAGS = {"map"}
REGION_TAGS = {"header", "footer", "nav", "aside"}
REGION_RE = re.compile(
    r"(^|[\s_-])(header|footer|nav|navbar|menu|topbar|bottombar|sidebar|copyright|breadcrumb)([\s_-]|$)", re.I)
NOISE_RE = re.compile(
    r"(^|[\s_-])(cookie|consent|gdpr|newsletter|popup|modal|overlay|lightbox|skip-link|screen-reader|sr-only)([\s_-]|$)",
    re.I)
HIDDEN_RE = re.compile(r"(^|[\s_-])(hidden|is-hidden|d-none|visually-hidden)([\s_-]|$)", re.I)
TRACKER_RE = re.compile(
    r"(google-analytics|googletagmanager|doubleclick|facebook\.com/tr|bat\.bing\.com|"
    r"mc\.yandex|hotjar|clarity\.ms|segment\.io|/pixel|spacer|blank\.gif|transparent)", re.I)
NON_IMAGE_EXTS = {"woff", "woff2", "ttf", "eot", "otf", "css", "js", "mjs", "json", "xml", "map"}
SOFT_404_RE = re.compile(r"(404|not\s+found|page\s+not\s+found|页面不存在|找不到|error\s*404)", re.I)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(\+?\d[\d\s().-]{7,}\d)")


def localname(el):
    tag = el.tag
    return tag.lower() if isinstance(tag, str) else ""


def text_of(el):
    try:
        return util.collapse(el.text_content())
    except (ValueError, AttributeError):
        return ""


def rich_text(el, base):
    """段落文本，把 <a> 保留成 markdown 链接，别让正文里的有意义链接丢掉。"""
    parts = []

    def walk(node):
        if node.text:
            parts.append(node.text)
        for child in node:
            tag = localname(child)
            if tag == "a" and child.get("href"):
                label = util.collapse(child.text_content())
                url = util.resolve_url(base, child.get("href"))
                if url and label and len(label) <= 120:
                    parts.append("[%s](%s)" % (label.replace("]", "\\]"), url))
                    if not re.search(r"[\s.,;:!?)]$", label):
                        parts.append(" ")
                elif label:
                    parts.append(label)
            elif tag == "br":
                parts.append(" ")
            elif tag in ("strong", "b"):
                label = util.collapse(child.text_content())
                parts.append("**%s**" % label if label else "")
            elif tag in ("em", "i"):
                label = util.collapse(child.text_content())
                parts.append("*%s*" % label if label else "")
            elif tag in ("img", "script", "style"):
                pass
            else:
                walk(child)
            if child.tail:
                parts.append(child.tail)

    walk(el)
    return util.collapse("".join(parts))


def attr_of(el, name):
    value = el.get(name)
    return value.strip() if value else ""


def is_hidden(el):
    node = el
    depth = 0
    while node is not None and depth < 8:
        if isinstance(node.tag, str):
            if node.get("hidden") is not None:
                return True
            style = (node.get("style") or "").replace(" ", "").lower()
            if "display:none" in style or "visibility:hidden" in style:
                return True
            klass = (node.get("class") or "") + " " + (node.get("id") or "")
            if HIDDEN_RE.search(klass) and "visually-hidden" not in klass and "sr-only" not in klass:
                return True
        node = node.getparent()
        depth += 1
    return False


def is_region(el, name):
    if localname(el) == name:
        return True
    label = (el.get("class") or "") + " " + (el.get("id") or "")
    return bool(REGION_RE.search(label)) and name in ("nav", "header", "footer")


def _region_of(el):
    node = el
    depth = 0
    while node is not None and depth < 8:
        tag = localname(node)
        if tag == "footer" or is_region(node, "footer"):
            return "footer"
        if tag in ("nav", "header") or is_region(node, "nav") or is_region(node, "header"):
            return "nav"
        node = node.getparent()
        depth += 1
    return "content"


def _unwrap(node):
    parent = node.getparent()
    if parent is None:
        return
    index = parent.index(node)
    previous = node.getprevious()
    if node.text:
        if previous is None:
            parent.text = (parent.text or "") + node.text
        else:
            previous.tail = (previous.tail or "") + node.text
    for child in list(node):
        parent.insert(index, child)
        index += 1
        previous = child
    if node.tail:
        if previous is None:
            parent.text = (parent.text or "") + node.tail
        else:
            previous.tail = (previous.tail or "") + node.tail
    parent.remove(node)


def prune(root, aggressive=True):
    """在副本上删掉脚本、样式、页眉/页脚/导航、cookie 横幅，留下正文候选区。"""
    for node in list(root.iter()):
        tag = localname(node)
        if not tag:
            continue
        if tag in UNWRAP_TAGS:
            _unwrap(node)
            continue
        if tag in DROP_TAGS:
            _drop(node)
            continue
        if not aggressive:
            continue
        label = (node.get("class") or "") + " " + (node.get("id") or "")
        role = (node.get("role") or "").lower()
        if tag in REGION_TAGS or role in ("navigation", "banner", "contentinfo"):
            _drop(node)
            continue
        if label.strip() and (REGION_RE.search(label) or NOISE_RE.search(label)):
            if tag not in ("body", "html"):
                _drop(node)


def _drop(node):
    parent = node.getparent()
    if parent is not None:
        previous = node.getprevious()
        if node.tail:
            if previous is None:
                parent.text = (parent.text or "") + node.tail
            else:
                previous.tail = (previous.tail or "") + node.tail
        parent.remove(node)


def media_embed(node, base, hidden=False):
    sources = []
    for candidate in [node] + list(node.iter("source")):
        raw = attr_of(candidate, "src") or attr_of(candidate, "data-src")
        url = util.resolve_url(base, raw) if raw else ""
        if url and url not in [s["url"] for s in sources]:
            sources.append({"url": url, "type": attr_of(candidate, "type")})
    poster = util.resolve_url(base, attr_of(node, "poster"))
    if not sources and not poster:
        return None
    return {"kind": "embed", "tag": localname(node), "src": sources[0]["url"] if sources else "",
            "sources": sources, "poster": poster, "hidden": hidden}


def choose_content(root):
    best = root
    best_score = 0.0
    best_depth = -1
    for el in root.iter():
        tag = localname(el)
        if tag not in ("div", "td", "article", "main", "section", "body"):
            continue
        total = len(text_of(el))
        if total < 120:
            continue
        link_chars = sum(len(text_of(a)) for a in el.iter("a"))
        score = total - 1.4 * link_chars
        depth = 0
        node = el
        while node is not None:
            depth += 1
            node = node.getparent()
        if score > best_score * 1.02 or (score >= best_score * 0.98 and depth > best_depth):
            best_score = score
            best_depth = depth
            best = el
    return best


def rich_blocks(el, base, inherited_hidden=False, out=None):
    if out is None:
        out = []
    hidden = inherited_hidden or is_hidden(el)
    tag = localname(el)
    if not tag:
        return out

    if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
        text = text_of(el)
        if text:
            out.append({"kind": "heading", "level": int(tag[1]), "text": text, "hidden": hidden})
        return out

    if tag == "p":
        text = rich_text(el, base)
        if text:
            out.append({"kind": "p", "text": text, "hidden": hidden})
        for img in el.iter("img"):
            _image_block(img, base, out, hidden)
        return out

    if tag in ("ul", "ol"):
        items = []
        for li in el.iter("li"):
            text = text_of(li)
            if text:
                items.append(text)
        if items:
            out.append({"kind": "list", "ordered": tag == "ol", "items": items, "hidden": hidden})
        return out

    if tag == "dl":
        items = []
        for child in el:
            if localname(child) in ("dt", "dd"):
                text = text_of(child)
                if text:
                    items.append(text)
        if items:
            out.append({"kind": "list", "ordered": False, "items": items, "hidden": hidden})
        return out

    if tag == "table":
        if looks_like_data_table(el):
            rows = table_rows(el)
            if rows:
                out.append({"kind": "table", "rows": rows, "hidden": hidden})
            return out
        for child in el:
            rich_blocks(child, base, hidden, out)
        return out

    if tag == "blockquote":
        text = text_of(el)
        if text:
            out.append({"kind": "quote", "text": text, "hidden": hidden})
        return out

    if tag == "pre":
        text = el.text_content()
        if text.strip():
            out.append({"kind": "code", "text": text.strip()[:4000], "hidden": hidden})
        return out

    if tag == "figure":
        for child in el:
            rich_blocks(child, base, hidden, out)
        return out

    if tag == "figcaption":
        text = text_of(el)
        if text:
            out.append({"kind": "p", "text": text, "hidden": hidden, "caption": True})
        return out

    if tag == "img":
        _image_block(el, base, out, hidden)
        return out

    if tag == "form":
        fields = form_fields(el)
        if fields:
            out.append({
                "kind": "form",
                "action": util.resolve_url(base, attr_of(el, "action")),
                "method": (attr_of(el, "method") or "get").lower(),
                "fields": fields,
                "hidden": hidden,
            })
        return out

    if tag in ("iframe", "video", "audio"):
        entry = media_embed(el, base, hidden)
        if entry:
            out.append(entry)
        return out

    inline = [el.text or ""]

    def flush_inline():
        text = util.collapse("".join(inline))
        if text:
            out.append({"kind": "p", "text": text, "hidden": hidden})
        inline.clear()

    for child in el:
        if localname(child) in {"a", "span", "strong", "b", "em", "i", "font", "label", "small",
                                "time", "code", "mark", "abbr", "sup", "sub", "u", "s", "br"} and not any(
                localname(n) in BLOCKISH or localname(n) in {"img", "video", "audio", "iframe", "form"}
                for n in child.iterdescendants()):
            holder = lxml.html.Element("div")
            clone = deepcopy(child)
            clone.tail = None
            holder.append(clone)
            inline.append(rich_text(holder, base) if localname(child) != "br" else " ")
        else:
            flush_inline()
            rich_blocks(child, base, hidden, out)
        inline.append(child.tail or "")
    flush_inline()
    return out


TEXT_CONTAINERS = {"div", "section", "article", "aside", "main", "header", "footer",
                   "li", "td", "th", "dd", "dt", "form"}

BLOCKISH = {"p", "div", "td", "th", "tr", "table", "li", "ul", "ol", "h1", "h2", "h3",
            "h4", "h5", "h6", "blockquote", "pre", "section", "article", "dl", "dd", "dt"}


def loose_blocks(root, base):
    """老站的正文常常是 <td><font>文字<br><br>文字：没有块级标签，只能按 <br> 断段。"""
    parts = []

    def walk(node):
        if node.text:
            parts.append(node.text)
        for child in node:
            if not isinstance(child.tag, str):
                # 注释节点不参与正文，但它的 tail 是正文
                if child.tail:
                    parts.append(child.tail)
                continue
            tag = localname(child)
            if tag == "br":
                parts.append("\n")
            elif tag in BLOCKISH:
                parts.append("\n\n")
                walk(child)
                parts.append("\n\n")
            elif tag == "a" and child.get("href"):
                label = util.collapse(child.text_content())
                url = util.resolve_url(base, child.get("href"))
                if url and label and len(label) <= 120:
                    parts.append("[%s](%s)" % (label.replace("]", "\\]"), url))
                    if not re.search(r"[\s.,;:!?)]$", label):
                        parts.append(" ")
                elif label:
                    parts.append(label)
            elif tag in ("img", "script", "style", "noscript"):
                pass
            else:
                walk(child)
            if child.tail:
                parts.append(child.tail)

    walk(root)
    text = "".join(parts)
    text = re.sub(r"[ \t\r]+", " ", text)
    text = re.sub(r"\n[ ]*\n[ \n]*", "\n\n", text)
    out = []
    for chunk in text.split("\n\n"):
        paragraph = util.collapse(chunk)
        if len(paragraph) < 2:
            continue
        if len(re.findall(r"<[a-zA-Z][^>]{0,120}>", paragraph)) >= 2:
            continue  # 页面把 HTML 当文本吐出来了，不是正文
        out.append({"kind": "p", "text": paragraph, "hidden": False})
    return out


def blocks_coverage(blocks, total_chars):
    covered = 0
    for block in blocks:
        if block.get("kind") in ("heading", "p", "quote", "code"):
            covered += len(block.get("text") or "")
        elif block.get("kind") == "list":
            covered += sum(len(item) for item in block.get("items") or [])
        elif block.get("kind") == "table":
            covered += sum(len(cell) for row in block.get("rows") or [] for cell in row)
    return covered / float(max(1, total_chars))


def _image_block(img, base, out, hidden):
    src = pick_image_src(img, base)
    if not src:
        return
    width = _int_attr(img, "width")
    height = _int_attr(img, "height")
    if (width is not None and width <= 2) or (height is not None and height <= 2):
        return
    out.append({
        "kind": "image",
        "src": src,
        "alt": util.one_line(attr_of(img, "alt"), 200),
        "title": util.one_line(attr_of(img, "title"), 200),
        "hidden": hidden,
    })


def _int_attr(el, name):
    value = el.get(name)
    if not value:
        return None
    match = re.search(r"\d+", value)
    return int(match.group(0)) if match else None


def parse_srcset(value):
    items = []
    for part in (value or "").split(","):
        part = part.strip()
        if not part:
            continue
        bits = part.split()
        url = bits[0]
        width = 0
        if len(bits) > 1:
            desc = bits[1].lower()
            if desc.endswith("w") and desc[:-1].isdigit():
                width = int(desc[:-1])
            elif desc.endswith("x") and desc[:-1].replace(".", "").isdigit():
                width = int(float(desc[:-1]) * 1000)
        items.append((url, width))
    return items


def pick_image_src(img, base):
    candidates = []
    srcset = img.get("srcset") or img.get("data-srcset")
    for url, width in parse_srcset(srcset):
        candidates.append((url, 2000 + width))
    for attr, weight in (("data-src", 1500), ("data-lazy-src", 1500), ("data-original", 1500),
                         ("data-lazy", 1400), ("data-url", 1300)):
        value = img.get(attr)
        if value:
            candidates.append((value, weight))
    src = img.get("src")
    if src:
        weight = 100
        if re.search(r"(placeholder|blank|spacer|lazy|loading|1x1|transparent)", src, re.I):
            weight = 10
        candidates.append((src, weight))

    best = ""
    best_score = -1
    for raw, weight in candidates:
        url = util.resolve_url(base, raw)
        if not url:
            continue
        if re.search(r"\.svg(\?|$)", url, re.I):
            weight += 1
        if re.search(r"(@2x|@3x|large|original|full|1920|2048|1600)", url, re.I):
            weight += 200
        if TRACKER_RE.search(url):
            weight -= 3000
        if weight > best_score:
            best_score = weight
            best = url
    return best


NESTED_BLOCK_XPATH = ".//table|.//div|.//p|.//ul|.//ol|.//h1|.//h2|.//h3|.//h4|.//section|.//article"


def looks_like_data_table(table):
    """区分数据表与布局表：布局表递归，数据表输出。"""
    if table.find(".//th") is not None or table.find(".//caption") is not None:
        return True
    if table.xpath(NESTED_BLOCK_XPATH):
        return False
    rows = [[cell for cell in tr if localname(cell) in ("td", "th")] for tr in table.iter("tr")]
    rows = [row for row in rows if row]
    if len(rows) < 2:
        return False
    widths = {len(row) for row in rows}
    if len(widths) != 1:
        return False
    width = widths.pop()
    if width < 2:
        return False
    texts = [text_of(cell) for row in rows for cell in row]
    if len(texts) < 4:
        return False
    average = sum(len(text) for text in texts) / float(len(texts))
    return average <= 300


def table_rows(table):
    trs = [tr for tr in table.iter("tr") if localname(tr) == "tr"][:80]
    if not trs:
        return []
    occupied = {}
    max_col = 0
    for r, tr in enumerate(trs):
        col = 0
        for cell in tr:
            if localname(cell) not in ("td", "th"):
                continue
            while (r, col) in occupied:
                col += 1
            text = util.one_line(text_of(cell), 400)
            rowspan = _int_attr(cell, "rowspan") or 1
            colspan = _int_attr(cell, "colspan") or 1
            rowspan = min(rowspan, 20)
            colspan = min(colspan, 12)
            for dr in range(rowspan):
                for dc in range(colspan):
                    occupied[(r + dr, col + dc)] = text if (dr == 0 and dc == 0) else ""
            col += colspan
            max_col = max(max_col, col)
        max_col = max(max_col, col)
    if max_col == 0:
        return []
    rows = []
    for r in range(len(trs)):
        row = [occupied.get((r, c), "") for c in range(min(max_col, 12))]
        if any(cell.strip() for cell in row):
            rows.append(row)
    return rows


def form_fields(form):
    fields = []
    labels = {}
    for label in form.iter("label"):
        target = label.get("for")
        if target:
            labels[target] = text_of(label)
    for node in form.iter():
        tag = localname(node)
        if tag not in ("input", "select", "textarea"):
            continue
        kind = (node.get("type") or ("textarea" if tag == "textarea" else "text")).lower()
        if kind in ("submit", "button", "reset", "image"):
            continue
        name = attr_of(node, "name") or attr_of(node, "id")
        if not name:
            continue
        field = {
            "name": name,
            "type": kind,
            "label": util.one_line(labels.get(node.get("id") or "") or
                                   attr_of(node, "placeholder") or attr_of(node, "aria-label"), 80),
            "required": node.get("required") is not None,
        }
        if tag == "select":
            options = [text_of(opt) for opt in node.iter("option") if text_of(opt)]
            field["options"] = options[:30]
        fields.append(field)
    return fields[:40]


def _image_context(img):
    node = img.getparent()
    depth = 0
    while node is not None and depth < 6:
        text = text_of(node)
        if 20 <= len(text) <= 320:
            return util.one_line(text, 160)
        node = node.getparent()
        depth += 1
    return ""


def _is_real_image(url):
    ext = util.ext_of(url)
    if ext and ext in NON_IMAGE_EXTS:
        return False
    if re.search(r"\.(woff2?|ttf|eot|otf)(\?|$)", url, re.I):
        return False
    return True


def collect_images(doc, base):
    images = []
    seen = set()
    for img in doc.iter("img"):
        url = pick_image_src(img, base)
        if not url or not _is_real_image(url):
            continue
        key = util.url_key(url)
        if key in seen:
            continue
        seen.add(key)
        width = _int_attr(img, "width")
        height = _int_attr(img, "height")
        if (width is not None and width <= 2) or (height is not None and height <= 2):
            continue
        if TRACKER_RE.search(url):
            continue
        images.append({
            "url": url,
            "alt": util.one_line(attr_of(img, "alt"), 200),
            "title": util.one_line(attr_of(img, "title"), 200),
            "where": _region_of(img),
            "width": width or 0,
            "height": height or 0,
            "hidden": is_hidden(img),
            "context": _image_context(img),
        })
    # 内联背景图
    for node in doc.iter():
        style = node.get("style") or ""
        if "url(" not in style.lower():
            continue
        for match in re.finditer(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", style, re.I):
            url = util.resolve_url(base, match.group(1))
            if not url or not _is_real_image(url) or util.url_key(url) in seen:
                continue
            seen.add(util.url_key(url))
            images.append({
                "url": url, "alt": "", "title": "", "where": _region_of(node),
                "width": 0, "height": 0, "hidden": False, "background": True,
            })
    # <style> 里的背景图（全站级别，归属到本页）
    for style_node in doc.iter("style"):
        text = style_node.text_content() or ""
        if "url(" not in text.lower():
            continue
        for match in re.finditer(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", text, re.I):
            url = util.resolve_url(base, match.group(1))
            if not url or not _is_real_image(url) or util.url_key(url) in seen:
                continue
            seen.add(util.url_key(url))
            images.append({
                "url": url, "alt": "", "title": "", "where": "content",
                "width": 0, "height": 0, "hidden": False, "background": True,
            })
    # 正文之外的素材仍然是资料：社交封面、站点图标、视频封面、picture 和图集原图。
    candidates = []
    for node in doc.xpath("//meta[@content]"):
        if (node.get("property") or node.get("name") or "").lower() in ("og:image", "og:image:url", "twitter:image"):
            candidates.append((node.get("content"), "metadata", ""))
    for node in doc.xpath("//link[@href]"):
        if "icon" in (node.get("rel") or "").lower():
            candidates.append((node.get("href"), "icon", ""))
    for node in doc.xpath("//video[@poster]"):
        candidates.append((node.get("poster"), "poster", ""))
    for node in doc.xpath("//picture/source"):
        for raw, _size in parse_srcset(node.get("srcset") or node.get("data-srcset")):
            candidates.append((raw, "picture", node.get("media") or ""))
    for node in doc.xpath("//a[@href]"):
        if util.ext_of(node.get("href")) in {"jpg", "jpeg", "png", "gif", "webp", "svg", "avif"}:
            candidates.append((node.get("href"), "linked-image", text_of(node)))
    for raw, role, context in candidates:
        url = util.resolve_url(base, raw)
        if url and util.url_key(url) not in seen and not TRACKER_RE.search(url):
            seen.add(util.url_key(url))
            images.append(dict(url=url, alt="", title="", where=role, width=0, height=0,
                               hidden=False, context=context))
    return images


def collect_links(doc, base):
    links = []
    seen = set()
    for node in doc.iter("a", "area"):
        href = node.get("href")
        if not href:
            continue
        url = util.resolve_url(base, href)
        if not url:
            continue
        key = util.url_key(url)
        text = util.one_line(text_of(node), 120)
        marker = (key, text)
        if marker in seen:
            continue
        seen.add(marker)
        links.append({"url": url, "text": text, "where": _region_of(node)})
    return links


def _json_ld(doc):
    items = []
    for node in doc.iter("script"):
        if (node.get("type") or "").lower() != "application/ld+json":
            continue
        raw = (node.text_content() or "").strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except ValueError:
            items.append({"type": "invalid", "raw": raw})
            continue
        stack = data if isinstance(data, list) else [data]
        for entry in stack:
            if not isinstance(entry, dict):
                continue
            types = entry.get("@type")
            if isinstance(types, list):
                types = ",".join(str(t) for t in types)
            items.append({"type": str(types or ""), "data": entry})
    return items


def meta_of(doc, base):
    meta = {"title": "", "description": "", "canonical": "", "robots": "", "lang": "",
            "og": {}, "hreflang": []}
    titles = doc.xpath("//title")
    if titles:
        meta["title"] = util.one_line(text_of(titles[0]), 300)
    for node in doc.iter("meta"):
        name = (node.get("name") or node.get("property") or "").lower()
        content = node.get("content") or ""
        if name == "description" and content:
            meta["description"] = util.one_line(content, 600)
        elif name == "robots" and content:
            meta["robots"] = content
        elif name.startswith("og:") and content:
            meta["og"][name[3:]] = util.one_line(content, 300)
    for node in doc.iter("link"):
        rel = (node.get("rel") or "").lower()
        if rel == "canonical" and node.get("href"):
            meta["canonical"] = util.resolve_url(base, node.get("href"))
        elif rel == "alternate" and node.get("hreflang") and node.get("href"):
            meta["hreflang"].append({
                "lang": node.get("hreflang"),
                "url": util.resolve_url(base, node.get("href")),
            })
    html_nodes = doc.xpath("//html")
    if html_nodes:
        meta["lang"] = html_nodes[0].get("lang") or html_nodes[0].get("xml:lang") or ""
    return meta


BARE_FILENAME_RE = re.compile(r"^[\w%.-]+\.(webp|jpe?g|png|gif|svg|avif|css|js)$", re.I)


def _block_key(block):
    kind = block.get("kind")
    if kind in ("heading", "p", "quote", "code"):
        return (kind, block.get("text") or "")
    if kind == "image":
        return (kind, block.get("src") or "")
    if kind == "list":
        return (kind, tuple(block.get("items") or []))
    return None


def clean_blocks(blocks):
    """去掉图片文件名冒充的正文、隐藏块里的桌面/移动端重复，以及紧邻重复。"""
    visible = set()
    for block in blocks:
        if block.get("hidden"):
            continue
        key = _block_key(block)
        if key:
            visible.add(key)

    cleaned = []
    recent = []
    for block in blocks:
        key = _block_key(block)
        if block.get("kind") in ("p", "heading") and BARE_FILENAME_RE.match((block.get("text") or "").strip()):
            continue
        if block.get("hidden") and key in visible:
            continue
        if key and key in recent:
            continue
        if key:
            recent.append(key)
            recent = recent[-8:]
        cleaned.append(block)
    return cleaned


def _looks_like_list(links, words, path):
    content_links = [l for l in links if l["where"] == "content"]
    if len(content_links) < 12:
        return False
    prefix = path.rstrip("/") + "/"
    children = [l for l in content_links if util.path_of(l["url"]).startswith(prefix)]
    if len(children) >= 10:
        return True
    if words > 6000:
        return False
    link_chars = sum(len(l.get("text") or "") for l in content_links)
    return link_chars / float(max(1, words)) > 0.5


def extract_page(raw_text, url):
    try:
        doc = lxml.html.document_fromstring(raw_text, base_url=url)
    except (lxml.etree.ParserError, ValueError, UnicodeDecodeError):
        return None
    base_nodes = doc.xpath("//base[@href]")
    base = url
    if base_nodes:
        base = util.resolve_url(url, base_nodes[0].get("href")) or url

    meta = meta_of(doc, base)
    links = collect_links(doc, base)
    images = collect_images(doc, base)
    jsonld = _json_ld(doc)
    contact_links = [{"url": n.get("href"), "text": text_of(n), "where": _region_of(n)}
                     for n in doc.xpath("//a[@href]")
                     if (n.get("href") or "").lower().startswith(("mailto:", "tel:", "sms:"))]
    inline_graphics = [lxml.etree.tostring(n, encoding="unicode")
                       for n in doc.xpath("//*[local-name()='svg']")]
    data_images = [n.get("src") for n in doc.xpath("//img[@src]")
                   if (n.get("src") or "").startswith("data:image/")]
    # 保存未经正文打分裁剪的整页文字，供复核侧栏、页脚和被误删的内容。
    text_doc = lxml.html.document_fromstring(raw_text, base_url=url)
    for node in list(text_doc.iter("script", "style", "template", "noscript")):
        _drop(node)
    full_text = util.norm_text("\n".join(text_doc.itertext()))
    stylesheets = [util.resolve_url(base, n.get("href"))
                   for n in doc.xpath("//link[@href]")
                   if "stylesheet" in (n.get("rel") or "").lower().split()]

    original_chars = len(text_of(doc))
    working = lxml.html.document_fromstring(raw_text, base_url=url)
    prune(working)
    content = choose_content(working)
    if original_chars > 150 and len(text_of(content)) < 0.35 * original_chars:
        # 过度裁剪（老站常见：整站包在 layout table 或未闭合标签里），退回保守模式
        working = lxml.html.document_fromstring(raw_text, base_url=url)
        prune(working, aggressive=False)
        content = choose_content(working)
    blocks = clean_blocks(rich_blocks(content, base))
    root_chars = len(text_of(content))
    text_blocks = [b for b in blocks if b.get("kind") in ("heading", "p", "list", "table", "quote", "code")]
    if root_chars >= 20 and (not text_blocks or (root_chars > 150 and blocks_coverage(blocks, root_chars) < 0.6)):
        blocks = clean_blocks(loose_blocks(content, base))

    # 页面里全站级的图片（logo 等）不应因为不在正文区就丢掉
    content_images = set()
    for block in blocks:
        if block["kind"] == "image":
            content_images.add(util.url_key(block["src"]))
    for index, img in enumerate(images):
        img["inContent"] = util.url_key(img["url"]) in content_images
        img["index"] = index

    text_parts = []
    for block in blocks:
        if block["kind"] in ("heading", "p", "quote", "code"):
            text_parts.append(block.get("text") or "")
        elif block["kind"] == "list":
            text_parts.extend(block.get("items") or [])
        elif block["kind"] == "table":
            for row in block.get("rows") or []:
                text_parts.extend(row)
    words = util.text_len(" ".join(text_parts))

    headings = [{"level": b["level"], "text": b["text"]} for b in blocks if b["kind"] == "heading"]
    h1 = next((h["text"] for h in headings if h["level"] == 1), "")
    if not h1 and headings:
        h1 = headings[0]["text"]

    forms = [b for b in blocks if b["kind"] == "form"]
    tables = [b for b in blocks if b["kind"] == "table"]
    embeds = [b for b in blocks if b["kind"] == "embed"]

    # 表单/嵌入经常在正文容器之外（页尾、侧栏），按整页补一次
    seen_forms = {(form.get("action"), tuple(f.get("name") for f in form.get("fields", []))) for form in forms}
    for form in doc.iter("form"):
        fields = form_fields(form)
        if not fields:
            continue
        entry = {
            "kind": "form",
            "action": util.resolve_url(base, attr_of(form, "action")),
            "method": (attr_of(form, "method") or "get").lower(),
            "fields": fields,
            "hidden": False,
        }
        marker = (entry["action"], tuple(f.get("name") for f in fields))
        if marker not in seen_forms:
            seen_forms.add(marker)
            forms.append(entry)
    seen_embeds = {block.get("src") for block in embeds}
    for node in doc.iter("iframe", "video", "audio"):
        entry = media_embed(node, base)
        if not entry:
            continue
        if entry["src"] not in seen_embeds:
            seen_embeds.add(entry["src"])
            embeds.append(entry)
    hidden_blocks = len([b for b in blocks if b.get("hidden")])

    page_type = ""
    path = util.path_of(url)
    low = (meta["title"] + " " + h1).lower()
    if SOFT_404_RE.search(low) and words < 150:
        page_type = "soft-404"
    elif path in ("/", "/index.html", "/index.htm") or path.count("/") == 0:
        page_type = "home"
    elif forms and words < 400 and re.search(r"(contact|kontakt|contacto|contatti)", path, re.I):
        page_type = "contact"
    elif _looks_like_list(links, words, path):
        page_type = "list"
    elif any(item["type"].lower().startswith(("article", "blogposting", "newsarticle")) for item in jsonld):
        page_type = "article"
    elif words >= 300:
        page_type = "page"
    else:
        page_type = "unknown"

    emails = list(dict.fromkeys(EMAIL_RE.findall(" ".join(text_parts))))[:10]
    phones = list(dict.fromkeys(
        match.strip() for match in PHONE_RE.findall(" ".join(text_parts)) if len(match.strip()) >= 9
    ))[:10]

    return {
        "url": url,
        "fullText": full_text,
        "contactLinks": contact_links,
        "inlineGraphics": inline_graphics,
        "dataImages": data_images,
        "stylesheets": [s for s in stylesheets if s],
        "interactionHints": [
            {"tag": localname(n), "text": util.one_line(text_of(n), 120)}
            for n in doc.xpath("//button | //*[@onclick and not(@href)]")
            if re.search(r"(load.?more|show.?more|加载|更多|下一页)", text_of(n), re.I)
        ][:30],
        "base": base,
        "pageType": page_type,
        "title": meta["title"],
        "description": meta["description"],
        "canonical": meta["canonical"],
        "robots": meta["robots"],
        "lang": meta["lang"].lower().replace("_", "-") if meta["lang"] else "",
        "hreflang": meta["hreflang"],
        "og": meta["og"],
        "h1": h1,
        "headings": headings,
        "blocks": blocks,
        "images": images,
        "links": links,
        "forms": forms,
        "tables": tables,
        "embeds": embeds,
        "jsonld": [{"type": item["type"]} for item in jsonld],
        "jsonldRaw": jsonld,
        "words": words,
        "hiddenBlocks": hidden_blocks,
        "emails": emails,
        "phones": phones,
    }


def run(state, out_dir, log=print):
    from .rules import restore_derived
    protected = restore_derived(state, out_dir)
    pages = [r for r in state["urls"].values()
             if r["action"] == "keep" and r.get("rawFile") and r["id"] not in protected]
    log("extract: %d 个页面" % len(pages))
    done = 0
    for record in pages:
        path = out_dir + "/" + record["rawFile"]
        try:
            with open(path, "r", encoding="utf-8") as handle:
                raw = handle.read()
        except OSError:
            continue
        data = extract_page(raw, record.get("finalUrl") or record["url"])
        if not data:
            record["action"] = "failed"
            record["reason"] = "parse-error"
            continue
        util.write_json(out_dir + "/.work/extract/" + record["id"] + ".json", data)
        record["title"] = data["title"]
        record["description"] = data["description"]
        record["canonical"] = data["canonical"]
        record["robots"] = data["robots"]
        record["lang"] = data["lang"]
        record["pageType"] = data["pageType"]
        record["words"] = data["words"]
        record["images"] = len(data["images"])
        record["links"] = len(data["links"])
        if data["pageType"] == "soft-404":
            record["action"] = "exclude"
            record["reason"] = "soft-404"
        done += 1
        if done % 10 == 0 or done == len(pages):
            log("  %d/%d" % (done, len(pages)))
    return state
