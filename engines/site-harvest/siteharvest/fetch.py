"""BFS crawler: fetch pages, save raw HTML, and keep discovering links as it goes."""

import os
import hashlib
import lxml.html
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

from . import discover, util

WORKERS = 3


def _raw_path(out_dir, record):
    return os.path.join(out_dir, ".work", "raw", record["id"] + ".html")


def _fetch_one(record, fetcher, out_dir, site_hosts=None):
    record = dict(record)
    response = fetcher.fetch(record["url"], referer=record["url"], binary=False)
    response.harvest_record = record
    record["status"] = response.status
    record["finalUrl"] = response.final_url
    record["contentType"] = response.content_type
    record["charset"] = response.charset
    record["redirects"] = response.chain
    record["fetchedAt"] = util.now_iso()
    record["bytes"] = response.bytes
    record["tlsInsecure"] = response.tls_insecure
    record["browserRendered"] = bool(getattr(response, "browser_rendered", False))

    if response.body and not record["browserRendered"]:
        response_dir = os.path.join(out_dir, ".work", "responses")
        util.ensure_dir(response_dir)
        body_path = os.path.join(response_dir, record["id"] + ".body")
        with open(body_path, "wb") as handle:
            handle.write(response.body)
        record["responseBodyFile"] = os.path.relpath(body_path, out_dir)
        metadata = {
            "url": record["url"], "finalUrl": response.final_url, "status": response.status,
            "contentType": response.content_type, "charset": response.charset,
            "redirects": response.chain, "fetchedAt": record["fetchedAt"],
            "bytes": len(response.body), "sha256": hashlib.sha256(response.body).hexdigest(),
            "layer": "decompressed-http-body-before-text-decoding", "wireBytesPreserved": False,
            "headers": {k: v for k, v in response.headers.items()
                        if k.lower() in ("content-type", "content-length", "last-modified", "etag")},
        }
        util.write_json(os.path.join(response_dir, record["id"] + ".json"), metadata)
        record["responseMetadataFile"] = os.path.relpath(os.path.join(response_dir, record["id"] + ".json"), out_dir)

    if not response.ok:
        record["action"] = "failed"
        record["reason"] = response.error or "http-%s" % (response.status or "error")
        record["note"] = util.one_line(response.error, 160)
        return response
    if response.is_html and not response.text.strip():
        record.update(action="failed", reason="empty-response")
        return response

    if not response.is_html:
        record["action"] = "exclude"
        record["reason"] = "non-html"
        record["detectedAsset"] = True
        record["note"] = util.one_line(response.content_type, 80)
        return response
    if site_hosts and not discover.allowed_host(response.final_url, site_hosts):
        record["action"] = "exclude"
        record["reason"] = "external-redirect"
        return response

    util.ensure_dir(os.path.dirname(_raw_path(out_dir, record)))
    util.write_text(_raw_path(out_dir, record), response.text)
    record["rawFile"] = os.path.relpath(_raw_path(out_dir, record), out_dir)

    # 仅实测跳转才登记 alias；状态码保留在 redirects。
    if util.url_key(response.final_url) != record["key"]:
        record["action"] = "alias"
        record["reason"] = "redirect-to"
        record["note"] = response.final_url
    return response


def _enqueue(state, url, parent_depth, max_depth, queue):
    if not discover.allowed_host(url, state.get("siteHosts") or []):
        if util.is_http(url):
            state.setdefault("externalUrls", {}).setdefault(url, "link")
        return
    child_depth = parent_depth + 1
    if child_depth > max_depth:
        record = discover.add_url(state, url, "link", child_depth, False)
        if record and record["action"] == "keep" and record["depth"] > max_depth:
            record.update(action="exclude", reason="depth-limit")
            state["counts"]["keep"] -= 1
        return
    discover.add_url(state, url, "link", child_depth, False, queue)


def prepare(state, out_dir, force=False, retry_failed=False):
    """恢复失败、缓存丢失、提高上限后可抓的页面，不重新编号。"""
    for record in state["urls"].values():
        if any(record["path"].startswith(prefix) for prefix in state["limits"].get("excludePrefixes", [])):
            record.update(action="exclude", reason="user-excluded")
            continue
        if not discover.language_ok(state, record):
            record.update(action="exclude", reason="other-language")
            continue
        eligible = record["action"] in ("keep", "alias", "failed")
        if record["action"] == "exclude" and record.get("reason") == "soft-404":
            eligible = True
        if eligible and (force or (retry_failed and record["action"] == "failed")):
            record.update(action="keep", reason="", status=None)
        elif record["action"] == "keep" and record.get("status") is not None:
            if not os.path.exists(_raw_path(out_dir, record)):
                record["status"] = None
    discover.refresh_counts(state)
    for record in sorted(state["urls"].values(), key=lambda r: (r["depth"], r["id"])):
        if record["action"] != "over-limit" and record.get("reason") != "depth-limit":
            continue
        if record["depth"] <= state["limits"]["maxDepth"] and state["counts"]["keep"] < state["limits"]["maxPages"]:
            record.update(action="keep", reason="", status=None)
            state["counts"]["keep"] += 1
    discover.refresh_counts(state)


def run(state, fetcher, out_dir, log=print, force=False, max_depth=None,
        retry_failed=False, checkpoint=None):
    limits = state["limits"]
    prepare(state, out_dir, force=force, retry_failed=retry_failed)
    max_depth = max_depth if max_depth is not None else limits.get("maxDepth", 6)
    queue = deque()
    for record in state["urls"].values():
        if record["action"] != "keep":
            continue
        if force or record.get("status") is None:
            queue.append(record)

    total_initial = len(queue)
    log("fetch: %d 个待抓取（上限 %d 页，深度 %d）" % (total_initial, limits["maxPages"], max_depth))
    done = 0
    in_flight = {}
    # 从已保存的页面重新展开，恢复“raw 已落盘、队列尚未落盘”的中断。
    for record in list(state["urls"].values()):
        if record["action"] not in ("keep", "alias") or not os.path.exists(_raw_path(out_dir, record)):
            continue
        with open(_raw_path(out_dir, record), encoding="utf-8") as handle:
            for link in discover.extract_links(handle.read(), record.get("finalUrl") or record["url"]):
                _enqueue(state, link["url"], record["depth"], max_depth, queue)
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        while queue or in_flight:
            while queue and len(in_flight) < WORKERS:
                record = queue.popleft()
                if record["action"] != "keep":
                    continue
                in_flight[pool.submit(_fetch_one, record, fetcher, out_dir, state.get("siteHosts"))] = record
            if not in_flight:
                break
            finished, _pending = wait(list(in_flight), return_when=FIRST_COMPLETED)
            for future in finished:
                record = in_flight.pop(future)
                done += 1
                try:
                    response = future.result()
                    record.update(response.harvest_record)
                except Exception as error:  # 单页失败不能中断整站
                    record["action"] = "failed"
                    record["reason"] = "exception"
                    record["note"] = str(error)[:200]
                    continue

                if record["action"] == "alias":
                    target = record.get("finalUrl") or ""
                    if target:
                        add = discover.add_url(state, target, "redirect-target",
                                               record["depth"], False, queue)
                        if add is not None and add["action"] == "keep" and add.get("status") is None:
                            pass

                if record["action"] not in ("keep", "alias"):
                    continue
                if not response.ok or not response.is_html or not response.text:
                    continue
                try:
                    doc = lxml.html.document_fromstring(response.text, base_url=response.final_url)
                except (lxml.etree.ParserError, ValueError):
                    record.update(action="failed", reason="parse-error")
                    continue
                lang, alternates, _prefixes = discover.extract_language(doc)
                if "home" in record["sources"] and not state.get("primaryLang") and lang:
                    state["primaryLang"] = lang
                state.setdefault("langAlternates", {}).update(alternates)
                if lang and state.get("primaryLang") and not discover.same_language(lang, state["primaryLang"]):
                    scoped_lang = (state.get("langAlternates") or {}).get(record["key"])
                    path_lang = discover._lang_of_path(record["path"])
                    evidence = (state.get("languageOverride") or "home" in record["sources"]
                                or (scoped_lang and discover.same_language(scoped_lang, state["primaryLang"]))
                                or (path_lang and discover.same_language(path_lang, state["primaryLang"])))
                    if evidence:
                        record["languageConflict"] = "html lang=%s; selected=%s" % (lang, state["primaryLang"])
                    else:
                        record.update(action="exclude", reason="other-language")
                        continue
                if not discover.language_ok(state, record):
                    record.update(action="exclude", reason="other-language")
                    continue
                links = discover.extract_links(response.text, response.final_url)
                for link in links:
                    if link.get("lang") and link["lang"] != "x-default":
                        state["langAlternates"][util.url_key(link["url"])] = link["lang"]
                    _enqueue(state, link["url"], record["depth"], max_depth, queue)
                    if link["where"] in ("nav", "footer"):
                        entries = state.setdefault(link["where"], [])
                        if not any(l["url"] == link["url"] for l in entries):
                            entries.append(link)
                if done % 10 == 0 or (done <= 20 and done % 5 == 0):
                    log("  %d 页，队列 %d，清单 %d" % (done, len(queue), len(state["urls"])))
            if checkpoint:
                discover.refresh_counts(state)
                checkpoint(state)
    discover.refresh_counts(state)
    return state
