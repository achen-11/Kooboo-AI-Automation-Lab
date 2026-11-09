import json
import os
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "engines", "site-harvest"))

from siteharvest import dataset


class DatasetTests(unittest.TestCase):
    def test_numeric_templates_are_generic(self):
        self.assertEqual(dataset.url_template("/products/42"), "/products/{id}")
        self.assertEqual(dataset.url_template("/archive/2026/42"), "/archive/{id}/{id}")
        self.assertEqual(dataset.url_template("/about"), "/about")
        self.assertEqual(dataset.page_group_id("/products/{id}"), "products")

    def test_ambiguous_show_path_does_not_imply_commerce(self):
        suggestion = dataset._suggest_owner(
            "/show/{id}", {"title": 1.0, "summary": 1.0, "sections": 1.0})
        self.assertNotIn("Commerce", suggestion["owner"])
        self.assertIn("待定", suggestion["owner"])
        mixed = dataset._suggest_owner(
            "/products/{id}", {"title": 1.0, "summary": 1.0, "sections": 1.0},
            "混杂：需要按记录拆分")
        self.assertIn("待定", mixed["owner"])
        self.assertNotIn("Commerce", mixed["owner"])

    def test_mixed_shape_is_not_forced_into_one_semantic_type(self):
        records = []
        for index in range(4):
            length = 700 if index == 0 else 20
            records.append({
                "sections": [{"title": "", "text": ["x" * length]}],
                "images": [],
            })
        self.assertIn("混杂", dataset._shape_note(records))

    def test_build_writes_index_parts_and_csv_without_network(self):
        with tempfile.TemporaryDirectory() as out_dir:
            extract_dir = os.path.join(out_dir, ".work", "extract")
            os.makedirs(extract_dir)
            pages = []
            for page_group in ("products", "news"):
                for number in (1, 2):
                    page_id = "%s-%d" % (page_group, number)
                    path = "/%s/%d" % (page_group, number)
                    pages.append({
                        "id": page_id,
                        "url": "https://example.test" + path,
                        "path": path,
                        "pageFile": "site/pages/%s.md" % page_id,
                    })
                    with open(os.path.join(extract_dir, page_id + ".json"), "w", encoding="utf-8") as handle:
                        json.dump({
                            "title": "%s %d" % (page_group, number),
                            "h1": "%s %d" % (page_group, number),
                            "description": "Recovered summary",
                            "blocks": [{"kind": "p", "text": "Recovered body %s" % page_id}],
                            "images": [],
                            "links": [],
                        }, handle)
            pages.append({
                "id": "about", "url": "https://example.test/about", "path": "/about",
                "pageFile": "site/pages/about.md",
            })
            with open(os.path.join(extract_dir, "about.json"), "w", encoding="utf-8") as handle:
                json.dump({"title": "About", "blocks": [], "images": [], "links": []}, handle)

            state = {
                "source": "https://example.test/", "siteName": "Example", "slug": "example",
                "imageMap": {}, "nav": [], "footer": [],
            }
            written = dataset.build(state, pages, out_dir, log=lambda _message: None, min_records=2)
            self.assertEqual(set(written), {"products", "news"})

            with open(os.path.join(out_dir, "data", "page-groups.json"), encoding="utf-8") as handle:
                manifest = json.load(handle)
            self.assertEqual(len(manifest["pageGroups"]), 2)
            self.assertNotIn("records", manifest["pageGroups"][0])

            for page_group_id in written:
                with open(os.path.join(out_dir, "data", page_group_id + ".json"), encoding="utf-8") as handle:
                    index = json.load(handle)
                self.assertEqual(index["pageGroup"], page_group_id)
                self.assertEqual(index["count"], 2)
                self.assertNotIn("records", index)
                total = 0
                for part in index["parts"]:
                    with open(os.path.join(out_dir, part["file"]), encoding="utf-8") as handle:
                        payload = json.load(handle)
                    self.assertEqual(part["count"], len(payload["records"]))
                    total += len(payload["records"])
                self.assertEqual(total, index["count"])
                self.assertTrue(os.path.exists(os.path.join(out_dir, "data", page_group_id + ".csv")))

    def test_part_writer_preserves_every_record(self):
        records = [{
            "sourceId": str(index),
            "title": "Record %d" % index,
            "sections": [{"title": "", "text": ["x" * 120]}],
        } for index in range(12)]
        with tempfile.TemporaryDirectory() as data_dir:
            with mock.patch.object(dataset, "PART_BYTES", 700):
                parts = dataset._write_parts(data_dir, "entries", records)
            self.assertGreater(len(parts), 1)
            restored = []
            for part in parts:
                with open(os.path.join(data_dir, os.path.basename(part["file"])), encoding="utf-8") as handle:
                    restored.extend(json.load(handle)["records"])
            self.assertEqual(restored, records)


if __name__ == "__main__":
    unittest.main()
