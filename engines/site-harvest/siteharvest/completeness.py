"""Evidence-based coverage, independent of package-format validation."""

import os
from collections import Counter

from . import util


def assess(state, out_dir):
    findings = []

    def issue(severity, kind, url, reason):
        findings.append(dict(severity=severity, kind=kind, url=url, reason=reason))

    records = list(state.get("urls", {}).values())
    actions = Counter(r["action"] for r in records)
    pages = [r for r in records if r["action"] == "keep"]
    for record in records:
        action, reason, url = record["action"], record.get("reason", ""), record["url"]
        if action in ("failed", "over-limit", "pending") or reason in ("depth-limit", "external-redirect"):
            issue("gap", "page", url, reason or action)
        if action == "alias":
            target = state["urls"].get(util.url_key(record.get("finalUrl") or ""))
            if not target or target["action"] not in ("keep", "alias"):
                issue("gap", "redirect", url, "redirect target not captured: " + record.get("finalUrl", ""))
        if action != "keep":
            continue
        data = util.read_json(os.path.join(out_dir, ".work", "extract", record["id"] + ".json"))
        if record.get("status") is None or not data:
            issue("gap", "page", url, "not-fetched-or-extracted")
            continue
        if data.get("words", 0) < 5 and not data.get("images") and not data.get("forms"):
            issue("gap", "content", url, "empty-content")
        elif data.get("words", 0) < 80:
            issue("review", "content", url, "thin-content: check image-only page / JS shell")
        if data.get("interactionHints"):
            issue("review", "interaction", url, "load-more control; static DOM cannot prove all records captured")
        if data.get("inlineGraphics") or data.get("dataImages"):
            issue("review", "asset", url, "inline SVG/data images preserved in evidence; check if separate material files are needed")
        if record.get("browserRendered"):
            issue("review", "browser", url, "rendered DOM captured; HTTP status/redirect evidence comes from separate HTTP request")
        if record.get("languageConflict"):
            issue("review", "language", url, record["languageConflict"])
        for embed in data.get("embeds", []):
            issue("review", "embed", url, "embedded content: " + (embed.get("src") or embed.get("poster") or "unknown"))
    assets = state.get("assets", []) + state.get("files", [])
    asset_by_url = {util.url_key(a["url"]): a for a in assets}
    for plan in state.get("imagePlan", []) + state.get("documentPlan", []):
        if util.url_key(plan["url"]) not in asset_by_url:
            issue("gap", "asset", plan["url"], "planned-but-unaccounted")
    for asset in assets:
        if asset["status"] in ("failed", "over-limit"):
            issue("gap", "asset", asset["url"], asset.get("note") or asset["status"])
        elif asset.get("localPath") and not os.path.isfile(os.path.join(out_dir, asset["localPath"])):
            issue("gap", "asset", asset["url"], "missing-local-file")
    for css in state.get("stylesheets", []):
        if css["status"] != "read":
            issue("gap", "stylesheet", css["url"], css.get("note") or css["status"])
    sitemap = state.get("sitemap", {})
    for path in state.get("routeConflicts", []):
        issue("review", "route", path, "same path has multiple captured host/scheme variants")
    if sitemap.get("truncated"):
        issue("gap", "discovery", "", "sitemap discovery truncated")
    for error in sitemap.get("errors", []):
        issue("review", "discovery", error.get("url", ""), error.get("error") or "sitemap request failed")
    if not sitemap.get("files"):
        issue("review", "discovery", "", "no sitemap: compare navigation, categories, pagination and declared totals")
    if not state.get("primaryLang"):
        issue("review", "language", state.get("source", ""), "entry language unknown; verify language scope")
    if state.get("legacyDiscovery"):
        issue("review", "discovery", "", "legacy URL merges may have hidden routes; use all --force to rediscover")
    gaps = sum(f["severity"] == "gap" for f in findings)
    reviews = len(findings) - gaps
    return {
        "status": "incomplete" if gaps else ("needs-review" if reviews else "no-known-gaps"),
        "scope": {"source": state.get("source"), "language": state.get("primaryLang"),
                  "hosts": state.get("siteHosts", []), "maxPages": state.get("limits", {}).get("maxPages"),
                  "maxDepth": state.get("limits", {}).get("maxDepth")},
        "discoveredUrls": len(records), "actions": dict(actions),
        "capturedPages": sum(r.get("status") is not None and bool(r.get("pageFile")) for r in pages),
        "plannedAssets": len(state.get("imagePlan", [])) + len(state.get("documentPlan", [])),
        "accountedAssets": len(assets), "gaps": gaps, "reviews": reviews, "findings": findings,
        "boundary": "分母仅为已发现 URL/素材；无已知缺口不证明全网或全站 100% 覆盖。",
    }


def write(state, out_dir):
    report = assess(state, out_dir)
    state["completeness"] = report
    util.write_json(os.path.join(out_dir, "site", "completeness.json"), report)
    util.write_json(os.path.join(out_dir, "site", "discovery.json"), {
        "sitemap": state.get("sitemap", {}), "stylesheets": state.get("stylesheets", []),
        "externalUrls": state.get("externalUrls", {}),
    })
    lines = ["# 采集完整性", "", "- 状态：%s" % report["status"],
             "- 已发现 URL：%d；已保存页面：%d" % (report["discoveredUrls"], report["capturedPages"]),
             "- 素材计划：%d；已归账：%d" % (report["plannedAssets"], report["accountedAssets"]),
             "- 已知缺口：%d；待复核：%d" % (report["gaps"], report["reviews"]), "",
             report["boundary"], "", "## 发现", ""]
    for finding in report["findings"]:
        lines.append("- [%s / %s] %s — %s" % (
            finding["severity"], finding["kind"], finding["url"] or "全站", finding["reason"]))
    if not report["findings"]:
        lines.append("- 无已知缺口；交付前仍需 AI 内容复核。")
    util.write_text(os.path.join(out_dir, "site", "completeness.md"), "\n".join(lines) + "\n")
    return report
