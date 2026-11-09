"""Fold repeated page groups (catalogs, article archives, listing pages) into data files.

The point is downstream leverage: many near-identical detail pages can become one
record set with shared rendering instead of hand-built copies. This module only
*describes* candidate page groups — record boundaries, storage owner and route shape
stay build-time decisions, recorded in `data/schema.md` as advice, never applied here.
"""

import json
import os
import re
from urllib.parse import urlsplit

from . import util

# 少于这个条数就不值得当候选页面组：几页手写更快，也更像"版式各异"的独立页。
MIN_RECORDS = 8
# 字段要求：至少这么多个字段在 60% 以上的记录里都有，才认为形状稳定。
MIN_FIELDS = 3
FIELD_COVERAGE = 0.6

# 仅使用通用路径词作弱提示；show/detail 等词也可能是案例展示，不能据此判为商品。
PRODUCT_HINTS = re.compile(r"(?:^|/)(?:products?|items?|goods|shop|sku|models?|p)(?:/|$)", re.I)
ARTICLE_HINTS = re.compile(r"(?:^|/)(?:news|articles?|blogs?|posts?|press|events?|cases?|projects?|stories|journal)(?:/|$)", re.I)
CATEGORY_HINTS = re.compile(r"(?:^|/)(?:categor(?:y|ies)|catalog(?:ue)?s?|collections?|lists?|brands?|series|tags?|topics?)(?:/|$)", re.I)
# 单个 JSON 分片的目标体积：一次 kfile 写入太大，KScript 调用会变慢甚至超限。
PART_BYTES = 350_000
# 出现在六成以上页面的同一句话，基本就是全站导航/页脚/客服电话，不是记录内容。
CHROME_PAGE_RATIO = 0.6
CHROME_MAX_LEN = 120

CSV_COLUMNS = [
    "source_id", "url", "title", "slug", "summary",
    "sections", "specs", "images", "links",
]


def url_template(path):
    """把数字段折成 {id}：/products/1113 与 /products/1114 属于同一个候选组。"""
    if not path:
        return ""
    parts = []
    for segment in path.split("/"):
        if re.fullmatch(r"\d+", segment):
            parts.append("{id}")
        else:
            parts.append(segment)
    return "/".join(parts)


def page_group_id(template):
    """模板 -> 文件/引用用的 ASCII 标识，例如 /products/{id} -> products。"""
    cleaned = template.replace("{id}", "")
    parts = [part for part in cleaned.split("/") if part]
    if not parts:
        return "root"
    return util.slugify("-".join(parts), 40, "pageGroup")


def _is_numeric_record(template):
    return "{id}" in template


def _strip_site_suffix(title, site_name):
    """标题里的"标题_站点名"是采集器拼的，记录里只留标题本身。

    只在不损失信息时切：分隔符右边必须确实是站点名（或明显是站点名的片段）。
    """
    text = util.one_line(title, 200)
    if not text or not site_name:
        return text
    normalized_site = util.norm_text(site_name)
    for separator in ("_", " | ", " - ", " — "):
        if separator not in text:
            continue
        head, _, tail = text.rpartition(separator)
        head, tail = head.strip(), util.norm_text(tail)
        # 站点名常见写法：全名、去掉公司后缀的主体、尾部片段
        if head and (tail and (tail in normalized_site or normalized_site.endswith(tail))
                     and len(tail) >= 2):
            return head
    return text


def _normalize_line(text):
    return util.norm_text(util.one_line(text, CHROME_MAX_LEN))


def chrome_set(state, pages, out_dir):
    """全站样板：导航、页脚、大多数页面都出现的重复句子，以及每页都在的图片。"""
    chrome = set()
    for item in (state.get("nav") or []) + (state.get("footer") or []):
        text = _normalize_line(item.get("text") if isinstance(item, dict) else item)
        if text:
            chrome.add(text)

    counts = {}
    seen_total = 0
    for page in pages:
        data = util.read_json(os.path.join(out_dir, ".work", "extract", page["id"] + ".json"))
        if not data:
            continue
        seen_total += 1
        lines = set()
        for block in data.get("blocks") or []:
            if block.get("hidden"):
                continue
            if block.get("kind") in ("p", "quote"):
                lines.add(_normalize_line(block.get("text", "")))
            elif block.get("kind") == "list":
                for item in block.get("items") or []:
                    lines.add(_normalize_line(item))
        lines.discard("")
        for line in lines:
            counts[line] = counts.get(line, 0) + 1

    if seen_total:
        threshold = max(3, int(seen_total * CHROME_PAGE_RATIO))
        for line, count in counts.items():
            if count >= threshold:
                chrome.add(line)
    return chrome


def chrome_links(state, pages, out_dir):
    """导航里每页都有的链接（首页、分类、政策）不是记录内容，不该进记录。"""
    counts = {}
    seen_total = 0
    for page in pages:
        data = util.read_json(os.path.join(out_dir, ".work", "extract", page["id"] + ".json"))
        if not data:
            continue
        seen_total += 1
        for path in {util.path_of(link) for link in _links_of(data)}:
            counts[path] = counts.get(path, 0) + 1
    if not seen_total:
        return set()
    threshold = max(3, int(seen_total * CHROME_PAGE_RATIO))
    return {path for path, count in counts.items() if count >= threshold}


def chrome_images(state, pages, out_dir):
    """每页都出现（六成以上页面）的图片就是站标、图标、横幅，不是记录素材。"""
    counts = {}
    seen_total = 0
    for page in pages:
        data = util.read_json(os.path.join(out_dir, ".work", "extract", page["id"] + ".json"))
        if not data:
            continue
        seen_total += 1
        locals_of_page = set()
        for block in data.get("blocks") or []:
            if block.get("kind") == "image" and not block.get("hidden"):
                local = util.url_key(block.get("src") or "")
                if local:
                    locals_of_page.add(local)
        for url in data.get("images") or []:
            key = util.url_key(url.get("url") or "")
            if key:
                locals_of_page.add(key)
        for key in locals_of_page:
            counts[key] = counts.get(key, 0) + 1
    if not seen_total:
        return set()
    threshold = max(3, int(seen_total * CHROME_PAGE_RATIO))
    return {key for key, count in counts.items() if count >= threshold}


def _keep_line(text, chrome):
    line = _normalize_line(text)
    if not line:
        return False
    if line in chrome:
        return False
    # 导航整行被拼成一条长句时，也会命中这里
    return True


def _sections_of(blocks, chrome=None):
    """正文按标题切段，保留段内文本顺序；没有标题时整页算一段。"""
    sections = []
    current = {"title": "", "text": []}

    def push_text(text):
        text = util.one_line(text, 20000)
        if text and not (chrome and _normalize_line(text) in chrome):
            current["text"].append(text)

    for block in blocks or []:
        if block.get("hidden"):
            continue
        kind = block.get("kind")
        if kind == "heading":
            if current["title"] or current["text"]:
                sections.append(current)
                current = {"title": "", "text": []}
            current["title"] = util.one_line(block.get("text", ""), 160)
        elif kind == "p":
            push_text(block.get("text", ""))
        elif kind == "quote":
            push_text(block.get("text", ""))
        elif kind == "list":
            for item in block.get("items") or []:
                if chrome and not _keep_line(item, chrome):
                    continue
                push_text(item)
        elif kind == "table":
            for row in block.get("rows") or []:
                cells = [util.one_line(cell, 200) for cell in row if util.one_line(cell, 200)]
                if cells:
                    push_text(" | ".join(cells))
    if current["title"] or current["text"]:
        sections.append(current)
    # 只剩标题的段（全站导航标题之类）没有内容价值
    return [section for section in sections if section["text"]]


def _specs_of(blocks):
    """规格：两列表格、以及"标签：值"这种列表项。"""
    specs = {}
    for block in blocks or []:
        if block.get("hidden"):
            continue
        if block.get("kind") == "table":
            for row in block.get("rows") or []:
                cells = [util.one_line(cell, 300) for cell in row]
                cells = [cell for cell in cells if cell]
                if len(cells) == 2 and cells[0] != cells[1]:
                    specs.setdefault(cells[0][:80], cells[1][:400])
        elif block.get("kind") == "list":
            for item in block.get("items") or []:
                text = util.one_line(item, 300)
                match = re.match(r"^([^：:]{2,30})[：:]\s*(.+)$", text)
                if match:
                    specs.setdefault(match.group(1).strip(), match.group(2).strip()[:400])
    return specs


def _images_of(data, image_map, chrome=None):
    """有序图片：正文块里的图优先，再补页面级图片。只留本地路径，剔除全站样板图。"""
    ordered = []
    seen = set()
    chrome = chrome or set()

    def add(src):
        if not src:
            return
        key = util.url_key(src)
        if key in chrome:
            return
        local = image_map.get(key, "")
        if local and local not in seen:
            seen.add(local)
            ordered.append(local)

    for block in data.get("blocks") or []:
        if block.get("kind") == "image" and not block.get("hidden"):
            add(block.get("src"))
    for image in data.get("images") or []:
        add(image.get("url"))
    return ordered


def _links_of(data, chrome=None):
    """页面链接，剔除全站导航链接；chrome 为空时原样返回。"""
    chrome = chrome or set()
    links = []
    seen = set()
    for link in data.get("links") or []:
        url = link.get("url") if isinstance(link, dict) else link
        if not url or not util.is_http(url):
            continue
        if util.path_of(url) in chrome:
            continue
        key = util.url_key(url)
        if key in seen:
            continue
        seen.add(key)
        links.append(url)
    return links


def build_record(state, record, data, site_name, chrome=None, chrome_pics=None,
                 chrome_links_set=None):
    blocks = data.get("blocks") or []
    sections = _sections_of(blocks, chrome)
    summary = util.one_line(data.get("description") or "", 500)
    if not summary:
        summary = util.one_line(data.get("og", {}).get("description") or "", 500)
    title = _strip_site_suffix(data.get("h1") or data.get("title"), site_name)

    source_id = ""
    match = re.search(r"(\d+)(?:\.aspx)?$", record["path"].rstrip("/"))
    if match:
        source_id = match.group(1)

    slug = util.slugify(title, 60, "") or util.slugify(source_id, 60, "")
    return {
        "sourceId": source_id,
        "url": record["url"],
        "path": record["path"],
        "title": title,
        "slug": slug,
        "summary": summary,
        "sections": [
            {"title": section["title"], "text": section["text"]} for section in sections
        ],
        "specs": _specs_of(blocks),
        "images": _images_of(data, state.get("imageMap", {}), chrome_pics),
        "links": _links_of(data, chrome_links_set)[:20],
        "pageFile": record.get("pageFile", ""),
    }


def _finalize_records(page_groups, site_name):
    """统一收尾：去掉标题里的分类/站点后缀，生成稳定 slug，并保证页面组内唯一。"""
    site_tail = util.norm_text(site_name) if site_name else ""

    def site_stripped(title):
        if site_tail and "_" in title:
            head, _, tail = title.rpartition("_")
            tail = util.norm_text(tail)
            # 站点名可能被截断（"厦门漫威智能影音" vs 全名），用包含关系判断
            if head.strip() and tail and (tail in site_tail or site_tail.endswith(tail)):
                return head.strip()
        return title

    # 候选后缀：分类页面组自己的标题（老站写成 标题_分类_站点名）+ 重复出现的末段
    category_names = set()
    for page_group in page_groups:
        if CATEGORY_HINTS.search(page_group["template"]) and not PRODUCT_HINTS.search(page_group["template"]):
            for record in page_group["records"]:
                name = util.norm_text(_clean_title(site_stripped(record["title"]), set()))
                if 2 <= len(name) <= 20:
                    category_names.add(name)

    tail_counts = {}
    for page_group in page_groups:
        for record in page_group["records"]:
            title = site_stripped(record["title"])
            if "_" in title:
                tail = util.norm_text(title.rsplit("_", 1)[1])
                if 2 <= len(tail) <= 20:
                    tail_counts[tail] = tail_counts.get(tail, 0) + 1

    known_tails = set(category_names)
    known_tails.update(tail for tail, count in tail_counts.items() if count >= 2)

    for page_group in page_groups:
        used = {}
        for record in page_group["records"]:
            title = _clean_title(site_stripped(record["title"]), known_tails)
            record["title"] = title
            slug = _slug_for(title, page_group["id"], record["sourceId"])
            count = used.get(slug, 0)
            used[slug] = count + 1
            record["slug"] = slug if not count else "%s-%d" % (slug, count + 1)


def _clean_title(title, known_tails):
    """反复剥掉末尾已知后缀，直到不再命中。"""
    text = util.one_line(title, 200)
    for _ in range(3):
        if "_" not in text:
            break
        head, _, tail = text.rpartition("_")
        if util.norm_text(tail) not in known_tails:
            break
        if len(head.strip()) < 2:
            break
        text = head.strip()
    return text


def _slug_for(title, page_group_id, source_id):
    """ASCII slug：标题能转出有意义的两段以上就用它，否则退回 页面组-来源ID。"""
    ascii_slug = util.slugify(title, 60, "")
    # 中文标题只能榨出一两个英文词时，slug 反而更难读，直接退回 页面组-来源ID
    meaningful = len(ascii_slug) >= 6 and bool(re.search(r"[a-z]{3,}", ascii_slug))
    if meaningful:
        return ascii_slug
    return "%s-%s" % (page_group_id, source_id or util.sha1_text(title)[:8])


def _field_presence(records):
    checks = {
        "title": lambda rec: bool(rec["title"]),
        "summary": lambda rec: bool(rec["summary"]),
        "sections": lambda rec: bool(rec["sections"]),
        "specs": lambda rec: bool(rec["specs"]),
        "images": lambda rec: bool(rec["images"]),
        "links": lambda rec: bool(rec["links"]),
    }
    total = max(1, len(records))
    presence = {}
    for name, check in checks.items():
        hits = sum(1 for record in records if check(record))
        presence[name] = round(hits / total, 2)
    return presence


def _shape_note(records):
    """这条页面组的记录更像商品还是长文？同一模板里混着两种时要提示。"""
    total = max(1, len(records))
    long_text = 0
    few_images = 0
    for record in records:
        chars = sum(len(" ".join(section["text"])) for section in record["sections"])
        if chars >= 600:
            long_text += 1
        if len(record["images"]) <= 3:
            few_images += 1
    share = long_text / total
    if share >= 0.6:
        return "长文为主（更像文章/案例，不像规格型商品）"
    if share >= 0.25:
        return "混杂：同一模板下既有长文又有短描述，建站时需按记录再分类"
    if few_images / total >= 0.5:
        return "短描述为主、图少（更像规格型条目）"
    return "短描述 + 多图（更像商品/案例条目）"


def _suggest_owner(template, presence, shape=""):
    """建议数据归属，仅作建站阶段的决策输入；混杂页面组不猜测唯一归属。"""
    if shape.startswith("混杂"):
        return {
            "owner": "待定（记录集需拆分）",
            "reason": "同一 URL 模板中存在不同内容形状；先按记录证据拆分，再分别决定归属",
        }
    if CATEGORY_HINTS.search(template) and not PRODUCT_HINTS.search(template):
        return {
            "owner": "Content（分类树）或 Commerce 分类",
            "reason": "路径名称含分类/列表线索；仍需用记录字段、父子关系和业务范围复核",
        }
    if PRODUCT_HINTS.search(template):
        return {
            "owner": "Commerce（商品/分类/变体）",
            "reason": "路径名称含商品线索；仍需用记录字段与业务范围复核，不能只凭 URL 决定",
        }
    if ARTICLE_HINTS.search(template):
        return {
            "owner": "Content（原生内容类型）",
            "reason": "URL 形态像文章/案例/新闻；用 Content 记录 + 列表/详情复用",
        }
    if presence.get("specs", 0) >= FIELD_COVERAGE or presence.get("images", 0) >= 0.9:
        return {
            "owner": "Content 或 SQLite（看是否需要筛选/排序/后台编辑）",
            "reason": "字段结构稳定但不是明显商品；条目少用 Content，需要查询排序用 SQLite",
        }
    return {
        "owner": "待定（needs-decision）",
        "reason": "字段不够稳定，先确认这个页面组是不是真的同一形状",
    }


def build(state, pages, out_dir, log=print, min_records=None):
    min_records = min_records or MIN_RECORDS
    data_dir = util.ensure_dir(os.path.join(out_dir, "data"))
    site_name = util.norm_text(state.get("siteName") or "")

    groups = {}
    for page in pages:
        template = url_template(page["path"])
        if not _is_numeric_record(template):
            continue
        groups.setdefault(template, []).append(page)

    chrome = chrome_set(state, pages, out_dir)
    chrome_pics = chrome_images(state, pages, out_dir)
    chrome_link_paths = chrome_links(state, pages, out_dir)
    log("data: 全站样板 %d 条文字 / %d 张图片 / %d 条链接（导航、页脚、站标）"
        % (len(chrome), len(chrome_pics), len(chrome_link_paths)))

    page_groups = []
    for template, members in sorted(groups.items(), key=lambda item: -len(item[1])):
        if len(members) < min_records:
            continue
        records = []
        for record in members:
            data = util.read_json(os.path.join(out_dir, ".work", "extract", record["id"] + ".json"))
            if not data:
                continue
            records.append(build_record(
                state, record, data, site_name, chrome, chrome_pics, chrome_link_paths))
        if not records:
            continue

        presence = _field_presence(records)
        usable = [name for name, ratio in presence.items() if ratio >= FIELD_COVERAGE]
        status = "ready" if len(usable) >= MIN_FIELDS else "unstable"
        shape = _shape_note(records)
        owner = _suggest_owner(template, presence, shape)
        fid = page_group_id(template)
        page_groups.append({
            "id": fid,
            "template": template,
            "count": len(records),
            "status": status,
            "fields": usable,
            "fieldPresence": presence,
            "owner": owner["owner"],
            "ownerReason": owner["reason"],
            "shape": shape,
            "sampleUrls": [record["url"] for record in records[:3]],
            "dataFile": "data/%s.json" % fid,
            "csvFile": "data/%s.csv" % fid,
            "records": records,
        })

    _finalize_records(page_groups, site_name)
    # 引用关系证据：有页面正文链到某页面组的记录，说明它是这个页面组的列表入口
    relations = _count_inbound_links(pages, page_groups, out_dir)
    log("data: %d 个候选页面组（>=%d 条）" % (len(page_groups), min_records))

    written = []
    for page_group in page_groups:
        if page_group["status"] != "ready":
            continue
        fid = page_group["id"]
        records = page_group["records"]
        parts = _write_parts(data_dir, fid, records)
        payload = {
            "pageGroup": fid,
            "source": state.get("source"),
            "template": page_group["template"],
            "count": len(records),
            "fields": page_group["fields"],
            "fieldPresence": page_group["fieldPresence"],
            "owner": page_group["owner"],
            "shape": page_group.get("shape", ""),
            "parts": parts,
        }
        # 索引文件永远是同一种形状：下游读 parts，再逐个读分片，不猜"这是数组还是对象"
        util.write_json(os.path.join(data_dir, fid + ".json"), payload)
        util.write_csv(
            os.path.join(data_dir, fid + ".csv"),
            CSV_COLUMNS,
            [[
                record["sourceId"], record["url"], record["title"], record["slug"],
                record["summary"],
                " / ".join(
                    (section["title"] + ": " if section["title"] else "") + " ".join(section["text"])
                    for section in record["sections"]
                )[:4000],
                "; ".join("%s=%s" % (key, value) for key, value in (record["specs"] or {}).items()),
                "|".join(record["images"]),
                "|".join(record["links"]),
            ] for record in records],
        )
        written.append(fid)

    summary = []
    for page_group in page_groups:
        page_group.pop("records", None)
        summary.append(page_group)
        page_group.pop("members", None)

    util.write_json(os.path.join(data_dir, "page-groups.json"), {
        "source": state.get("source"),
        "generatedAt": util.now_iso(),
        "minRecords": min_records,
        "pageGroups": summary,
        "relations": relations,
    })
    state["pageGroups"] = [
        {
            "id": page_group["id"],
            "template": page_group["template"],
            "count": page_group["count"],
            "status": page_group["status"],
            "fields": page_group["fields"],
            "owner": page_group["owner"],
            "shape": page_group.get("shape", ""),
            "dataFile": page_group["dataFile"],
            "csvFile": page_group["csvFile"],
        }
        for page_group in page_groups
    ]
    util.write_text(os.path.join(data_dir, "schema.md"), render_schema(state, summary, relations))
    return written


def _write_parts(data_dir, page_group_id_, records):
    """把记录切成若干分片，返回 [{file, count}]；单次 kfile 写入因此有界。"""
    parts = []
    chunk = []
    size = 0
    index = 1

    def flush():
        nonlocal chunk, size, index
        if not chunk:
            return
        name = "%s.part-%02d.json" % (page_group_id_, index)
        util.write_json(os.path.join(data_dir, name), {"records": chunk})
        parts.append({"file": "data/%s" % name, "count": len(chunk)})
        chunk = []
        size = 0
        index += 1

    for record in records:
        # 按 write_json 的 indent=2 折算：嵌套进 {"records": [...]} 后每行还会多缩进 2 格
        blob = json.dumps(record, ensure_ascii=False, indent=2)
        weight = len(blob.encode()) + 2 * blob.count("\n") + 6
        if chunk and size + weight > PART_BYTES:
            flush()
        chunk.append(record)
        size += weight
    flush()
    return parts


def _count_inbound_links(pages, page_groups, out_dir):
    """统计"谁链到了这个页面组"：列表页正文里指向详情页的内链次数。

    只作为证据：链接越多，越能确认一组页面确实是同一份数据的明细。
    """
    if not page_groups:
        return {}
    by_path = {}
    for page_group in page_groups:
        for record in page_group["records"]:
            by_path[record["path"]] = page_group["id"]
    # 先算每条内链出现在多少页：导航里每页都有的链接不能当"列表指向详情"的证据
    link_pages = {}
    seen_pages = 0
    for page in pages:
        data = util.read_json(os.path.join(out_dir, ".work", "extract", page["id"] + ".json"))
        if not data:
            continue
        seen_pages += 1
        for path in {util.path_of(link) for link in _links_of(data)}:
            link_pages[path] = link_pages.get(path, 0) + 1
    noisy = max(3, int(seen_pages * 0.5))

    counts = {}
    for page in pages:
        data = util.read_json(os.path.join(out_dir, ".work", "extract", page["id"] + ".json"))
        if not data:
            continue
        for link in _links_of(data):
            path = util.path_of(link)
            fid = by_path.get(path)
            if not fid or path == page["path"]:
                continue
            if link_pages.get(path, 0) > noisy:
                continue
            counts[fid] = counts.get(fid, 0) + 1
    return counts


def _type_of_field(name):
    return {
        "title": "字符串",
        "summary": "字符串（原站 meta description，通常就是规格摘要）",
        "sections": "数组 [{title, text[]}]，按原站标题切段",
        "specs": "对象 {标签: 值}，来自两列表格与「标签：值」列表项",
        "images": "有序数组，相对资料根的 images/... 路径",
        "links": "数组，原站正文里的站外/站内链接",
    }.get(name, "字符串")


def render_schema(state, page_groups, relations):
    """data/schema.md：给人看的字段字典 + 存储/路由建议 + 缺口。"""
    root = state.get("slug") or ""
    lines = ["# 动态数据模型（建议）", ""]
    lines.append("> 由 `site-harvest data` 从页面形状推断，**不是**原站的数据库结构。")
    lines.append("> 它只描述「哪些页面其实是同一条数据的不同记录」，存储归属与路由形态由建站阶段决定。")
    lines.append("")
    lines.append("## 页面组")
    lines.append("")
    if not page_groups:
        lines.append("没有发现达到当前阈值的数字 ID 候选页面组。其余页面仍按内容与路由清单处理；这不证明原站没有非数字 slug、查询参数或 API 驱动的动态内容。")
        return "\n".join(lines) + "\n"

    lines.append("| 页面组 | URL 模板 | 记录数 | 字段 | 建议归属 | 状态 |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for page_group in page_groups:
        lines.append("| `%s` | `%s` | %d | %s | %s | %s |" % (
            page_group["id"], page_group["template"], page_group["count"],
            "、".join(page_group["fields"]) or "—", page_group["owner"], page_group["status"]))
    lines.append("")

    for page_group in page_groups:
        lines.append("## %s" % page_group["id"])
        lines.append("")
        lines.append("- URL 模板：`%s`（%d 条记录）" % (page_group["template"], page_group["count"]))
        lines.append("- 状态：%s" % ("可用" if page_group["status"] == "ready" else "字段不稳，需人工确认"))
        lines.append("- 建议归属：%s" % page_group["owner"])
        lines.append("- 理由：%s" % page_group["ownerReason"])
        if page_group.get("shape"):
            lines.append("- 记录形状：%s" % page_group["shape"])
        lines.append("- 数据文件：`%s`、`%s`" % (page_group["dataFile"], page_group["csvFile"]))
        lines.append("- 字段完整率：" + "、".join(
            "%s %d%%" % (name, int(ratio * 100))
            for name, ratio in page_group["fieldPresence"].items()))
        lines.append("")
        lines.append("| 字段 | 类型 |")
        lines.append("| --- | --- |")
        for name in page_group["fields"]:
            lines.append("| `%s` | %s |" % (name, _type_of_field(name)))
        lines.append("")
        lines.append("样例：" + "、".join("`%s`" % url for url in page_group["sampleUrls"]))
        lines.append("")

    if relations:
        lines.append("## 引用关系证据")
        lines.append("")
        lines.append("列表页正文里指向同页面组记录的内链次数（越多越说明是同一候选页面组）：")
        lines.append("")
        for fid, count in sorted(relations.items(), key=lambda item: -item[1]):
            lines.append("- `%s`：%d 次" % (fid, count))
        lines.append("")

    lines.append("## 怎么用这些数据")
    lines.append("")
    lines.append("1. **不要逐记录复制页面**：复核候选页面组边界；确认数据化后，用一个记录集和共享列表/详情路由、模板承接。")
    lines.append("2. 建议保留原 URL 形态 `%s`，用带路径参数的路由承接；改写成 SEO 路径需要单独的 301 决定。" %
                 (page_groups[0]["template"] if page_groups else "/"))
    lines.append("3. 灌数据用 KScript：先读 `data/<pageGroup>.json` 索引拿到 `parts`，逐个 `k.file.read` + `JSON.parse` 分片，再按 `sourceId` 幂等写入并回读计数。分片是为了让单次写入有界。")
    lines.append("4. 字段缺失就留空，不要补写；`summary` 是原站 meta description，通常是规格摘要而非正文。")
    lines.append("5. `slug` 是占位：中文标题转不出英文时退化成 `<pageGroup>-<来源ID>`。SEO 路径在建站阶段决定，`sourceId` 才是幂等键。")
    lines.append("6. 「建议归属」是推断，不是结论；商品/文章混在同一 URL 模板时，按记录的 `sections` 长短与分类再分一次。")
    lines.append("7. 图片路径是相对资料根的 `images/...`，进站点后用 `list_site_object(objectType=\"CmsFile\")` 换真实 URL。")
    lines.append("")
    if root:
        lines.append("> 资料包根目录：`_materials/%s/`，数据在 `_materials/%s/data/`。" % (root, root))
        lines.append("")
    return "\n".join(lines)


def run(state, out_dir, log=print, min_records=None):
    """从收录 URL 直接建页面组：不依赖 render 的产物，随时可重跑。"""
    pages = [
        {"id": record["id"], "url": record["url"], "path": record["path"],
         "pageFile": record.get("pageFile", "")}
        for record in state["urls"].values()
        if record.get("action") == "keep"
    ]
    return build(state, pages, out_dir, log=log, min_records=min_records)
