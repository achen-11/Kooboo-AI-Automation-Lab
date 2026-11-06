#!/usr/bin/env python3
"""Optional local review aid. Requires Pillow; originals remain unchanged."""
import argparse
import json
import hashlib
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

p = argparse.ArgumentParser()
p.add_argument('run_directory', type=Path)
args = p.parse_args()
root = args.run_directory.resolve()
m = json.loads((root / 'manifest.json').read_text())
out = root / 'review'
out.mkdir(exist_ok=True)
font = ImageFont.load_default(size=16)
derived = []
for key, capture in m['captures'].items():
    tiles = [a for a in capture.get('artifacts', []) if a['kind'].startswith('tile-')]
    if not tiles:
        continue
    width = 480 if capture['viewport']['id'] == 'desktop' else 320
    tile_height = round(capture['viewport']['height'] * width / capture['viewport']['width'])
    columns = 3
    # Small sheets keep image inspection bounded and preserve readable previews.
    for start in range(0, len(tiles), 9):
        group = tiles[start:start + 9]
        rows = (len(group) + columns - 1) // columns
        sheet = Image.new('RGB', (columns * (width + 12), rows * (tile_height + 50)), '#e7e7e7')
        draw = ImageDraw.Draw(sheet)
        for i, artifact in enumerate(group):
            image = Image.open(root / artifact['file']).convert('RGB')
            image.thumbnail((width, tile_height))
            x = (i % columns) * (width + 12)
            y = (i // columns) * (tile_height + 50)
            draw.text((x + 4, y + 2), f"{key} {artifact['kind']} y={artifact['pageY']}", font=font, fill='black')
            sheet.paste(image, (x, y + 32))
        path = out / f'{key}-sheet-{start // 9 + 1}.jpg'
        sheet.save(path, quality=91)
        print(path)
    full = next((a for a in capture['artifacts'] if a['kind'] == 'full'), None)
    if full:
        image = Image.open(root / full['file']).convert('RGB')
        image.thumbnail((650, 2600))
        path = out / f'{key}-full-diagnostic-overview.jpg'
        image.save(path, quality=92)
        print(path)
    if capture.get('coverage', {}).get('complete'):
        width = capture['viewport']['width']
        height = capture['coverage']['capturedHeight']
        stitched = Image.new('RGB', (width, height), 'white')
        covered = 0
        for artifact in sorted(tiles, key=lambda a: a['pageY']):
            data = (root / artifact['file']).read_bytes()
            if hashlib.sha256(data).hexdigest() != artifact['sha256']:
                raise ValueError(f"Evidence modified: {artifact['id']}")
            image = Image.open(root / artifact['file']).convert('RGB')
            y = artifact['pageY']
            if y > covered or y < 0 or image.width != width:
                raise ValueError(f'Cannot stitch inconsistent geometry: {key}')
            stitched.paste(image.crop((0, 0, width, min(image.height, height-y))), (0, y))
            covered = max(covered, y + image.height)
        if covered < height:
            raise ValueError(f'Incomplete stitch: {key}')
        path = out / f'{key}-stitched.png'
        stitched.save(path)
        derived.append({'id': f'{key}-stitched', 'file': str(path.relative_to(root)),
            'kind': 'derived-multiframe-composite', 'width': width, 'height': height,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'sources': [a['id'] for a in tiles],
            'note': 'Actual viewport pixels placed at recorded pageY. Multiple capture times; sticky elements or animation states may repeat. Not a single browser screenshot.'})
        print(path)
        stitched.thumbnail((650, 2600))
        overview = out / f'{key}-stitched-overview.jpg'
        stitched.save(overview, quality=92)
        print(overview)
(out / 'derived-manifest.json').write_text(json.dumps({'schemaVersion': 1, 'artifacts': derived}, indent=2) + '\n')
