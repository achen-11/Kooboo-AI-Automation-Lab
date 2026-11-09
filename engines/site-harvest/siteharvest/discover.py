"""URL discovery: sitemap, robots, navigation, in-page links, filters, language."""

import re
from urllib.parse import urljoin, urlsplit

import lxml.html
from lxml import etree

from . import util
from .net import parse_robots

LOC_RE = re.compile(r"<loc>\s*(.*?)\s*</loc>", re.I | re.S)
SITEMAP_LIMIT = 30

ASSET_EXTS = {
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "txt", "rtf",
    "zip", "rar", "7z", "tar", "gz", "dmg", "exe", "apk", "iso", "epub",
    "mp4", "mov", "avi", "wmv", "flv", "webm", "mp3", "wav", "m4a", "ogg",
    "jpg", "jpeg", "png", "gif", "webp", "svg", "avif", "bmp", "ico", "tif", "tiff",
}

LANG_CODES = {
    "en", "de", "fr", "es", "it", "nl", "pt", "ru", "ja", "ko", "zh", "ar",
    "pl", "tr", "sv", "da", "fi", "no", "nb", "cs", "hu", "ro", "el", "he",
    "th", "vi", "id", "ms", "uk", "bg", "sk", "sl", "hr", "sr", "lt", "lv", "et",
}

EXCLUDE_PATH = [
    (re.compile(r"^/wp-(admin|login|json|includes|content/plugins|content/themes)/", re.I), "cms-internal"),
    (re.compile(r"^/(xmlrpc\.php|wp-login\.php)", re.I), "cms-internal"),
    (re.compile(r"^/(cart|basket|checkout|check-out|panier|warenkorb|winkelwagen)(/|$)", re.I), "transaction"),
    (re.compile(r"^/(account|my-account|mon-compte|konto|login|signin|sign-in|logout|register|signup|sign-up|password)(/|$)", re.I), "account"),
    (re.compile(r"^/(search|zoeken|recherche|suche|buscar|search-results)(/|$)", re.I), "search"),
    (re.compile(r"^/(feed|rss)(/|$)|/feed/?$", re.I), "feed"),
    (re.compile(r"^/(cdn-cgi|_next|_nuxt|_astro)/", re.I), "build-asset"),
    (re.compile(r"^/(api|ajax|graphql)(/|$)", re.I), "api"),
    (re.compile(r"^/(wp-content|assets|static|media|uploads)/.*\.(php|aspx?|jsp)$", re.I), "cms-internal"),
]

EXCLUDE_QUERY = [
    (re.compile(r"(^|&)(s|q|search|query)=", re.I), "search"),
    (re.compile(r"(^|&)(add-to-cart|replytocom|share|share_source)=", re.I), "action"),
    (re.compile(r"(^|&)(preview|preview_id|preview_nonce)=", re.I), "preview"),
]

POLICY_RE = re.compile(
    r"(privacy|terms|conditions|cookie|legal|disclaimer|imprint|impressum|"
    r"refund|shipping|delivery|returns?|aviso|privacidad|mentions-legales|"
    r"datenschutz|agb)", re.I)
CONTACT_RE = re.compile(r"(contact|kontakt|contacto|contatti|about|over-ons|uber-uns|nosotros|chi-siamo|team|company)", re.I)
LIST_RE = re.compile(
    r"(/|^)(products?|prodotti|produkte|produits|productos|shop|store|collection|"
    r"collections|category|categories|kategorie|kategorien|catalog|assortiment|"
    r"blog|news|nieuws|actualites|articles?|archive|projects?|works?|portfolio|"
    r"case-studies|services?|diensten|leistungen|vacatures?|jobs?|careers?|"
    r"events?|agenda|downloads?|faq)(/|$)", re.I)
DETAIL_HINT_RE = re.compile(r"/\d{2,}(/|$)|/\d{4}/\d{2}(/|$)|-[a-z0-9-]{6,}\.(html?|php|aspx?)$", re.I)


def is_asset(url):
    ext = util.ext_of(url)
    return ext in ASSET_EXTS if ext else False


def guess_type(path):
    low = path.lower()
    if low in ("/", "/index.html", "/index.htm", "/index.php", "/default.asp", "/default.aspx"):
        return "home"
    if POLICY_RE.search(low):
        return "policy"
    if CONTACT_RE.search(low):
        return "contact"
    if LIST_RE.search(low):
        return "list"
    if DETAIL_HINT_RE.search(low):
        return "detail"
    if low.count("/") >= 2:
        return "detail"
    return "page"


def normalize_lang(value):
    value = (value or "").strip().lower()
    if not value:
        return ""
    return value.replace("_", "-")


def same_language(left, right):
    left, right = normalize_lang(left), normalize_lang(right)
    return left == right or (left.split("-")[0] == right.split("-")[0]
                              and ("-" not in left or "-" not in right))


def parse_sitemap(text):
    """返回 (kind, locs)。kind = index | urlset | 空。"""
    try:
        root = etree.fromstring((text or "").encode("utf-8"),
                                etree.XMLParser(resolve_entities=False, no_network=True))
    except (etree.XMLSyntaxError, ValueError):
        return "", []
    name = etree.QName(root).localname
    if name not in ("sitemapindex", "urlset"):
        return "", []
    child = "sitemap" if name == "sitemapindex" else "url"
    locs = root.xpath("./*[local-name()=$child]/*[local-name()='loc']/text()", child=child)
    return ("index" if child == "sitemap" else "urlset"), [s.strip() for s in locs if s.strip()]


def sitemap_candidates(origin, robots):
    candidates = [urljoin(origin + "/", loc) for loc in robots.get("sitemaps", [])]
    for path in ("/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml",
                 "/wp-sitemap.xml", "/sitemap.xml.gz", "/sitemap"):
        candidates.append(urljoin(origin + "/", path.lstrip("/")))
    ordered = []
    seen = set()
    for url in candidates:
        key = util.url_key(url)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(url)
    return ordered


def collect_sitemap_urls(fetcher, origin, robots, limit=SITEMAP_LIMIT, budget_seconds=45):
    """递归展开 sitemap（含索引），返回 (urls, meta)。站点限流时不能把整轮跑挂。"""
    import time
    started = time.monotonic()
    result = []
    seen = set()
    meta = {"files": [], "errors": [], "truncated": False}
    queue = sitemap_candidates(origin, robots)
    used = 0
    while queue and used < limit:
        if time.monotonic() - started > budget_seconds:
            meta["truncated"] = True
            meta["errors"].append({"url": "", "status": 0, "error": "sitemap budget exceeded"})
            break
        url = queue.pop(0)
        key = util.url_key(url)
        if key in seen:
            continue
        seen.add(key)
        used += 1
        response = fetcher.fetch(url, retries=0, timeout=8)
        if response.status in (404, 410):
            continue
        if not response.ok or not response.text:
            meta["errors"].append({"url": url, "status": response.status, "error": response.error})
            continue
        kind, locs = parse_sitemap(response.text)
        if not kind and not locs:
            continue
        meta["files"].append({"url": url, "status": response.status, "kind": kind, "count": len(locs)})
        if kind == "index":
            queue.extend(urljoin(url, loc) for loc in locs)
        else:
            result.extend(urljoin(url, loc) for loc in locs)
    meta["truncated"] = bool(queue) or used >= limit
    return result, meta


def _class_of_ancestors(node):
    labels = []
    parent = node.getparent()
    while parent is not None and len(labels) < 6:
        label = " ".join(filter(None, [parent.tag, parent.get("id") or "", parent.get("class") or ""])).lower()
        labels.append(label)
        parent = parent.getparent()
    joined = " ".join(labels)
    if re.search(r"(^|[\s_-])(footer|copyright|bottom|colophon)([\s_-]|$)", joined):
        return "footer"
    if re.search(r"(^|[\s_-])(nav|navbar|menu|header|topbar|breadcrumb|main-menu|navigation)([\s_-]|$)", joined):
        return "nav"
    return "body"


def extract_links(html, base_url):
    """返回 [{url,text,where}]；where = nav | footer | body。"""
    links = []
    if not html:
        return links
    try:
        doc = lxml.html.document_fromstring(html, base_url=base_url)
    except (lxml.etree.ParserError, ValueError, UnicodeDecodeError):
        return links
    bases = doc.xpath("//base[@href]/@href")
    if bases:
        base_url = util.resolve_url(base_url, bases[0]) or base_url
    nodes = list(doc.iter("a", "area", "frame", "iframe"))
    nodes += doc.xpath("//link[@href]")
    for node in nodes:
        if node.tag == "link" and not set((node.get("rel") or "").lower().split()).intersection(
                {"next", "prev", "alternate"}):
            continue
        href = node.get("src") if node.tag in ("frame", "iframe") else node.get("href")
        if not href:
            continue
        resolved = util.resolve_url(base_url, href)
        if not resolved:
            continue
        text = util.collapse(node.text_content())
        if not text and node.tag == "area":
            text = node.get("alt") or node.get("title") or ""
        links.append({"url": resolved, "text": util.one_line(text, 120),
                      "where": _class_of_ancestors(node), "lang": normalize_lang(node.get("hreflang")),
                      "kind": node.tag})
    return links


def extract_language(doc):
    """返回 (primary_lang, alternates{url_key: lang}, prefixes{lang})。"""
    lang = ""
    alternates = {}
    prefixes = set()
    if doc is None:
        return lang, alternates, prefixes
    html_nodes = doc.xpath("//html")
    if html_nodes:
        lang = normalize_lang(html_nodes[0].get("lang") or html_nodes[0].get("xml:lang") or "")
    for node in doc.xpath("//link[@rel='alternate'][@hreflang]"):
        raw_code = (node.get("hreflang") or "").strip().lower()
        code = normalize_lang(raw_code)
        href = node.get("href")
        if not code or not href or raw_code == "x-default" or code == "x":
            continue
        resolved = util.resolve_url(doc.base_url or "", href)
        if resolved:
            alternates[util.url_key(resolved)] = code
            first = util.path_of(resolved).strip("/").split("/")[0].lower()
            if first in LANG_CODES:
                prefixes.add(first)
    return lang, alternates, prefixes


def _lang_of_path(path):
    first = path.strip("/").split("/")[0].lower()
    return first if first.split("-")[0] in LANG_CODES else ""


def exclude_reason(record):
    path = record["path"]
    for pattern, reason in EXCLUDE_PATH:
        if pattern.search(path):
            return reason
    query = record["url"].split("?", 1)[1] if "?" in record["url"] else ""
    for pattern, reason in EXCLUDE_QUERY:
        if query and pattern.search(query):
            return reason
    return ""


def language_ok(state, record):
    primary = state.get("primaryLang")
    if not primary:
        return True
    # 首页永远不能因为语言被排除
    if "home" in (record.get("sources") or []):
        return True
    alt_lang = (state.get("langAlternates") or {}).get(record["key"])
    if alt_lang:
        return same_language(alt_lang, primary)
    path_lang = _lang_of_path(record["path"])
    if path_lang and not same_language(path_lang, primary):
        return False
    return True


def _site_hosts(source_url, final_url):
    hosts = set()
    for url in (source_url, final_url):
        host = util.canonical_host(util.host_of(url))
        if host:
            hosts.add(host)
            hosts.add("www." + host)
    return hosts


def allowed_host(url, hosts):
    host = util.host_of(url)
    if not host:
        return False
    return util.canonical_host(host) in {util.canonical_host(item) for item in hosts}


def new_record(url, sources, depth, in_sitemap, page_type=""):
    path = util.route_of(url)
    return {
        "id": "",
        "url": url,
        "key": util.url_key(url),
        "path": path,
        "sources": list(sources),
        "depth": depth,
        "inSitemap": in_sitemap,
        "pageType": page_type or guess_type(path),
        "status": None,
        "finalUrl": "",
        "contentType": "",
        "action": "pending",
        "reason": "",
        "pageFile": "",
        "title": "",
        "description": "",
        "canonical": "",
        "robots": "",
        "lang": "",
        "words": 0,
        "images": 0,
        "links": 0,
        "fetchedAt": "",
        "redirects": [],
        "note": "",
    }


def next_id(state):
    state["seq"] = int(state.get("seq", 0)) + 1
    return "u%04d" % state["seq"]


def refresh_counts(state):
    records = list(state["urls"].values())
    state["counts"] = {
        "discovered": len(records),
        "keep": len([r for r in records if r["action"] == "keep"]),
        "excluded": len([r for r in records if r["action"] == "exclude"]),
        "overLimit": len([r for r in records if r["action"] == "over-limit"]),
        "failed": len([r for r in records if r["action"] == "failed"]),
        "alias": len([r for r in records if r["action"] == "alias"]),
        "sitemap": int(state.get("sitemap", {}).get("discovered", 0)),
    }
    return state["counts"]


def add_url(state, url, label, depth, in_sitemap, queue=None, respect_budget=True):
    """加入清单；返回新记录（已存在则返回已有记录）。"""
    url = util.strip_tracking(url)
    if not util.is_http(url):
        return None
    if not allowed_host(url, state.get("siteHosts") or []):
        state.setdefault("externalUrls", {}).setdefault(url, label)
        return None
    key = util.url_key(url)
    existing = state["urls"].get(key)
    if existing:
        if label not in existing["sources"]:
            existing["sources"].append(label)
        existing["depth"] = min(existing["depth"], depth)
        existing["inSitemap"] = bool(existing.get("inSitemap") or in_sitemap)
        if existing.get("reason") == "depth-limit" and depth <= state["limits"]["maxDepth"]:
            existing.update(action="over-limit", reason="over-limit")
            if state["counts"]["keep"] < state["limits"]["maxPages"]:
                existing.update(action="keep", reason="", status=None)
                state["counts"]["keep"] += 1
                if queue is not None:
                    queue.append(existing)
        return existing

    record = new_record(url, [label], depth, in_sitemap)
    record["id"] = next_id(state)
    prefixes = state.get("limits", {}).get("excludePrefixes") or []
    if any(record["path"].startswith(prefix) for prefix in prefixes):
        record["action"] = "exclude"
        record["reason"] = "user-excluded"
        state["urls"][key] = record
        state["counts"]["discovered"] = len(state["urls"])
        return record
    reason = exclude_reason(record)
    if reason:
        record["action"] = "exclude"
        record["reason"] = reason
    elif is_asset(url):
        record["action"] = "exclude"
        record["reason"] = "asset"
    elif not language_ok(state, record):
        record["action"] = "exclude"
        record["reason"] = "other-language"
    elif respect_budget and state["counts"].get("keep", 0) >= state["limits"]["maxPages"]:
        record["action"] = "over-limit"
        record["reason"] = "over-limit"
    else:
        record["action"] = "keep"
        state["counts"]["keep"] = state["counts"].get("keep", 0) + 1
        if queue is not None:
            queue.append(record)
    state["urls"][key] = record
    state["counts"]["discovered"] = len(state["urls"])
    return record


def discover(state, fetcher, out_dir, home_html=None, log=print):
    """种子发现：起始页、robots、sitemap、首页导航与正文链接。"""
    source = state["source"]
    home = fetcher.fetch(source) if home_html is None else home_html
    if not home.ok or not home.text:
        raise RuntimeError("起始页不可访问：%s（status=%s, error=%s）" % (source, home.status, home.error))
    if not home.is_html:
        raise RuntimeError("输入必须是公开 HTML 页面，当前 Content-Type: %s" % home.content_type)

    parts = urlsplit(home.final_url)
    origin = "%s://%s" % (parts.scheme, parts.netloc)
    state["origin"] = origin
    state["siteHosts"] = sorted(_site_hosts(source, home.final_url))
    state["seq"] = 0
    state["counts"] = {"discovered": 0, "keep": 0, "excluded": 0, "overLimit": 0, "sitemap": 0}
    state["urls"] = {}

    # robots
    robots_url = urljoin(origin + "/", "robots.txt")
    robots_resp = fetcher.fetch(robots_url, retries=0, timeout=8)
    robots_meta = {"url": robots_url, "status": robots_resp.status, "sitemaps": [], "disallow": [], "allow": []}
    if robots_resp.ok and robots_resp.text and "<html" not in robots_resp.text[:500].lower():
        robots_meta.update(parse_robots(robots_resp.text))
        util.write_text(out_dir + "/.work/robots.txt", robots_resp.text)
    state["robots"] = robots_meta

    # 语言
    try:
        doc = lxml.html.document_fromstring(home.text, base_url=home.final_url)
    except (lxml.etree.ParserError, ValueError):
        doc = None
    lang, alternates, prefixes = extract_language(doc)
    # 站点自己给首页声明的语言，比 <html lang> 可信（后者经常写错）
    home_alt = normalize_lang((alternates or {}).get(util.url_key(home.final_url), ""))
    if home_alt:
        lang = home_alt
    if not lang:
        lang = normalize_lang(home.header("Content-Language").split(",")[0])
    if not lang:
        lang = _lang_of_path(util.path_of(home.final_url))
    state["primaryLang"] = state.get("languageOverride") or lang or ""
    state["langAlternates"] = alternates
    state["langPrefixes"] = sorted(prefixes)

    # sitemap
    log("  sitemap: 探测中")
    sitemap_urls, sitemap_meta = collect_sitemap_urls(fetcher, origin, robots_meta)
    if sitemap_meta["files"]:
        resp = fetcher.fetch(sitemap_meta["files"][0]["url"], retries=0, timeout=8)
        if resp.ok and resp.text:
            util.write_text(out_dir + "/.work/sitemap.xml", resp.text)
    state["sitemap"] = {
        "discovered": len(sitemap_urls),
        "files": sitemap_meta["files"],
        "errors": sitemap_meta["errors"],
        "truncated": sitemap_meta["truncated"],
    }
    log("  sitemap: %d 个 URL，%d 个文件" % (len(sitemap_urls), len(sitemap_meta["files"])))

    queue = []
    add_url(state, home.final_url, "home", 0, False, queue)
    if home.url != home.final_url:
        add_url(state, home.url, "redirect", 0, False)
    links = extract_links(home.text, home.final_url)
    nav_links = []
    footer_links = []
    for link in links:
        if link.get("lang") and link["lang"] != "x-default":
            state["langAlternates"][util.url_key(link["url"])] = link["lang"]
        add_url(state, link["url"], link["where"], 1 if link["where"] != "body" else 2, False, queue)
        if link["where"] == "nav":
            nav_links.append(link)
        elif link["where"] == "footer":
            footer_links.append(link)
    state["nav"] = nav_links
    state["footer"] = footer_links
    # 子页面也能作为唯一输入；从入口语言根继续发现，不要求用户补首页。
    prefix = _lang_of_path(util.path_of(home.final_url))
    root_url = origin + ("/" + prefix + "/" if prefix else "/")
    add_url(state, root_url, "site-root", 0, False, queue)
    for loc in sitemap_urls:
        add_url(state, loc, "sitemap", 0, True, queue)
    state["crawlQueue"] = [record["key"] for record in queue]
    refresh_counts(state)
    return state
