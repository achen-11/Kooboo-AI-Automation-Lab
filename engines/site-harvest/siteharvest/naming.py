"""Deterministic page file names. 不改写 URL，只把路径机械地折成文件名。"""

import re

from . import util


def page_slug(path):
    """`/about.html` -> about；`/products/widget/` -> products-widget；无 ASCII -> p-<hash6>。"""
    clean = path.split("?", 1)[0]
    clean = clean.strip("/")
    if clean.lower() in ("", "index.html", "index.htm", "index.php"):
        return "index"
    clean = re.sub(r"\.(html?|php|aspx?|jsp|asp)$", "", clean, flags=re.I)
    slug = util.slugify(clean.replace("/", "-"), 50, fallback="")
    if not slug:
        slug = "p-" + util.sha1_text(path)[:6]
    return slug


def assign_page_files(state):
    pages = sorted(
        [r for r in state["urls"].values() if r["action"] == "keep"],
        key=lambda r: (0 if r["pageType"] == "home" else 1, r["depth"], r["path"]),
    )
    used = {}
    for index, record in enumerate(pages, start=1):
        slug = page_slug(record["path"])
        count = used.get(slug, 0) + 1
        used[slug] = count
        if count > 1:
            slug = "%s-%d" % (slug, count)
        record["pageSlug"] = "%02d-%s" % (index, slug)
        record["pageFile"] = "site/pages/%s.md" % record["pageSlug"]
    return pages
