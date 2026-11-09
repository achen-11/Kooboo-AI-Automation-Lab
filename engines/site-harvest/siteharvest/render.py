"""Render the package: README, page files, SEO tables, structure and inventory."""

import json
import os
import re

from . import completeness, discover, util

MAX_README_PAGES = 80


def _readme_root(state):
    return "_materials/" + state["slug"]


def _load(out_dir, record):
    return util.read_json(os.path.join(out_dir, ".work", "extract", record["id"] + ".json"))


def _block_markdown(block, image_map):
    if block.get("hidden"):
        suffix = " <!-- hidden -->"
    else:
        suffix = ""
    kind = block.get("kind")
    if kind == "heading":
        level = max(2, min(6, block.get("level", 2)))
        return "%s %s%s" % ("#" * level, util.md_escape(block.get("text", "")), suffix)
    if kind == "p":
        return util.md_escape(block.get("text", "")) + suffix
    if kind == "quote":
        body = "\n".join("> " + line for line in block.get("text", "").split("\n"))
        return body + suffix
    if kind == "code":
        return "```\n%s\n```%s" % (block.get("text", ""), suffix)
    if kind == "list":
        lines = []
        for index, item in enumerate(block.get("items", []), start=1):
            text = util.one_line(item, 2000)
            lines.append(("- " if not block.get("ordered") else "%d. " % index) + text)
        return "\n".join(lines) + suffix
    if kind == "table":
        rows = block.get("rows") or []
        if not rows:
            return ""
        width = max(len(row) for row in rows)
        rows = [row + [""] * (width - len(row)) for row in rows]
        header = rows[0]
        lines = ["| " + " | ".join(util.md_escape(cell) for cell in header) + " |",
                 "|" + "|".join([" --- "] * width) + "|"]
        for row in rows[1:]:
            lines.append("| " + " | ".join(util.md_escape(cell) for cell in row) + " |")
        return "\n".join(lines) + suffix
    if kind == "image":
        src = block.get("src", "")
        alt = util.md_escape(block.get("alt", "") or "")
        local = image_map.get(util.url_key(src))
        if local:
            return "![%s](%s)%s" % (alt, local, suffix)
        return "> 图片未取到：%s%s%s" % (src, ("（alt: %s）" % alt) if alt else "", suffix)
    if kind == "embed":
        return "> 嵌入内容（%s）：%s%s" % (block.get("tag", "embed"),
                                       block.get("src") or block.get("poster") or "", suffix)
    return ""


def _sections(blocks):
    sections = []
    current = {"title": "", "blocks": []}
    for block in blocks:
        if block.get("kind") == "heading" and block.get("level", 9) <= 2:
            if current["blocks"] or current["title"]:
                sections.append(current)
            current = {"title": block.get("text", ""), "blocks": [block]}
        else:
            current["blocks"].append(block)
    if current["blocks"] or current["title"]:
        sections.append(current)
    if not sections:
        return [{"title": "", "blocks": []}]
    return sections


def render_page(state, record, data):
    image_map = state.get("imageMap", {})
    root = _readme_root(state)
    lines = []
    title = data.get("title") or data.get("h1") or record["path"]
    lines.append("# " + util.one_line(title, 200))
    lines.append("")
    lines.append("- URL：%s" % record["url"])
    lines.append("- 路由：%s" % record["path"])
    lines.append("- 类型：%s" % data.get("pageType", ""))
    lines.append("- 状态：%s" % record.get("status", ""))
    lines.append("- 整页文字与提取证据：`%s/site/evidence/%s.json`（含页眉页脚、完整 JSON-LD 与语言标记）"
                 % (root, record["id"]))
    if data.get("lang"):
        lines.append("- 语言：%s" % data["lang"])
    lines.append("- 字数：%d" % data.get("words", 0))
    lines.append("- 图片：%d" % len(data.get("images", [])))
    if data.get("description"):
        lines.append("- 描述：%s" % util.one_line(data["description"], 400))
    if data.get("canonical"):
        lines.append("- Canonical：%s" % data["canonical"])
    if data.get("robots"):
        lines.append("- Robots：%s" % data["robots"])
    types = [item.get("type") for item in data.get("jsonld", []) if item.get("type")]
    if types:
        lines.append("- 结构化数据：%s" % "、".join(types))
    hidden = data.get("hiddenBlocks") or 0
    if hidden:
        lines.append("- 原站默认隐藏的内容块：%d（已保留，标注 %s）" % (hidden, "<!-- hidden -->"))
    lines.append("")
    lines.append("> 文本路径：%s/%s" % (root, record["pageFile"]))
    lines.append("")

    for section in _sections(data.get("blocks", [])):
        if section["title"]:
            lines.append("## " + util.md_escape(section["title"]))
            lines.append("")
        elif section["blocks"]:
            lines.append("## 内容")
            lines.append("")
        for block in section["blocks"]:
            if block.get("kind") == "heading" and block.get("text") == section["title"]:
                continue
            rendered = _block_markdown(block, image_map)
            if rendered:
                lines.append(rendered)
                lines.append("")

    if data.get("forms"):
        lines.append("## 表单")
        lines.append("")
        for index, form in enumerate(data["forms"], start=1):
            lines.append("### 表单 %d" % index)
            lines.append("")
            lines.append("- action：%s" % (form.get("action") or "（页面内）"))
            lines.append("- method：%s" % (form.get("method") or "get"))
            for field in form.get("fields", []):
                parts = ["`%s`" % field.get("name", ""), field.get("type", "text")]
                if field.get("label"):
                    parts.append("标签/占位：%s" % field["label"])
                if field.get("required"):
                    parts.append("必填")
                if field.get("options"):
                    parts.append("选项：" + "、".join(field["options"][:10]))
                lines.append("- " + " · ".join(parts))
            lines.append("")

    if data.get("embeds"):
        lines.append("## 嵌入内容")
        lines.append("")
        for embed in data["embeds"]:
            lines.append("- %s：%s" % (embed.get("tag", "embed"),
                                      embed.get("src") or embed.get("poster") or ""))
            for source in embed.get("sources", [])[1:]:
                lines.append("  - 其他来源：%s" % source["url"])
        lines.append("")

    if data.get("contactLinks"):
        lines.extend(["## 联系链接", ""])
        for link in data["contactLinks"]:
            lines.append("- %s：%s" % (link.get("text") or "联系", link["url"]))
        lines.append("")

    external = [link for link in data.get("links", [])
                if link.get("where") == "content" and util.host_of(link["url"]) != util.host_of(record["url"])]
    external = [link for link in external if not link["url"].startswith(("mailto:", "tel:"))]
    if external:
        lines.append("## 外部链接")
        lines.append("")
        lines.append("| 文本 | 地址 |")
        lines.append("| --- | --- |")
        for link in external[:30]:
            lines.append("| %s | %s |" % (util.md_escape(util.one_line(link.get("text"), 80) or "（无文本）"),
                                          link["url"]))
        lines.append("")

    loose = [image for image in data.get("images", []) if not image.get("inContent")]
    if loose:
        lines.append("## 本页其他图片")
        lines.append("")
        lines.append("> 这些图片在原站属于本页，但不在正文块内（页眉、页脚、布局单元或纯图片链接）。")
        lines.append("")
        lines.append("| 文件 | 原地址 | alt | 位置 | 上下文 |")
        lines.append("| --- | --- | --- | --- | --- |")
        for image in loose[:30]:
            local = image_map.get(util.url_key(image["url"]), "")
            lines.append("| %s | %s | %s | %s | %s |" % (
                local or "（未取到）", image["url"], util.md_escape(image.get("alt", "") or ""),
                image.get("where", ""), util.md_escape(image.get("context", "") or "")))
        lines.append("")

    raw_ld = data.get("jsonldRaw") or []
    if raw_ld:
        lines.append("## 结构化数据（原文）")
        lines.append("")
        for item in raw_ld[:3]:
            payload = item.get("data") if "data" in item else item.get("raw")
            text = json.dumps(payload, ensure_ascii=False, indent=2) if payload is not None else ""
            lines.append("```json")
            lines.append(text[:1500])
            lines.append("```")
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_readme(state, pages, out_dir):
    root = _readme_root(state)
    origin = state.get("origin", "")
    counts = state.get("counts", {})
    stats = state.get("assetStats", {})
    mode = state.get("mode", "B")
    total_pages = len(pages)
    words = sum(page.get("words", 0) for page in pages)
    lines = []
    lines.append("# " + (state.get("siteName") or origin.replace("https://", "").replace("http://", "")))
    lines.append("")
    lines.append("> 由 `site-harvest` 从原站采集的资料包，不是设计稿。模式 %s，采集于 %s。"
                 % (mode, state.get("startedAt", "")))
    lines.append("")
    lines.append("## 这是什么")
    lines.append("")
    lines.append("- 原站：%s" % state["source"])
    lines.append("- 采集范围：%d 个页面（发现 %d，超上限 %d，排除 %d），约 %d 字" % (
        total_pages, counts.get("discovered", 0), counts.get("overLimit", 0),
        counts.get("excluded", 0), words))
    lines.append("- 图片：%d 张（失败 %d）" % (stats.get("images", 0), stats.get("imagesFailed", 0)))
    lines.append("- 文档：%d 个（失败 %d）" % (stats.get("documents", 0), stats.get("documentsFailed", 0)))
    if state.get("primaryLang"):
        lines.append("- 主语言：%s（只采主语言版本）" % state["primaryLang"])
    report = state.get("completeness", {})
    lines.append("- 采集完整性：%s；已知缺口 %d，待复核 %d。详见 `%s/site/completeness.md` 与 `completeness.json`。"
                 % (report.get("status", "unknown"), report.get("gaps", 0), report.get("reviews", 0), root))
    lines.append("- 统计分母仅为已发现的 URL 和素材，不能据此宣称全站 100% 覆盖。")
    lines.append("")
    lines.append("## 三个对象")
    lines.append("")
    lines.append("- **原站** = `%s`：内容与 URL 的唯一权威，也是本次要重建的对象。" % state["source"])
    lines.append("- **参考站** = %s。" % ("见会话首条消息，只提供视觉方向" if mode == "A" else "无"))
    lines.append("- **目标站** = 当前这个 Kooboo 站点。")
    lines.append("")
    lines.append("## 模式")
    lines.append("")
    if mode == "A":
        lines.append("A 重构：原站的版式与样式不在本包范围内，视觉方向由参考站决定。")
        lines.append("页面内部结构可按参考站重排，但已采内容不得丢失；实际采集边界以完整性报告为准。")
    else:
        lines.append("B 迁移：原站是内容与路由的唯一权威，重建结果应与原站逐页对应，URL 逐字一致。")
        lines.append("本包不含版式与样式，不要试图从本包还原原站外观。")
    lines.append("")
    lines.append("## 硬约束")
    lines.append("")
    lines.append("1. **URL 逐字保留**：以 `%s/site/seo/routes.csv` 为准，不要新增、合并或改写路径。" % root)
    lines.append("2. **内容以本包为准**：不要增删事实、价格、联系方式；不要翻译或改写文案。")
    lines.append("3. **本包不含版式**：不要从本包推断原站的布局、配色或字体。")
    lines.append("4. **图片**在 `%s/images/`，用 `list_site_object(objectType=\"CmsFile\")` 取真实 URL；"
                 "README 与页面文件里的 `images/...` 是相对这个目录的路径。" % root)
    lines.append("5. **缺口已列明**：`%s/site/coverage.csv` 里 标记为 failed/exclude 的地址不要补写内容，"
                 "需要补采时按完整性报告定向补充，并更新资料包与证据。" % root)
    lines.append("")
    lines.append("## 页面清单")
    lines.append("")
    lines.append("| # | 路由 | 类型 | 文件 | 字数 | 图片 |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for index, page in enumerate(pages[:MAX_README_PAGES], start=1):
        lines.append("| %d | %s | %s | `%s/%s` | %d | %d |" % (
            index, page["path"], page.get("pageType", ""), root, page["pageFile"],
            page.get("words", 0), page.get("images", 0)))
    if len(pages) > MAX_README_PAGES:
        lines.append("")
        lines.append("> 其余 %d 个页面见 `%s/site/seo/routes.csv`。" % (len(pages) - MAX_README_PAGES, root))
    lines.append("")
    lines.append("## 全站结构")
    lines.append("")
    nav = state.get("nav", [])
    if nav:
        lines.append("导航（首页提取）：" + "、".join(util.one_line(item.get("text"), 30) for item in nav[:15]))
        lines.append("")
    lines.append("导航树、页脚、页面层级与内链分布见 `%s/site/structure.md`。" % root)
    lines.append("")
    lines.append("## 内容盘点")
    lines.append("")
    by_type = {}
    for page in pages:
        by_type[page.get("pageType", "unknown")] = by_type.get(page.get("pageType", "unknown"), 0) + 1
    lines.append("| 类型 | 数量 |")
    lines.append("| --- | --- |")
    for key, value in sorted(by_type.items(), key=lambda item: -item[1]):
        lines.append("| %s | %d |" % (key, value))
    lines.append("")
    lines.append("文档、表单、嵌入、邮箱电话等清单见 `%s/site/inventory.md` 与 `features.md`。" % root)
    lines.append("")
    page_groups = state.get("pageGroups") or []
    if page_groups:
        lines.append("## 动态内容（候选页面组）")
        lines.append("")
        lines.append("以下页面可能是同一记录集的多条记录，先读 `schema.md` 复核边界与混杂警告。**不要逐页复制**；确认数据化后使用共享列表/详情路由和模板，最终归属由建站阶段决定。")
        lines.append("")
        lines.append("| 页面组 | URL 模板 | 记录数 | 字段 | 建议归属 | 状态 |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for page_group in page_groups:
            lines.append("| `%s` | `%s` | %d | %s | %s | %s |" % (
                page_group["id"], page_group["template"], page_group["count"],
                "、".join(page_group.get("fields") or []) or "—",
                page_group.get("owner", ""), page_group.get("status", "")))
        lines.append("")
        lines.append("数据在 `%s/data/`：`page-groups.json` 是总表；`<pageGroup>.json` 是索引（`parts` 指向分片 `part-NN.json`，分片里才是记录）；`<pageGroup>.csv` 给人核对；`schema.md` 是字段字典与存储建议。" % root)
        lines.append("")
        lines.append("灌数据的方式：读 `_materials/%s/data/<pageGroup>.json` 索引 → 逐个读 `parts` 分片 → 按 `sourceId` 幂等写入 → 回读计数；图片路径按 `list_site_object(objectType=\"CmsFile\")` 换成真实 URL。" % (state.get("slug") or ""))
        lines.append("")
    lines.append("## 缺口与待决策")
    lines.append("")
    gaps = state.get("gaps") or []
    if gaps:
        for gap in gaps:
            lines.append("- " + gap)
    else:
        lines.append("- 无")
    lines.append("")
    lines.append("## 怎么用")
    lines.append("")
    lines.append("1. 先读本文件，再按页面清单逐页读 `%s/site/pages/...`。" % root)
    lines.append("2. URL 与重定向以 `%s/site/seo/routes.csv`、`redirects.csv` 为准。" % root)
    lines.append("3. 图片按 `%s/site/assets.csv` 的原地址与本地路径对应关系取用。" % root)
    lines.append("4. 未取到的图片、被排除的页面、含文字信息的图片都在缺口里说明，不要自行编造。")
    lines.append("")
    return "\n".join(lines)


def render_structure(state, pages, out_dir):
    lines = ["# 全站结构", ""]
    lines.append("## 导航（首页）")
    lines.append("")
    nav = state.get("nav", [])
    if nav:
        lines.append("| 文本 | 地址 |")
        lines.append("| --- | --- |")
        for item in nav[:60]:
            lines.append("| %s | %s |" % (util.md_escape(util.one_line(item.get("text"), 60)), item["url"]))
    else:
        lines.append("（未提取到导航）")
    lines.append("")
    lines.append("## 页脚链接")
    lines.append("")
    footer = state.get("footer", [])
    if footer:
        lines.append("| 文本 | 地址 |")
        lines.append("| --- | --- |")
        for item in footer[:60]:
            lines.append("| %s | %s |" % (util.md_escape(util.one_line(item.get("text"), 60)), item["url"]))
    else:
        lines.append("（未提取到页脚）")
    lines.append("")
    lines.append("## 页面层级")
    lines.append("")
    for page in sorted(pages, key=lambda item: item["path"]):
        depth = max(0, page["path"].split("?")[0].strip("/").count("/"))
        lines.append("%s- `%s`（%s）" % ("  " * depth, page["path"], page.get("pageType", "")))
    lines.append("")
    lines.append("## 内链 Top")
    lines.append("")
    counts = state.get("linkCounts") or {}
    for path, count in sorted(counts.items(), key=lambda item: -item[1])[:25]:
        lines.append("- %d × `%s`" % (count, path))
    return "\n".join(lines) + "\n"


def render_inventory(state, pages, out_dir):
    lines = ["# 内容盘点", ""]
    lines.append("## 页面")
    lines.append("")
    lines.append("| 路由 | 标题 | 字数 | 图片 | 表格 | 表单 |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for page in pages:
        data = _load(out_dir, page) or {}
        lines.append("| %s | %s | %d | %d | %d | %d |" % (
            page["path"], util.md_escape(util.one_line(data.get("title"), 60)),
            page.get("words", 0), len(data.get("images", [])),
            len(data.get("tables", [])), len(data.get("forms", []))))
    lines.append("")
    files = state.get("files", [])
    lines.append("## 文档")
    lines.append("")
    if files:
        lines.append("| 文件 | 原地址 | 所在页 | 取回 |")
        lines.append("| --- | --- | --- | --- |")
        for item in files[:80]:
            lines.append("| %s | %s | %s | %s |" % (
                item.get("localPath") or "（未取到）", item["url"], item.get("pageUrl", ""),
                item.get("status", "")))
    else:
        lines.append("（无）")
    lines.append("")
    lines.append("## 联系方式")
    lines.append("")
    emails = state.get("emails") or []
    phones = state.get("phones") or []
    lines.append("- 邮箱：" + ("、".join(emails) if emails else "（未提取到）"))
    lines.append("- 电话：" + ("、".join(phones) if phones else "（未提取到）"))
    return "\n".join(lines) + "\n"


def render_features(state, pages, out_dir):
    lines = ["# 功能与第三方依赖", ""]
    rows = []
    for page in pages:
        data = _load(out_dir, page) or {}
        for form in data.get("forms", []):
            rows.append((page["path"], "表单", form.get("action") or "（页面内）", form.get("method", "")))
        for embed in data.get("embeds", []):
            rows.append((page["path"], "嵌入", embed.get("src") or embed.get("poster") or "", embed.get("tag", "")))
        hosts = {}
        for link in data.get("links", []):
            host = util.host_of(link["url"])
            if host and host != util.host_of(page["url"]):
                hosts[host] = hosts.get(host, 0) + 1
        for host, count in sorted(hosts.items(), key=lambda item: -item[1])[:5]:
            rows.append((page["path"], "外部链接", host, "%d 次" % count))
    if rows:
        lines.append("| 页面 | 类型 | 目标 | 说明 |")
        lines.append("| --- | --- | --- | --- |")
        for row in rows[:300]:
            lines.append("| %s | %s | %s | %s |" % tuple(util.md_escape(str(cell)) for cell in row))
    else:
        lines.append("（未发现表单、嵌入或外部链接）")
    return "\n".join(lines) + "\n"


def _pattern_of(path):
    if "?" in path:
        query = path.split("?", 1)[1]
        if re.search(r"(^|&)(id|p|pid|pg|page|cat|category)=", query, re.I):
            return "query-param"
        return "query-other"
    if re.search(r"\.(html?|php|aspx?|jsp|asp)$", path, re.I):
        return "static-ext"
    if re.search(r"/\d{4}/\d{2}/", path):
        return "dated"
    if re.search(r"/\d+/?$", path):
        return "numeric-id"
    if path.endswith("/"):
        return "clean-slash"
    if path.count("/") <= 2:
        return "clean"
    return "nested"


def render_seo(state, pages, out_dir):
    seo_dir = os.path.join(out_dir, "site", "seo")
    util.ensure_dir(seo_dir)

    rows = []
    for page in pages:
        data = _load(out_dir, page) or {}
        rows.append([
            page["id"], page["path"], page["url"], page.get("status"), page.get("pageType"),
            data.get("title"), data.get("description"), data.get("canonical"),
            data.get("robots"), data.get("lang"), page.get("words", 0),
            page.get("images", 0), "yes" if page.get("inSitemap") else "no",
        ])
    util.write_csv(os.path.join(seo_dir, "urls.csv"),
                   ["id", "path", "url", "status", "page_type", "title", "description",
                    "canonical", "robots", "lang", "words", "images", "in_sitemap"], rows)

    routes = []
    redirects = []
    for record in sorted(state["urls"].values(), key=lambda item: item["path"]):
        if record["action"] == "keep" and record.get("pageFile"):
            action = "keep"
            note = ""
            if "?" in record["path"]:
                action = "needs-decision"
                note = "带查询参数的页面，无法直接静态化，需要决定保留查询还是 301"
            routes.append([record["path"], record.get("pageType"), record["pageFile"],
                           record["path"], action, note])
        elif record["action"] == "alias":
            target = (record.get("finalUrl") or "").replace(state.get("origin", ""), "") or record.get("finalUrl")
            code = str((record.get("redirects") or [{}])[0].get("status") or "redirect")
            routes.append([record["path"], "", "", target, code, "实测跳转，目标：%s" % record.get("finalUrl")])
        for hop in record.get("redirects") or []:
            redirects.append([hop.get("from"), hop.get("status"), hop.get("to")])
    by_path = {}
    for row in routes:
        by_path.setdefault(row[0], []).append(row)
    routes = []
    state["routeConflicts"] = []
    for path, candidates in by_path.items():
        captured = [row for row in candidates if row[2]]
        row = list((captured or candidates)[0])
        if len(captured) > 1:
            row[4] = "needs-decision"
            row[5] = "同路径存在多个来源版本，未合并内容：" + ", ".join(c[2] for c in captured)
            state["routeConflicts"].append(path)
        routes.append(row)
    util.write_csv(os.path.join(seo_dir, "routes.csv"),
                   ["source_path", "page_type", "page_file", "proposed_path", "action", "note"], routes)
    util.write_csv(os.path.join(seo_dir, "redirects.csv"),
                   ["from", "status", "to"], redirects)

    groups = {}
    for record in state["urls"].values():
        if record["action"] not in ("keep", "alias"):
            continue
        groups.setdefault(_pattern_of(record["path"]), []).append(record)
    lines = ["# URL 形态", "",
             "默认策略：能静态化的逐字保留；带查询参数的只记录，不擅自改写。", ""]
    lines.append("| 形态 | 数量 | 示例 | 处理建议 |")
    lines.append("| --- | --- | --- | --- |")
    advice = {
        "static-ext": "逐字保留后缀与大小写",
        "clean": "逐字保留",
        "clean-slash": "逐字保留末尾斜杠",
        "nested": "逐字保留",
        "dated": "逐字保留日期路径",
        "numeric-id": "逐字保留数字段",
        "query-param": "需要决定：保留查询路由，或 301 到干净路径",
        "query-other": "需要决定：查询是否影响内容",
    }
    for pattern, records in sorted(groups.items(), key=lambda item: -len(item[1])):
        sample = "、".join(record["path"] for record in records[:3])
        lines.append("| %s | %d | %s | %s |" % (pattern, len(records), util.md_escape(sample),
                                               advice.get(pattern, "")))
    lines.append("")
    lines.append("> 本 skill 不改写路由；`needs-decision` 的行需要在建站阶段确认。")
    util.write_text(os.path.join(seo_dir, "patterns.md"), "\n".join(lines) + "\n")

    for name in ("sitemap.xml", "robots.txt"):
        source = os.path.join(out_dir, ".work", name)
        if os.path.exists(source):
            with open(source, "r", encoding="utf-8") as handle:
                util.write_text(os.path.join(seo_dir, name), handle.read())


def render_assets(state, out_dir):
    rows = []
    for item in state.get("assets", []):
        rows.append(["image", item.get("localPath") or "", item.get("url") or "",
                     item.get("pageUrl") or "", item.get("role") or "", item.get("alt") or "",
                     item.get("bytes") or 0, item.get("width") or 0, item.get("height") or 0,
                     item.get("status") or "", item.get("note") or ""])
    for item in state.get("files", []):
        rows.append(["document", item.get("localPath") or "", item.get("url") or "",
                     item.get("pageUrl") or "", "", item.get("text") or "",
                     item.get("bytes") or 0, 0, 0, item.get("status") or "", item.get("note") or ""])
    util.write_csv(os.path.join(out_dir, "site", "assets.csv"),
                   ["kind", "local_path", "source_url", "page_url", "role", "alt",
                    "bytes", "width", "height", "status", "note"], rows)


def render_coverage(state, out_dir):
    rows = []
    for record in sorted(state["urls"].values(), key=lambda item: item["id"]):
        rows.append([
            record["id"], record["url"], record["path"], record.get("pageType"),
            record.get("status"), record["action"], record.get("reason"),
            record.get("pageFile"), record.get("words", 0), record.get("images", 0),
            "yes" if record.get("inSitemap") else "no", ",".join(record.get("sources") or []),
        ])
    util.write_csv(os.path.join(out_dir, "site", "coverage.csv"),
                   ["id", "url", "path", "page_type", "status", "action", "reason",
                    "page_file", "words", "images", "in_sitemap", "sources"], rows)
    return len(rows)


def find_duplicates(state, pages, out_dir):
    groups = {}
    for page in pages:
        data = _load(out_dir, page) or {}
        parts = []
        for block in data.get("blocks", []):
            if block.get("kind") in ("p", "heading"):
                parts.append(block.get("text") or "")
            elif block.get("kind") == "list":
                parts.extend(block.get("items") or [])
        text = util.collapse(" ".join(parts))
        if len(text) < 200:
            continue
        digest = util.sha1_text(text)
        groups.setdefault(digest, []).append(page["path"])
    return [paths for paths in groups.values() if len(paths) > 1]


def build_gaps(state, pages, out_dir):
    gaps = []
    duplicates = find_duplicates(state, pages, out_dir)
    if duplicates:
        sample = "；".join("、".join(group[:3]) for group in duplicates[:3])
        gaps.append("%d 组页面正文完全相同（可能是预览副本或多路径同内容），确认后可用 --exclude-prefix 排除：%s"
                    % (len(duplicates), sample))
    noindex = []
    offsite = []
    for page in pages:
        data = _load(out_dir, page) or {}
        robots = (data.get("robots") or "").lower()
        if "noindex" in robots:
            noindex.append(page["path"])
        canonical = data.get("canonical") or ""
        if canonical and util.canonical_host(util.host_of(canonical)) != util.canonical_host(util.host_of(page["url"])):
            offsite.append(page["path"])
    if noindex:
        gaps.append("%d 个页面带 noindex（测试环境常见），迁移时不要继承：%s"
                    % (len(noindex), "、".join(noindex[:5])))
    if offsite:
        gaps.append("%d 个页面的 canonical 指向其他域名，重建时按正式域名决定：%s"
                    % (len(offsite), "、".join(offsite[:5])))
    failed = [r for r in state["urls"].values() if r["action"] == "failed"]
    if failed:
        sample = "、".join("%s（%s）" % (r["path"], r.get("reason")) for r in failed[:5])
        gaps.append("%d 个页面抓取失败：%s——这些页面没有内容，需要人工确认是否补采。" % (len(failed), sample))
    soft = [r for r in state["urls"].values() if r.get("reason") == "soft-404"]
    if soft:
        gaps.append("%d 个地址返回软 404（状态 200 但内容是错误页），未纳入页面。" % len(soft))
    other = [r for r in state["urls"].values() if r["action"] == "exclude" and r.get("reason") == "other-language"]
    if other:
        gaps.append("%d 个其他语言版本未采集（本包只采主语言）。" % len(other))
    over = [r for r in state["urls"].values() if r["action"] == "over-limit"]
    if over:
        gaps.append("%d 个 URL 超出采集上限，未抓取；需要时提高 --max-pages 重跑。" % len(over))
    missing_images = [a for a in state.get("assets", []) if a.get("status") == "failed"]
    if missing_images:
        gaps.append("%d 张图片未取到（见 assets.csv，status=failed）。" % len(missing_images))
    decision = [r for r in state["urls"].values() if "?" in r["path"] and r["action"] == "keep"]
    if decision:
        gaps.append("%d 个页面带查询参数，路由保留方式待决（见 seo/patterns.md）。" % len(decision))
    text_images = len([a for a in state.get("assets", []) if a.get("status") in ("saved", "deduped")])
    if text_images:
        gaps.append("图片共 %d 张，已原样保留；其中可能含文字信息（老站常见），重建时优先保留原图，不要替换为装饰图。"
                    % text_images)
    if state.get("sitemap", {}).get("truncated"):
        gaps.append("sitemap 索引超过抓取上限，可能还有未发现的子 sitemap。")
    if not state.get("sitemap", {}).get("files"):
        gaps.append("没有找到 sitemap，页面清单只来自导航与正文链接，建议人工补充。")
    report = state.get("completeness", {})
    if report.get("gaps") or report.get("reviews"):
        gaps.append("完整缺口逐项见 site/completeness.md（含深度截断、文档/CSS 失败及交互待复核）；发现依据见 site/discovery.json。")
    state["gaps"] = gaps
    return gaps


def gc_unreferenced(out_dir, state):
    """清掉上次采集留下、本次没有被引用的图片/文档，避免上传无用文件。"""
    keep = {item.get("localPath") for item in state.get("assets", []) if item.get("localPath")}
    keep |= {item.get("localPath") for item in state.get("files", []) if item.get("localPath")}
    for base in ("images", "files"):
        root_dir = os.path.join(out_dir, base)
        if not os.path.isdir(root_dir):
            continue
        for root, _dirs, names in os.walk(root_dir, topdown=False):
            for name in names:
                path = os.path.join(root, name)
                rel = os.path.relpath(path, out_dir).replace(os.sep, "/")
                if rel not in keep:
                    try:
                        os.remove(path)
                    except OSError:
                        pass
            if root != root_dir and not os.listdir(root):
                try:
                    os.rmdir(root)
                except OSError:
                    pass


def run(state, out_dir, log=print):
    discover.refresh_counts(state)
    pages = sorted(
        [r for r in state["urls"].values() if r["action"] == "keep" and r.get("pageFile")],
        key=lambda r: (0 if r.get("pageType") == "home" else 1, r["depth"], r["path"]),
    )
    log("render: %d 个页面" % len(pages))

    # 内链统计
    counts = {}
    for page in pages:
        data = _load(out_dir, page) or {}
        for link in data.get("links", []):
            key = util.route_of(link["url"])
            counts[key] = counts.get(key, 0) + 1
    state["linkCounts"] = counts

    for page in pages:
        data = _load(out_dir, page)
        if not data:
            continue
        text = render_page(state, page, data)
        util.write_text(os.path.join(out_dir, page["pageFile"]), text)
        util.write_json(os.path.join(out_dir, "site", "evidence", page["id"] + ".json"), data)
    expected = {
        "pages": {os.path.basename(p["pageFile"]) for p in pages},
        "evidence": {p["id"] + ".json" for p in pages},
    }
    for folder, current in expected.items():
        directory = os.path.join(out_dir, "site", folder)
        if os.path.isdir(directory):
            for name in os.listdir(directory):
                generated = (re.match(r"^\d+-.+\.md$", name) if folder == "pages"
                             else re.match(r"^u\d+\.json$", name))
                if generated and name not in current:
                    os.remove(os.path.join(directory, name))

    util.write_text(os.path.join(out_dir, "site", "structure.md"), render_structure(state, pages, out_dir))
    util.write_text(os.path.join(out_dir, "site", "inventory.md"), render_inventory(state, pages, out_dir))
    util.write_text(os.path.join(out_dir, "site", "features.md"), render_features(state, pages, out_dir))
    render_seo(state, pages, out_dir)
    completeness.write(state, out_dir)
    build_gaps(state, pages, out_dir)
    util.write_text(os.path.join(out_dir, "README.md"), render_readme(state, pages, out_dir))
    render_assets(state, out_dir)
    gc_unreferenced(out_dir, state)
    render_coverage(state, out_dir)
    log("render: done")
    return state
