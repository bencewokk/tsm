"""Compose the per-seed overview captures (screenshots/grid-<seed>.png) into one labelled 4x2 contact sheet."""
import sys
from PIL import Image, ImageDraw, ImageFont

seeds = [int(a) for a in sys.argv[1:]] or [4821, 83, 57, 187, 304, 421, 369, 252]
labels = {}
try:
    import json
    labels = json.load(open('screenshots/grid-labels.json'))
except Exception:
    pass
W, H = 700, 400
cols = 4
rows = (len(seeds) + cols - 1) // cols
sheet = Image.new('RGB', (cols * W, rows * H), (240, 238, 232))
d = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype('arial.ttf', 16)
except Exception:
    font = ImageFont.load_default()
for i, s in enumerate(seeds):
    im = Image.open(f'screenshots/grid-{s}.png').convert('RGB').resize((W, H), Image.LANCZOS)
    x, y = (i % cols) * W, (i // cols) * H
    sheet.paste(im, (x, y))
    label = labels.get(str(s), f'seed {s}')
    d.rectangle([x, y, x + W, y + 24], fill=(250, 248, 243))
    d.text((x + 6, y + 4), f'{s}: {label}'[:96], fill=(40, 44, 48), font=font)
sheet.save('screenshots/seeds-grid.jpg', quality=88)
print('saved screenshots/seeds-grid.jpg', sheet.size)
