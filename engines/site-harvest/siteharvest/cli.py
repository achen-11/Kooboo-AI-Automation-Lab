"""site-harvest CLI."""

import argparse
import os
import re
import shutil
import sys

import lxml.html

from . import assets, dataset, discover, extract, fetch, naming, render, util, verify
from .net import ChromeFetcher, Fetcher


DEFAULT_MAX_PAGES = 300
DEFAULT_MAX_DEPTH = 6
DEFAULT_MAX_ASSETS = 5000
DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024


def log(message):
    print(message, flush=True)


def make_fetcher(args):
    """robots、sitemap、图片永远走普通 HTTP；--browser 只影响页面抓取。"""
    return Fetcher(delay=args.delay)


def resolve_targets(url, out):
    host = util.host_of(url)
    if not host:
        raise SystemExit("URL 不合法：%s" % url)
    slug = util.package_slug(host)
    if out:
        out = os.path.abspath(os.path.expanduser(out))
        slug = util.material_slug(os.path.basename(out.rstrip("/")))
    else:
        out = os.path.join(os.path.expanduser("~"), "kooboo-materials", slug)
    return slug, out


def state_path(out):
    return os.path.join(out, ".work", "state.json")


def load_state(out):
    state = util.read_json(state_path(out))
    if state and state.get("version", 1) < 2:
        state["urls"] = {util.url_key(r["url"]): dict(r, key=util.url_key(r["url"]))
                         for r in state.get("urls", {}).values()}
        state["aliases"] = []
        state["legacyDiscovery"] = True
        state["version"] = 2
    return state


def save_state(state, out):
    state["updatedAt"] = util.now_iso()
    util.write_json(state_path(out), state)


def detect_platform(html, headers):
    text = (html or "")[:200000]
    server = (headers.get("Server") or "")
    generator = ""
    match = re.search(r'<meta[^>]+name=["\']generator["\'][^>]+content=["\']([^"\']+)', text, re.I)
    if match:
        generator = match.group(1)
    hints = []
    if re.search(r"wp-content|wp-json|wp-includes", text):
        hints.append("WordPress")
    if re.search(r"cdn\.shopify\.com|shopify\.theme", text):
        hints.append("Shopify")
    if re.search(r"wix\.com|wixstatic", text):
        hints.append("Wix")
    if re.search(r"squarespace", text):
        hints.append("Squarespace")
    if re.search(r"webflow", text):
        hints.append("Webflow")
    if re.search(r"joomla", text, re.I):
        hints.append("Joomla")
    if re.search(r"drupal", text, re.I):
        hints.append("Drupal")
    if re.search(r"__NEXT_DATA__|/_next/", text):
        hints.append("Next.js")
    if re.search(r"id=\"__nuxt\"|/_nuxt/", text):
        hints.append("Nuxt")
    return {"generator": generator, "server": server, "hints": list(dict.fromkeys(hints))}


def cmd_plan(args):
    url = args.url.strip()
    slug, out = resolve_targets(url, args.out)
    existing = load_state(out)
    if existing and existing.get("source") == url and not args.force:
        state = existing
        if args.max_pages is not None:
            state.setdefault("limits", {})["maxPages"] = args.max_pages
        if args.max_depth is not None:
            state["limits"]["maxDepth"] = args.max_depth
        if args.mode:
            state["mode"] = args.mode
        if args.language:
            state["languageOverride"] = discover.normalize_lang(args.language)
        if args.exclude_prefix:
            state["limits"]["excludePrefixes"] = args.exclude_prefix
        save_state(state, out)
        log("plan: 复用已有采集 %s（%s）" % (out, state.get("startedAt")))
    else:
        if os.path.isdir(out) and os.listdir(out) and not args.force:
            raise SystemExit("目录非空且不是同源采集：%s\n加 --force 会覆盖 state（不会删除已下载文件）" % out)
        util.ensure_dir(os.path.join(out, ".work"))
        if args.force:
            # 完整重采：清掉派生缓存，避免旧 id 对应的 raw/extract 被复用
            for name in ("raw", "extract"):
                shutil.rmtree(os.path.join(out, ".work", name), ignore_errors=True)
            shutil.rmtree(os.path.join(out, "site", "pages"), ignore_errors=True)
        state = {
            "version": 2,
            "source": url,
            "origin": "",
            "slug": slug,
            "mode": args.mode or "B",
            "languageOverride": discover.normalize_lang(args.language),
            "startedAt": util.now_iso(),
            "limits": {
                "maxPages": args.max_pages or DEFAULT_MAX_PAGES,
                "maxDepth": args.max_depth if args.max_depth is not None else DEFAULT_MAX_DEPTH,
                "excludePrefixes": args.exclude_prefix,
                "maxAssets": DEFAULT_MAX_ASSETS,
                "maxTotalBytes": DEFAULT_MAX_BYTES,
            },
            "urls": {},
            "nav": [],
            "footer": [],
            "counts": {},
            "assets": [],
            "files": [],
            "imageMap": {},
            "fileMap": {},
        }
        fetcher = make_fetcher(args)
        home = fetcher.fetch(url)
        if not home.ok:
            raise SystemExit("起始页不可访问：status=%s error=%s" % (home.status, home.error))
        if not home.is_html:
            raise SystemExit("输入必须为 HTML 页面，当前类型：%s" % home.content_type)
        platform = detect_platform(home.text, home.headers)
        try:
            doc = lxml.html.document_fromstring(home.text, base_url=home.final_url)
            title = util.one_line(doc.xpath("string(//title)"), 200) if doc.xpath("//title") else ""
        except Exception:
            title = ""
        from urllib.parse import urlsplit
        parts = urlsplit(home.final_url)
        state["origin"] = "%s://%s" % (parts.scheme, parts.netloc)
        state["siteName"] = title or util.host_of(home.final_url)
        state["finalUrl"] = home.final_url
        state["platform"] = platform
        state["homeStatus"] = home.status
        try:
            probe = lxml.html.document_fromstring(home.text, base_url=home.final_url)
            for node in list(probe.iter("script", "style", "noscript")):
                if node.getparent() is not None:
                    node.getparent().remove(node)
            visible = util.text_len(util.collapse(probe.text_content()))
        except Exception:
            visible = 0
        state["homeVisibleChars"] = visible
        state["shellSuspected"] = bool(visible < 200 and "<script" in home.text.lower())
        save_state(state, out)
        plan_md = [
            "# 采集计划",
            "",
            "- 输入：%s" % url,
            "- 实际落地：%s" % home.final_url,
            "- 模式：%s" % state["mode"],
            "- 标题：%s" % (title or "（无）"),
            "- 平台线索：%s" % ("、".join(platform["hints"]) or platform["generator"] or "未知"),
            "- 服务器：%s" % (platform["server"] or "未知"),
            "- 首页可见文本：%d 字%s" % (visible, "（疑似 JS 渲染，建议加 --browser）" if state["shellSuspected"] else ""),
            "- 目录：%s" % out,
            "- 上限：%d 页 / 深度 %d / %d 张图 / %s" % (state["limits"]["maxPages"], state["limits"]["maxDepth"],
                                                     DEFAULT_MAX_ASSETS, util.human_bytes(DEFAULT_MAX_BYTES)),
            "",
            "下一步：discover（sitemap + 导航 + 正文链接 → URL 清单）",
        ]
        util.write_text(os.path.join(out, ".work", "plan.md"), "\n".join(plan_md) + "\n")
        log("plan: %s" % out)
        log("  标题：%s" % (title or "（无）"))
        log("  平台线索：%s" % ("、".join(platform["hints"]) or "未知"))
        if state["shellSuspected"]:
            log("  [警告] 首页可见文本只有 %d 字，疑似 JS 渲染；加 --browser 用 Chrome 重跑" % visible)
    return state, out


def cmd_discover(args):
    state = load_state(args.out)
    if not state:
        raise SystemExit("找不到采集状态，先运行 plan：%s" % args.out)
    if state.get("urls") and not args.force:
        raise SystemExit("discover 会重建 URL 编号；已有采集请用 all 续跑，或显式 all --force 重采。")
    if state.get("urls"):
        raise SystemExit("已有采集的重新发现请用 all --url <原地址> --force，避免旧缓存对应错误。")
    fetcher = make_fetcher(args)
    discover.discover(state, fetcher, args.out, log=log)
    save_state(state, args.out)
    counts = state["counts"]
    log("discover: 发现 %d，保留 %d，排除 %d，超限 %d（sitemap %d）" % (
        counts["discovered"], counts["keep"], counts["excluded"], counts["overLimit"], counts["sitemap"]))
    return state


def cmd_fetch(args):
    state = load_state(args.out)
    if args.max_pages is not None:
        state["limits"]["maxPages"] = args.max_pages
    if args.max_depth is not None:
        state["limits"]["maxDepth"] = args.max_depth
    for url in getattr(args, "seed_url", []):
        url = util.resolve_url(state["source"], url)
        if not url or not discover.allowed_host(url, state.get("siteHosts") or []):
            raise SystemExit("--seed-url 必须是本次采集主机范围内的公开 URL")
        discover.add_url(state, url, "manual-seed", 0, False)
    fetcher = ChromeFetcher(delay=args.delay) if args.browser else Fetcher(delay=args.delay)
    fetch.run(state, fetcher, args.out, log=log, force=args.force, max_depth=args.max_depth,
              retry_failed=getattr(args, "retry_failed", False),
              checkpoint=lambda current: save_state(current, args.out))
    save_state(state, args.out)
    log("fetch: done")
    return state


def cmd_extract(args):
    state = load_state(args.out)
    naming.assign_page_files(state)
    extract.run(state, args.out, log=log)
    save_state(state, args.out)
    log("extract: done")
    return state


def cmd_assets(args):
    state = load_state(args.out)
    naming.assign_page_files(state)
    assets.run(state, make_fetcher(args), args.out, log=log)
    save_state(state, args.out)
    log("assets: done")
    return state


def cmd_render(args):
    state = load_state(args.out)
    naming.assign_page_files(state)
    render.run(state, args.out, log=log)
    save_state(state, args.out)
    return state


def cmd_data(args):
    state = load_state(args.out)
    naming.assign_page_files(state)
    dataset.run(state, args.out, log=log, min_records=getattr(args, "min_records", None))
    save_state(state, args.out)
    log("data: done")
    return state


def cmd_verify(args):
    state = load_state(args.out)
    blockers, warns = verify.run(state, args.out, log=log)
    save_state(state, args.out)
    return state, blockers


def cmd_all(args):
    state, out = cmd_plan(args)
    args.out = out
    if args.force:
        # --force = 完整重采：重新发现、抓取、抽取，不沿用任何派生缓存
        cmd_discover(args)
        cmd_fetch(args)
        cmd_extract(args)
        cmd_assets(args)
        cmd_data(args)
        cmd_render(args)
    else:
        if not state.get("urls"):
            cmd_discover(args)
        cmd_fetch(args)
        cmd_extract(args)
        cmd_assets(args)
        cmd_data(args)
        state = load_state(out)
        cmd_render(args)
    state = load_state(out)
    blockers, _warns = verify.run(state, out, log=log)
    save_state(state, out)
    return state, out, blockers


def cmd_status(args):
    state = load_state(args.out)
    if not state:
        raise SystemExit("没有采集状态：%s" % args.out)
    counts = state.get("counts", {})
    stats = state.get("assetStats", {})
    log("source : %s" % state.get("source"))
    log("mode   : %s" % state.get("mode"))
    log("dir    : %s" % args.out)
    log("urls   : discovered=%s keep=%s excluded=%s over=%s" % (
        counts.get("discovered", 0), counts.get("keep", 0), counts.get("excluded", 0), counts.get("overLimit", 0)))
    log("assets : images=%s failed=%s documents=%s" % (
        stats.get("images", 0), stats.get("imagesFailed", 0), stats.get("documents", 0)))
    for gap in state.get("gaps") or []:
        log("gap    : " + gap)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog="site-harvest", description="把一个线上站点采集为 Kooboo 资料包")
    sub = parser.add_subparsers(dest="command")

    def common(node, needs_url=False, needs_out=False):
        if needs_url:
            node.add_argument("--url", required=True, help="要采集的站点 URL")
            node.add_argument("--mode", choices=["A", "B"], default=None, help="A 重构 / B 迁移，新采集默认 B")
        node.add_argument("--language", default="", help="显式入口语言，例如 en 或 zh-CN；修正已有采集时 all --force")
        if needs_out:
            node.add_argument("--out", required=True, help="资料包目录（plan 的输出路径）")
        else:
            node.add_argument("--out", help="输出目录，默认 ~/kooboo-materials/<slug>")
        node.add_argument("--delay", type=float, default=0.3, help="请求间隔秒数")
        node.add_argument("--max-pages", type=int, default=None, help="页面上限，新采集默认 300，续跑保留原值")
        node.add_argument("--max-depth", type=int, default=None, help="深度上限，新采集默认 6，续跑保留原值")
        node.add_argument("--retry-failed", action="store_true", help="续跑时重试失败页面")
        node.add_argument("--seed-url", action="append", default=[], help="补充已确认的页面 URL，可重复；不重建编号")
        node.add_argument("--force", action="store_true", help="重跑（保留已下载文件）")
        node.add_argument("--browser", action="store_true",
                          help="用系统 Chrome 抓渲染后的 DOM（JS 站点用）")
        node.add_argument("--exclude-prefix", action="append", default=[],
                          help="排除某个路径前缀，可重复，如 --exclude-prefix /kk/")

    plan = sub.add_parser("plan", help="创建采集目录并识别站点")
    common(plan, needs_url=True)
    for name in ("discover", "fetch", "extract", "assets", "data", "render", "verify", "status"):
        node = sub.add_parser(name, help="单独执行 %s 阶段" % name)
        common(node, needs_out=True)
    all_node = sub.add_parser("all", help="一次跑完 plan→discover→fetch→extract→assets→data→render→verify")
    common(all_node, needs_url=True)
    for node in (sub.choices["data"], all_node):
        node.add_argument(
            "--min-records", type=int, default=dataset.MIN_RECORDS,
            help="一个 URL 模板下至少多少条记录才当候选页面组（默认 %d）" % dataset.MIN_RECORDS)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    if args.max_pages is not None and args.max_pages < 1:
        parser.error("--max-pages 必须大于 0")
    if args.max_depth is not None and args.max_depth < 0:
        parser.error("--max-depth 不得小于 0")
    if args.command == "plan":
        state, out = cmd_plan(args)
        save_state(state, out)
        return 0
    if args.command == "discover":
        cmd_discover(args)
        return 0
    if args.command == "fetch":
        cmd_fetch(args)
        return 0
    if args.command == "extract":
        cmd_extract(args)
        return 0
    if args.command == "assets":
        cmd_assets(args)
        return 0
    if args.command == "data":
        cmd_data(args)
        return 0
    if args.command == "render":
        cmd_render(args)
        return 0
    if args.command == "verify":
        state, blockers = cmd_verify(args)
        return 1 if blockers else (2 if state.get("completeness", {}).get("status") == "incomplete" else 0)
    if args.command == "status":
        return cmd_status(args)
    if args.command == "all":
        state, out, blockers = cmd_all(args)
        log("")
        log("资料包：%s" % out)
        log("README：%s" % os.path.join(out, "README.md"))
        if blockers:
            log("自检有 %d 个 BLOCKER，先处理再上传" % len(blockers))
            return 1
        report = state.get("completeness", {})
        log("文件检查通过；采集状态 %s（缺口 %d，待复核 %d）；交付前需 AI 复核。"
            % (report.get("status", "unknown"), report.get("gaps", 0), report.get("reviews", 0)))
        return 2 if report.get("status") == "incomplete" else 0
    parser.print_help()
    return 2
