"""Package self-check: references, naming, counts, coverage arithmetic."""

import csv
import os
import re

from . import completeness, util

IMAGE_REF_RE = re.compile(r"!?\[[^\]]*\]\((images/[^)\s]+)\)")
KFILE_REF_RE = re.compile(r"_materials/([A-Za-z0-9._-]+)/([A-Za-z0-9._/\-]+\.(?:md|csv|xml|txt|json))")


def _read(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def _csv_rows(path):
    try:
        with open(path, "r", encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))
    except OSError:
        return []


def run(state, out_dir, log=print):
    blockers = []
    warns = []
    oks = []

    readme_path = os.path.join(out_dir, "README.md")
    readme = _read(readme_path)
    if not readme:
        blockers.append("README.md 不存在或为空")
    else:
        size = len(readme.encode("utf-8"))
        if size > 20000:
            warns.append("README.md 体积 %s，建议压到 20KB 以内" % util.human_bytes(size))
        for needle in ("## 页面清单", "## 硬约束", "## 缺口与待决策"):
            if needle not in readme:
                warns.append("README.md 缺少章节：%s" % needle)

    folder = os.path.basename(os.path.abspath(out_dir))
    if util.material_slug(folder) != state["slug"]:
        blockers.append("目录名 %r 与 slug %r 不一致（上传后 kfile 路径会与 README 不符）"
                        % (folder, state["slug"]))

    md_files = []
    for root, _dirs, names in os.walk(os.path.join(out_dir, "site")):
        for name in names:
            if name.endswith(".md"):
                md_files.append(os.path.join(root, name))
    md_files.append(readme_path)

    missing_images = 0
    remote_images = 0
    for path in md_files:
        text = _read(path)
        for ref in IMAGE_REF_RE.findall(text):
            if not os.path.exists(os.path.join(out_dir, ref)):
                missing_images += 1
        remote_images += text.count("> 图片未取到：")
    if missing_images:
        blockers.append("%d 处页面引用的本地图片不存在" % missing_images)
    elif remote_images:
        warns.append("%d 张图片未取到，已在页面里标注原地址" % remote_images)

    for root, _dirs, names in os.walk(os.path.join(out_dir, "images")):
        for name in names:
            if not re.match(r"^[A-Za-z0-9._-]+$", name):
                blockers.append("图片文件名不合规（会被 Kooboo 改写）：%s" % name)

    routes = _csv_rows(os.path.join(out_dir, "site", "seo", "routes.csv"))
    if not routes:
        blockers.append("site/seo/routes.csv 为空")
    seen = set()
    for row in routes:
        source = (row.get("source_path") or "").strip()
        if source in seen:
            blockers.append("routes.csv 有重复路由：%s" % source)
        seen.add(source)
        page_file = (row.get("page_file") or "").strip()
        if page_file and not os.path.exists(os.path.join(out_dir, page_file)):
            blockers.append("routes.csv 指向不存在的页面文件：%s" % page_file)

    referenced = set()
    for row in routes:
        page_file = (row.get("page_file") or "").strip()
        if page_file:
            referenced.add(os.path.normpath(page_file))
    pages_dir = os.path.join(out_dir, "site", "pages")
    if os.path.isdir(pages_dir):
        for name in os.listdir(pages_dir):
            if not name.endswith(".md"):
                continue
            rel = os.path.normpath(os.path.join("site", "pages", name))
            if rel not in referenced:
                warns.append("页面文件没有被任何路由引用（可能是上次采集的残留）：%s" % name)

    coverage = _csv_rows(os.path.join(out_dir, "site", "coverage.csv"))
    if not coverage:
        blockers.append("site/coverage.csv 为空")
    else:
        actions = {}
        for row in coverage:
            actions[row.get("action") or ""] = actions.get(row.get("action") or "", 0) + 1
        discovered = state.get("counts", {}).get("discovered", 0)
        if sum(actions.values()) != discovered:
            warns.append("coverage 行数 %d 与 state 发现数 %d 不一致" % (sum(actions.values()), discovered))
        if actions.get("keep", 0) == 0:
            blockers.append("没有任何页面被保留（keep=0）")

    pages = [r for r in state["urls"].values() if r["action"] == "keep"]
    empty = [p["path"] for p in pages if p.get("words", 0) < 5]
    if empty:
        warns.append("%d 个页面正文接近空：%s" % (len(empty), "、".join(empty[:5])))
    thin = [p for p in pages if p.get("words", 0) < 80 and not p.get("images")]
    if len(pages) >= 3 and len(thin) >= max(3, int(len(pages) * 0.5)):
        blockers.append("超过一半页面正文少于 80 字（%d/%d），疑似 JS 渲染的空壳。"
                        "加 --browser 用 Chrome 重跑，或请用户提供渲染后的页面。"
                        % (len(thin), len(pages)))

    missing_pages = [p["path"] for p in pages if not p.get("pageFile")
                     or not os.path.exists(os.path.join(out_dir, p["pageFile"]))]
    if missing_pages:
        blockers.append("%d 个页面没有生成页面文件：%s" % (len(missing_pages), "、".join(missing_pages[:5])))

    stats = state.get("assetStats", {})
    if stats.get("images", 0) == 0:
        warns.append("没有取到任何图片")
    if state.get("primaryLang") and any(p.get("lang") and p["lang"] != state["primaryLang"] for p in pages):
        warns.append("存在与入口语言不同的页面，复核入口语言声明")

    # 页面里出现、但清单里完全没有的内部链接：说明发现阶段漏了页面
    known = {util.url_key(record["url"]) for record in state["urls"].values()}
    uncovered = {}
    for record in pages:
        data = util.read_json(os.path.join(out_dir, ".work", "extract", record["id"] + ".json"))
        if not data:
            continue
        for link in data.get("links", []):
            url = link.get("url") or ""
            if util.canonical_host(util.host_of(url)) != util.canonical_host(util.host_of(record["url"])):
                continue
            key = util.url_key(url)
            if key not in known:
                uncovered[url] = uncovered.get(url, 0) + 1
    if uncovered:
        sample = "、".join(list(uncovered)[:5])
        warns.append("%d 个内部链接不在清单里（发现阶段可能漏页）：%s"
                     % (len(uncovered), sample))

    for ref_slug, rel in KFILE_REF_RE.findall(readme):
        if ref_slug != state["slug"]:
            blockers.append("README 引用了错误的资料根：_materials/%s/..." % ref_slug)
        if not os.path.exists(os.path.join(out_dir, rel)):
            blockers.append("README 引用的文件不存在：%s" % rel)

    groups = util.read_json(os.path.join(out_dir, "data", "page-groups.json")) or {}
    for group in groups.get("pageGroups", []):
        if group.get("status") == "unstable":
            continue
        group_id = group["id"]
        index = util.read_json(os.path.join(out_dir, "data", group_id + ".json"))
        if not index:
            blockers.append("候选页面组索引缺失：%s" % group_id)
            continue
        count, ids = 0, set()
        for part in index.get("parts", []):
            payload = util.read_json(os.path.join(out_dir, part["file"])) or {}
            records = payload.get("records", [])
            if len(records) != part.get("count"):
                blockers.append("记录分片缺失或计数不一致：%s" % part["file"])
            for record in records:
                if record.get("sourceId") in ids:
                    blockers.append("候选页面组有重复 sourceId：%s" % group_id)
                ids.add(record.get("sourceId"))
            count += len(records)
        if count != index.get("count") or count != group.get("count"):
            blockers.append("候选页面组总数不一致：%s" % group_id)

    report = completeness.write(state, out_dir)
    lines = ["# 自检报告", "", "文件检查与采集完整性分开计算。采集状态：%s；缺口 %d，待复核 %d。"
             % (report["status"], report["gaps"], report["reviews"]), ""]
    lines.append("- 页面：%d（覆盖 %d 行，排除 %d）" % (
        len(pages), len(coverage), len([r for r in coverage if r.get("action") == "exclude"])))
    lines.append("- 图片：%d 张，文档 %d 个" % (stats.get("images", 0), stats.get("documents", 0)))
    lines.append("- 路由：%d 行" % len(routes))
    lines.append("")
    lines.append("## BLOCKER")
    lines.extend(["- " + item for item in blockers] or ["- 无"])
    lines.append("")
    lines.append("## WARN")
    lines.extend(["- " + item for item in warns] or ["- 无"])
    util.write_text(os.path.join(out_dir, ".work", "verify.md"), "\n".join(lines) + "\n")

    for item in blockers:
        log("BLOCKER " + item)
    for item in warns:
        log("WARN    " + item)
    log("verify: %d blockers, %d warnings" % (len(blockers), len(warns)))
    return blockers, warns
