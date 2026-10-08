"""
Builds frontend/src/lib/switchLayouts.json: where each port sits on the front-panel photo of a switch family.

The photos themselves are copyrighted HPE/Aruba images and are NOT kept in the repo: they live in the
server's switch-images folder. This script only reads them to measure the port positions, and writes
numbers. Run it again after replacing a photo:  python tools/build-switch-layouts.py <folder-with-images>

Copper ports sit in a 2-row grid (odd ports on top, even below), so they are detected as dark rectangles
and then re-laid on a regular grid per group of columns (a missed port does not leave a hole). Uplink
ports (SFP) are given by hand, because they differ per model.
"""
import json, sys, os
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'brand-source')
OUT = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'src', 'lib', 'switchLayouts.json')

# key -> image, copper column groups (columns per group, left to right), the x-range that holds the copper
# ports, and the uplink ports as (port, x, y, w, h).
CONFIG = {
  '6300M-48':  dict(file='A6300M.PNG',      groups=[4, 8, 4, 8], cx=(20, 1190), thr=45,
                    up=[(49, 1201, 48, 43, 27), (50, 1199, 96, 44, 27), (51, 1246, 48, 44, 27), (52, 1245, 96, 43, 27)]),
  '5130-48':   dict(file='HPE513048.PNG',   groups=[6, 6, 6, 6], cx=(30, 1365), thr=45,
                    up=[(49, 1373, 100, 52, 32), (50, 1426, 100, 53, 32), (51, 1480, 100, 52, 32), (52, 1533, 100, 52, 32)]),
  '5130-24':   dict(file='HPE513024.PNG',   groups=[6, 6], cx=(10, 440), thr=45,
                    up=[(25, 785, 56, 32, 22), (26, 818, 56, 32, 22), (27, 851, 56, 30, 22), (28, 882, 56, 30, 22)]),
  '2930F-48':  dict(file='A2930F.PNG',      groups=[6, 6, 6, 6], cx=(90, 870), thr=45,
                    up=[(49, 18, 28, 29, 17), (50, 18, 60, 29, 17), (51, 56, 28, 30, 17), (52, 56, 60, 30, 17)]),
  '2930M-48':  dict(file='A2930M.PNG',      groups=[4, 8, 4, 8], cx=(10, 690), thr=45,
                    up=[(49, 703, 26, 26, 17), (50, 703, 55, 26, 15), (51, 731, 26, 26, 17), (52, 731, 55, 26, 15)]),
  '2930M-24':  dict(file='A2930M_24.PNG',   groups=[6, 6], cx=(150, 540), thr=45,
                    grid=dict(groups=[6, 6], x0=[275, 385], pitch=17.8, w=16, top=(15, 13), bot=(33, 13)),
                    up=[(25, 11, 15, 19, 11), (26, 11, 35, 19, 11), (27, 33, 15, 19, 11), (28, 33, 35, 19, 11)]),
  '8360-48Y6C':dict(file='8360-48Y6C.PNG',  groups=[8, 8, 8], cx=(20, 1090), thr=45,
                    up=[(49, 1093, 36, 58, 28), (50, 1093, 85, 58, 26), (51, 1153, 36, 57, 28), (52, 1153, 85, 57, 26), (53, 1211, 36, 57, 28), (54, 1211, 85, 57, 26)]),
}

SIZE = {  # plausible copper-port size range per image: (min w, max w, min h, max h)
  'A6300M.PNG': (18, 44, 18, 40), 'HPE513048.PNG': (14, 50, 14, 40), 'HPE513024.PNG': (10, 40, 10, 36),
  'A2930F.PNG': (14, 40, 14, 36), 'A2930M.PNG': (14, 40, 14, 36), 'A2930M_24.PNG': (8, 30, 6, 20),
  '8360-48Y6C.PNG': (14, 50, 14, 60),
}

def detect(path, thr, cx):
    im = Image.open(path).convert('RGB'); a = np.asarray(im).astype(int); lum = a.mean(axis=2)
    mask = ndi.binary_opening(lum < thr, structure=np.ones((3, 3)))
    lab, n = ndi.label(mask); boxes = []
    for i, sl in enumerate(ndi.find_objects(lab)):
        x0, x1, y0, y1 = sl[1].start, sl[1].stop, sl[0].start, sl[0].stop
        w, h = x1 - x0, y1 - y0
        lo = SIZE[os.path.basename(path)]
        if cx[0] <= x0 and x1 <= cx[1] and lo[0] <= w <= lo[1] and lo[2] <= h <= lo[3] and (lab[sl] == i + 1).sum() / (w * h) > 0.55:
            boxes.append([x0, y0, w, h])
    return im.size, boxes

def manual(key, cfg):
    g = cfg['grid']; (W, H) = Image.open(os.path.join(SRC, cfg['file'])).size; ports, c = {}, 0
    for gi, n in enumerate(g['groups']):
        for k in range(n):
            x = g['x0'][gi] + g['pitch'] * k
            ports[str(2 * c + 1)] = [round(x, 1), g['top'][0], g['w'], g['top'][1]]
            ports[str(2 * c + 2)] = [round(x, 1), g['bot'][0], g['w'], g['bot'][1]]; c += 1
    for p, x, y, ww, hh in cfg['up']: ports[str(p)] = [x, y, ww, hh]
    return dict(image=cfg['file'], w=W, h=H, copper=c * 2, ports=ports, detected=0, expected=c * 2)

def build(key, cfg):
    if 'grid' in cfg: return manual(key, cfg)
    (W, H), boxes = detect(os.path.join(SRC, cfg['file']), cfg['thr'], cfg['cx'])
    # the most common size bucket is the copper port; anything much bigger or smaller is not
    from collections import Counter
    bucket = Counter((round(b[2] / 4), round(b[3] / 4)) for b in boxes).most_common(1)[0][0]
    cop = [b for b in boxes if abs(round(b[2] / 4) - bucket[0]) <= 1 and abs(round(b[3] / 4) - bucket[1]) <= 1]
    ys = sorted(b[1] for b in cop); gapi = int(np.argmax(np.diff(ys))); ymid = (ys[gapi] + ys[gapi + 1]) / 2
    top = [b for b in cop if b[1] < ymid]; bot = [b for b in cop if b[1] >= ymid]
    ty, by = float(np.median([b[1] for b in top])), float(np.median([b[1] for b in bot]))
    w, h = float(np.median([b[2] for b in cop])), float(np.median([b[3] for b in cop]))
    xs = sorted(b[0] for b in cop)
    cols = []   # merge the top and bottom boxes of one column into one x
    for x in xs:
        if not cols or x - cols[-1][-1] > w * 0.5: cols.append([x])
        else: cols[-1].append(x)
    colx = [float(np.mean(c)) for c in cols]
    diffs = np.diff(colx)
    pitch = float(np.min([d for d in diffs if d > w * 0.8]))   # one column step (the smallest real gap)
    # Number each detected column. A missed column leaves a gap of whole steps (2 x pitch), a group boundary
    # leaves a gap of one step plus a margin, so the margin tells the two apart.
    idx, bounds = [0], 0
    for d in diffs:
        steps = max(1, int(np.floor(d / pitch + 0.15)))
        if d - steps * pitch > 0.12 * pitch: bounds += 1
        idx.append(idx[-1] + steps)
    if bounds != len(cfg['groups']) - 1:
        raise SystemExit('%s: found %d group boundaries, expected %d' % (key, bounds, len(cfg['groups']) - 1))
    total = sum(cfg['groups'])
    if idx[-1] + 1 != total:
        raise SystemExit('%s: found %d column positions, expected %d (check the thresholds)' % (key, idx[-1] + 1, total))
    starts = [sum(cfg['groups'][:i]) for i in range(len(cfg['groups']))]
    ports, off = {}, {}
    for gi, n in enumerate(cfg['groups']):
        members = [(i, x) for i, x in zip(idx, colx) if starts[gi] <= i < starts[gi] + n]
        off[gi] = float(np.median([x - pitch * (i - starts[gi]) for i, x in members]))
    c_index = 0
    for gi, n in enumerate(cfg['groups']):
        for k in range(n):
            x = off[gi] + pitch * k
            ports[str(2 * c_index + 1)] = [round(x, 1), round(ty, 1), round(w, 1), round(h, 1)]
            ports[str(2 * c_index + 2)] = [round(x, 1), round(by, 1), round(w, 1), round(h, 1)]
            c_index += 1
    for p, x, y, ww, hh in cfg['up']:
        ports[str(p)] = [x, y, ww, hh]
    return dict(image=cfg['file'], w=W, h=H, copper=c_index * 2, ports=ports,
                detected=len(cop), expected=sum(cfg['groups']) * 2)

out = {}
for k, c in CONFIG.items():
    out[k] = build(k, c)
    print(k, 'detected', out[k]['detected'], 'of', out[k]['expected'], 'ports laid', len(out[k]['ports']))
json.dump(out, open(OUT, 'w'), indent=1)
print('written', OUT)
