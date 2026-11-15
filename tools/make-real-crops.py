#!/usr/bin/env python3
"""Cut the real-photo reference crops into test/fixtures/crops/.

Boxes are in original pixels of test/fixtures/photos/tp17-077-set425.jpg (1512x2016).
Each crop is cut as the reader would receive it: the user's box (digit height H plus a
margin on every side) widened to the left by 0.70 * box height (see camera.js
expandBoxForDigits) so a third digit has room.
"""
from PIL import Image
import os
root = os.path.join(os.path.dirname(__file__), '..')
im = Image.open(os.path.join(root, 'test/fixtures/photos/tp17-077-set425.jpg')).convert('RGB')
# digit boxes (x0, y0, x1, y1) measured on the photo
DIGITS = {
    'v077': (856, 816, 1048, 957),
    'v425': (371, 827, 655, 970),
    'v160': (437, 1045, 665, 1192),
    'dashes': (759, 1045, 1045, 1192),
}
MARGINS = {'m05': 0.05, 'm12': 0.12, 'm20': 0.20}
out = os.path.join(root, 'test/fixtures/crops')
os.makedirs(out, exist_ok=True)
for name, (x0, y0, x1, y1) in DIGITS.items():
    H = y1 - y0
    for mname, m in MARGINS.items():
        mm = round(H * m)
        bx0, by0, bx1, by1 = x0 - mm, y0 - mm, x1 + mm, y1 + mm
        ext = round(0.70 * (by1 - by0))
        crop = im.crop((bx0 - ext, by0, bx1, by1))
        crop.save(os.path.join(out, f'{name}-{mname}.png'))
        print(name, mname, crop.size)
