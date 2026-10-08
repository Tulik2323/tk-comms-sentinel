"""Draws the measured port rectangles over each photo so the calibration can be checked by eye."""
import json, os, sys
from PIL import Image, ImageDraw
SRC = os.path.join(os.path.dirname(__file__), '..', 'brand-source')
L = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'frontend', 'src', 'lib', 'switchLayouts.json')))
OUT = sys.argv[1]
only = sys.argv[2:] 
for key, v in L.items():
    if only and key not in only: continue
    im = Image.open(os.path.join(SRC, v['image'])).convert('RGB'); sc = 2 if im.width < 1000 else 1.4
    big = im.resize((int(im.width*sc), int(im.height*sc)), Image.LANCZOS); d = ImageDraw.Draw(big)
    for p, (x, y, w, h) in v['ports'].items():
        d.rectangle([x*sc, y*sc, (x+w)*sc, (y+h)*sc], outline=(255, 40, 40), width=2)
        d.text((x*sc+2, y*sc+1), p, fill=(255, 255, 0))
    big.save(os.path.join(OUT, 'ov-' + key + '.png')); print(key, big.size)
