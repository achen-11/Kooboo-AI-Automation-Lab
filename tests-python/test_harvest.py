import copy
import gzip
import io
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "engines", "site-harvest"))
from siteharvest import assets, cli, completeness, discover, extract, fetch, net, render, util, verify


def state_for(source="https://example.test/en/detail"):
    return {
        "version": 2, "source": source, "slug": "package", "mode": "B",
        "siteHosts": ["example.test"], "origin": "https://example.test", "primaryLang": "en",
        "limits": {"maxPages": 100, "maxDepth": 6}, "counts": {"keep": 0}, "seq": 0, "urls": {},
        "nav": [], "footer": [], "assets": [], "files": [], "imageMap": {}, "fileMap": {},
    }


def html(title, body="", head="", lang="en"):
    return ('<!doctype html><html lang="%s"><head><title>%s</title>%s</head><body>'
            '<main><h1>%s</h1><p>%s</p>%s</main><footer>Office telephone +12345678901</footer>'
            '</body></html>') % (lang, title, head, title, ("Source content for " + title + ". ") * 15, body)


class Reply(io.BytesIO):
    def __init__(self, url, data, ctype="text/html", status=200):
        super().__init__(data.encode() if isinstance(data, str) else data)
        self.headers, self.status, self.url = {"Content-Type": ctype}, status, url

    def geturl(self):
        return self.url


class HarvestTests(unittest.TestCase):
    def test_url_identity_preserves_meaningful_variants(self):
        variants = ["/a", "/a/", "/index.html", "/", "/a?x=1&y=2", "/a?y=2&x=1"]
        self.assertEqual(len({util.url_key("https://example.test" + p) for p in variants}), len(variants))
        url = "https://example.test/a?item=a%20b&item=a+b&utm_source=test"
        self.assertEqual(util.strip_tracking(url), "https://example.test/a?item=a%20b&item=a+b")

    def test_sitemap_namespace_cdata_and_image_urls(self):
        text = ('<s:urlset xmlns:s="urn:sm" xmlns:i="urn:image"><s:url>'
                '<s:loc><![CDATA[https://example.test/a?x=1&y=2]]></s:loc>'
                '<i:image><i:loc>https://cdn.test/photo.jpg</i:loc></i:image>'
                '</s:url></s:urlset>')
        kind, urls = discover.parse_sitemap(text)
        self.assertEqual(kind, "urlset")
        self.assertEqual(urls, ["https://example.test/a?x=1&y=2"])

    def test_sitemap_index_can_link_extensionless_children(self):
        class F:
            def fetch(self, url, **kwargs):
                response = net.Response(url)
                response.status = 200
                response.text = ('<sitemapindex><sitemap><loc>/map/data</loc></sitemap></sitemapindex>'
                                 if url.endswith("/sitemap.xml") else
                                 '<urlset><url><loc>https://example.test/item</loc></url></urlset>'
                                 if url.endswith("/map/data") else "")
                return response
        urls, _meta = discover.collect_sitemap_urls(F(), "https://example.test", {}, budget_seconds=1)
        self.assertIn("https://example.test/item", urls)

    def test_sitemap_depth_zero_does_not_bypass_language_scope(self):
        state = state_for()
        r = discover.add_url(state, "https://example.test/fr/about", "sitemap", 0, True)
        self.assertEqual((r["action"], r["reason"]), ("exclude", "other-language"))
        state["primaryLang"] = "zh-cn"
        r = discover.add_url(state, "https://example.test/zh-tw/about", "sitemap", 0, True)
        self.assertEqual(r["reason"], "other-language")
        self.assertTrue(discover.same_language("en", "en-US"))
        self.assertFalse(discover.same_language("en-GB", "en-US"))

    def test_base_pagination_area_and_frames_are_discovered(self):
        links = discover.extract_links(
            '<base href="/en/"><link rel="next" href="?page=2"><area href="map" alt="Map">'
            '<iframe src="frame"></iframe>', "https://example.test/en/detail")
        self.assertEqual({l["url"] for l in links},
                         {"https://example.test/en/?page=2", "https://example.test/en/map", "https://example.test/en/frame"})

    def test_index_route_is_not_an_invented_redirect(self):
        state = state_for()
        for url in ("https://example.test/", "https://example.test/index.html"):
            discover.add_url(state, url, "link", 0, False)
        self.assertEqual(len(state["urls"]), 2)
        self.assertFalse(state.get("aliases"))

    def test_byte_limits_fail_instead_of_silently_truncating(self):
        with self.assertRaisesRegex(ValueError, "too-large"):
            net._read_body(Reply("x", b"x" * 20), 10)
        response = Reply("x", gzip.compress(b"x" * 100))
        response.headers["Content-Encoding"] = "gzip"
        with self.assertRaisesRegex(ValueError, "too-large"):
            net._read_body(response, 50)

    def test_full_text_and_jsonld_survive_body_selection(self):
        data = extract.extract_page(html("Product", '<script type="application/ld+json">{"@type":"Product","sku":"42"}</script>'),
                                    "https://example.test/product")
        self.assertIn("Office telephone", data["fullText"])
        self.assertEqual(data["jsonldRaw"][0]["data"]["sku"], "42")

    def test_removed_nodes_preserve_following_body_text(self):
        body = '<p>Start<script>ignore_me()</script>TAIL_ADDRESS_SENTINEL</p><map>MAP_TEXT_SENTINEL</map>AFTER_MAP_SENTINEL'
        data = extract.extract_page(html("Legacy", body), "https://example.test/en/legacy")
        for marker in ("TAIL_ADDRESS_SENTINEL", "MAP_TEXT_SENTINEL", "AFTER_MAP_SENTINEL"):
            self.assertIn(marker, data["fullText"])
            self.assertIn(marker, json.dumps(data["blocks"]))

    def test_audio_video_sources_and_footer_forms_survive(self):
        content = html("Media", '<video controls><source src="/movie.webm"><source src="/movie.mp4"></video>'
                       '<audio><source src="/voice.mp3"></audio>')
        content = content.replace("</footer>", '<form action="/signup"><input name="email"></form></footer>')
        data = extract.extract_page(content, "https://example.test/en/media")
        sources = {s["url"] for embed in data["embeds"] for s in embed["sources"]}
        self.assertEqual(sources, {"https://example.test/movie.webm", "https://example.test/movie.mp4", "https://example.test/voice.mp3"})
        self.assertTrue(any(f["fields"][0]["name"] == "email" for f in data["forms"]))

    def test_all_jsonld_and_contact_hrefs_survive(self):
        content = html("Contacts", '<a href="mailto:info@example.test">Email</a>' +
                       "".join('<script type="application/ld+json">{"@type":"Thing","id":%d}</script>' % i for i in range(12)))
        data = extract.extract_page(content, "https://example.test/contact")
        self.assertEqual(len(data["jsonldRaw"]), 12)
        self.assertEqual(data["contactLinks"][0]["url"], "mailto:info@example.test")
        state = state_for()
        record = discover.add_url(state, "https://example.test/contact", "link", 1, False)
        record["pageFile"] = "site/pages/contact.md"
        page = render.render_page(state, record, data)
        self.assertIn("mailto:info@example.test", page)

    def test_additional_image_roles_and_invalid_bytes(self):
        content = html("Images", '<picture><source media="(max-width:600px)" srcset="/mobile.png 1x, /mobile-2x.png 2x"><img src="/desktop.png"></picture><video poster="/poster.png"></video>',
                       '<meta property="og:image" content="/social.png"><link rel="icon" href="/favicon.ico">')
        data = extract.extract_page(content, "https://example.test/images")
        paths = {util.path_of(i["url"]) for i in data["images"]}
        self.assertTrue({"/desktop.png", "/mobile.png", "/mobile-2x.png", "/social.png", "/favicon.ico", "/poster.png"} <= paths)
        self.assertEqual(assets._image_ext(b"this is an error"), "")

    def test_package_slug_matches_scanner(self):
        self.assertEqual(util.material_slug("My_Package.v2"), "my-package-v2")

    def test_incomplete_report_has_url_specific_reasons(self):
        state = state_for()
        r = discover.add_url(state, "https://example.test/missing", "nav", 1, False)
        r.update(action="failed", reason="http-500")
        state["sitemap"] = {"files": [{"url": "sitemap"}]}
        with tempfile.TemporaryDirectory() as out:
            report = completeness.write(state, out)
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["findings"][0]["url"], r["url"])

    def test_language_exclusion_is_not_a_content_gap(self):
        state = state_for()
        discover.add_url(state, "https://example.test/fr/about", "sitemap", 0, True)
        state["sitemap"] = {"files": [{"url": "sitemap"}]}
        with tempfile.TemporaryDirectory() as out:
            report = completeness.assess(state, out)
        self.assertEqual(report["gaps"], 0)

    def test_force_fetch_retries_failed_pages(self):
        state = state_for()
        r = discover.add_url(state, "https://example.test/missing", "nav", 1, False)
        r.update(action="failed", reason="http-500", status=500)
        with tempfile.TemporaryDirectory() as out:
            fetch.prepare(state, out, force=True)
        self.assertEqual((r["action"], r["status"]), ("keep", None))

    def test_depth_limit_does_not_misclassify_documents_or_languages(self):
        state = state_for()
        queue = []
        fetch._enqueue(state, "https://example.test/brochure.pdf", 8, 6, queue)
        fetch._enqueue(state, "https://example.test/fr/about", 8, 6, queue)
        self.assertEqual({r["reason"] for r in state["urls"].values()}, {"asset", "other-language"})

    def test_html_with_image_extension_is_rejected(self):
        self.assertEqual(assets._ext_from_mime("text/html", "/photo.jpg"), "")


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.urls = {
            "/en/detail": html("Entry", '<a href="/en/products">Products</a>'),
            "/en/": html("Home", '<nav><a href="/en/contact">Contact</a></nav><a href="/en/products">Products</a>'),
            "/en/products": html("Products", '<a href="/en/products/1">One</a>',
                                 '<link rel="next" href="/en/products?page=2"><link rel="stylesheet" href="/css/main.css">'),
            "/en/products?page=2": html("Products page 2", '<a href="/en/products/2">Two</a>'),
            "/en/products/1": html("Product One", '<img src="/photo.svg"><a href="/download">Guide</a>'),
            "/en/products/2": html("Product Two", '<button>Load more</button>'),
            "/en/contact": html("Contact"),
            "/fr/about": html("French", lang="fr"),
            "/robots.txt": ("User-agent: *\nSitemap: https://example.test/sitemap.xml", "text/plain"),
            "/sitemap.xml": ('<urlset><url><loc>https://example.test/fr/about</loc></url></urlset>', "application/xml"),
            "/css/main.css": ('@import "extra"; .hero {background:url("../hero.svg")} ', "text/css"),
            "/css/extra": ('.logo {background:url("/logo.svg")}', "text/css"),
            "/hero.svg": ('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"/>', "image/svg+xml"),
            "/logo.svg": ('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="50"/>', "image/svg+xml"),
            "/photo.svg": ('<svg xmlns="http://www.w3.org/2000/svg" width="70" height="50"/>', "image/svg+xml"),
            "/download": (b"%PDF-1.4 fake fixture only", "application/pdf"),
        }
        self.requests = []

    def transport(self, _fetcher, url, referer, insecure, timeout=None):
        self.requests.append(url)
        path = util.route_of(url)
        value = self.urls.get(path)
        recorder = type("Redirects", (), {"chain": []})()
        if value is None:
            return Reply(url, b"", status=404), recorder, ""
        data, ctype = value if isinstance(value, tuple) else (value, "text/html; charset=utf-8")
        return Reply(url, data, ctype), recorder, ""

    def run_cli(self, out, *extra):
        with patch.object(net.Fetcher, "_request", autospec=True, side_effect=self.transport):
            with patch("builtins.print"):
                code = cli.main(["all", "--url", "https://example.test/en/detail", "--out", out, "--delay", "0", *extra])
        return code, cli.load_state(out)

    def test_single_subpage_url_recovers_language_root_and_pagination(self):
        with tempfile.TemporaryDirectory() as temp:
            out = os.path.join(temp, "package")
            code, state = self.run_cli(out)
            self.assertEqual(code, 0)
            by_path = {r["path"]: r for r in state["urls"].values()}
            for path in ("/en/", "/en/contact", "/en/products?page=2", "/en/products/2"):
                self.assertEqual(by_path[path]["action"], "keep")
            self.assertEqual(by_path["/fr/about"]["reason"], "other-language")
            self.assertNotIn("https://example.test/fr/about", self.requests)
            self.assertEqual(len(state["assets"]), 3)
            self.assertEqual(len(state["files"]), 1)
            self.assertEqual(state["completeness"]["status"], "needs-review")
            self.assertTrue(any(f["kind"] == "interaction" for f in state["completeness"]["findings"]))
            self.assertIn("Office telephone", util.read_json(
                os.path.join(out, "site/evidence", by_path["/en/detail"]["id"] + ".json"))["fullText"])

    def test_raise_limit_resumes_and_keeps_cached_documents(self):
        with tempfile.TemporaryDirectory() as temp:
            out = os.path.join(temp, "package")
            code, first = self.run_cli(out, "--max-pages", "3")
            self.assertEqual(code, 2)
            ids = {r["url"]: r["id"] for r in first["urls"].values()}
            code, second = self.run_cli(out, "--max-pages", "30")
            self.assertEqual(code, 0)
            self.assertEqual(second["counts"]["overLimit"], 0)
            self.assertTrue(all(second["urls"][util.url_key(url)]["id"] == i for url, i in ids.items()))
            files_before = copy.deepcopy(second["files"])
            requests_before = len(self.requests)
            code, third = self.run_cli(out)
            self.assertEqual(third["limits"]["maxPages"], 30)
            self.assertEqual(third["files"][0]["status"], "cached")
            self.assertTrue(os.path.exists(os.path.join(out, files_before[0]["localPath"])))
            new_requests = self.requests[requests_before:]
            self.assertNotIn("https://example.test/download", new_requests)
            self.assertNotIn("https://example.test/photo.svg", new_requests)

    def test_retry_failures_and_refresh_derived_materials(self):
        self.urls["/en/contact"] = None
        with tempfile.TemporaryDirectory() as temp:
            out = os.path.join(temp, "package")
            code, first = self.run_cli(out)
            self.assertEqual(code, 2)
            self.urls["/en/contact"] = html("Contact Restored", '<img src="/photo.svg">')
            code, second = self.run_cli(out, "--retry-failed")
            self.assertEqual(code, 0)
            page = second["urls"][util.url_key("https://example.test/en/contact")]
            self.assertEqual(page["action"], "keep")
            with open(os.path.join(out, page["pageFile"]), encoding="utf-8") as f:
                self.assertIn("Contact Restored", f.read())

    def test_asset_count_and_byte_limits_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            out = os.path.join(temp, "package")
            _code, state = self.run_cli(out)
            with patch.object(net.Fetcher, "_request", autospec=True, side_effect=self.transport):
                assets.run(state, net.Fetcher(delay=0, retries=0), out, log=lambda _: None, max_assets=1)
            self.assertGreater(state["assetStats"]["overLimit"], 0)
            self.assertEqual(completeness.assess(state, out)["status"], "incomplete")
            with patch.object(net.Fetcher, "_request", autospec=True, side_effect=self.transport):
                assets.run(state, net.Fetcher(delay=0, retries=0), out, log=lambda _: None, max_total_bytes=5)
            self.assertEqual(state["assetStats"]["images"], 0)
            self.assertTrue(all(not a["localPath"] for a in state["assets"]))

    def test_seed_url_and_failed_empty_response(self):
        self.urls["/en/hidden"] = html("Hidden")
        self.urls["/en/contact"] = " "
        with tempfile.TemporaryDirectory() as temp:
            out = os.path.join(temp, "package")
            code, state = self.run_cli(out, "--seed-url", "https://example.test/en/hidden")
            self.assertEqual(code, 2)
            self.assertEqual(state["urls"][util.url_key("https://example.test/en/hidden")]["action"], "keep")
            self.assertEqual(state["urls"][util.url_key("https://example.test/en/contact")]["reason"], "empty-response")

    def test_language_override_retains_misdeclared_entry_language_pages(self):
        with tempfile.TemporaryDirectory() as temp:
            out = os.path.join(temp, "package")
            code, state = self.run_cli(out, "--language", "zh-CN")
            # URL /en/ is an explicit different-language scope; use neutral Chinese entry pages instead.
            self.urls = {
                "/detail": html("入口", '<a href="/contact">联系</a>', lang="en"),
                "/contact": html("联系", '<a href="/policy">政策</a>', lang="en"),
                "/policy": html("政策", lang="en"), "/": html("首页", lang="en"),
                "/robots.txt": self.urls["/robots.txt"], "/sitemap.xml": self.urls["/sitemap.xml"],
            }
            with patch.object(net.Fetcher, "_request", autospec=True, side_effect=self.transport), patch("builtins.print"):
                code = cli.main(["all", "--url", "https://example.test/detail", "--out", out,
                                 "--language", "zh-CN", "--force", "--delay", "0"])
            state = cli.load_state(out)
            self.assertEqual(code, 0)
            self.assertEqual(state["urls"][util.url_key("https://example.test/contact")]["action"], "keep")
            self.assertEqual(state["urls"][util.url_key("https://example.test/policy")]["action"], "keep")
            self.assertTrue(any(f["kind"] == "language" for f in state["completeness"]["findings"]))

    def test_existing_discover_is_rejected_and_does_not_reassign_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            out = os.path.join(temp, "package")
            _code, state = self.run_cli(out)
            before = copy.deepcopy(state["urls"])
            with self.assertRaises(SystemExit):
                cli.main(["discover", "--out", out])
            self.assertEqual(cli.load_state(out)["urls"], before)

    def test_real_302_is_preserved(self):
        self.urls["/en/detail"] = html("Entry", '<a href="/old">Old link</a>')
        ordinary = self.transport

        def redirected(fetcher, url, referer, insecure, timeout=None):
            if util.path_of(url) == "/old":
                final = "https://example.test/en/contact"
                recorder = type("Redirects", (), {"chain": [{"from": url, "status": 302, "to": final}]})()
                return Reply(final, self.urls["/en/contact"]), recorder, ""
            return ordinary(fetcher, url, referer, insecure, timeout)

        self.transport = redirected
        with tempfile.TemporaryDirectory() as temp:
            out = os.path.join(temp, "package")
            code, state = self.run_cli(out)
            self.assertEqual(code, 0)
            row = next(r for r in verify._csv_rows(os.path.join(out, "site/seo/routes.csv")) if r["source_path"] == "/old")
            self.assertEqual(row["action"], "302")

    def test_missing_data_part_is_a_file_blocker(self):
        with tempfile.TemporaryDirectory() as temp:
            out = os.path.join(temp, "package")
            _code, state = self.run_cli(out)
            util.write_json(os.path.join(out, "data/page-groups.json"), {
                "pageGroups": [{"id": "products", "status": "ready", "count": 2}]})
            util.write_json(os.path.join(out, "data/products.json"), {
                "count": 2, "parts": [{"file": "data/missing.part-01.json", "count": 2}]})
            blockers, _warnings = verify.run(state, out, log=lambda _: None)
            self.assertTrue(any("分片" in b for b in blockers))


if __name__ == "__main__":
    unittest.main()
