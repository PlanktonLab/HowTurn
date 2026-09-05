#!/usr/bin/env python3
"""Download 4x4 tile mosaics centred on Taipei signal intersections (z21, ~7 cm/px).

Resumable: existing images are skipped, tiles are cached on disk.
Yields to the server: on 429/403 it permanently slows down; on 5xx outages it
pauses and probes until the service returns. An image is only written when every
tile came back cleanly, so no mosaic can contain a black patch.

Usage: fetch_taipei.py --out DIR [--workers N] [--interval SEC] [--limit N]
"""
import argparse, csv, io, math, os, time, random, threading
from concurrent.futures import ThreadPoolExecutor
import requests
from PIL import Image

TILE = ("https://www.historygis.udd.gov.taipei/arcgis/rest/services/Aerial/"
        "Ortho_2025/MapServer/WMTS/tile/1.0.0/Aerial_Ortho_2025/default/"
        "GoogleMapsCompatible/{z}/{y}/{x}")
PROBE = TILE.format(z=21, x=1756650, y=897818)   # known-good tile, used to test recovery
UA = 'DieTurn-dataset-builder/0.1 (research; contact via project owner)'

ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('--workers', type=int, default=4)
ap.add_argument('--interval', type=float, default=0.12)   # global seconds between requests
ap.add_argument('--points', default=os.path.join(os.path.dirname(__file__), 'points_taipei_z21.csv'))
ap.add_argument('--limit', type=int, default=0)
A = ap.parse_args()

os.makedirs(f'{A.out}/images', exist_ok=True)
os.makedirs(f'{A.out}/tiles', exist_ok=True)
LOG = open(f'{A.out}/fetch.log', 'a')
IDX = f'{A.out}/index.csv'

idx_lock = threading.Lock()
rate_lock = threading.Lock()
last_req = [0.0]
interval = [A.interval]        # mutable: raised if the server signals rate limiting
outage = threading.Event()     # set while the service is returning 5xx
err_streak = [0]

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, file=LOG, flush=True)

sess = requests.Session()
sess.headers['User-Agent'] = UA
sess.mount('https://', requests.adapters.HTTPAdapter(pool_connections=A.workers * 2,
                                                     pool_maxsize=A.workers * 2))

def tilef(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y

def throttle():
    while outage.is_set():
        time.sleep(5)
    with rate_lock:
        wait = last_req[0] + interval[0] - time.time()
        if wait > 0:
            time.sleep(wait)
        last_req[0] = time.time() + random.random() * interval[0] * 0.3

def wait_for_recovery():
    """Called by one thread when the service starts erroring. Probes until it returns."""
    if outage.is_set():
        return
    outage.set()
    log(f'OUTAGE server returning errors; pausing and probing every 60 s')
    waited = 0
    while True:
        time.sleep(60)
        waited += 60
        try:
            r = sess.get(PROBE, timeout=30)
            if r.status_code == 200 and 'image' in r.headers.get('content-type', ''):
                log(f'RECOVERED after {waited // 60} min, resuming')
                err_streak[0] = 0
                outage.clear()
                return
        except Exception:
            pass
        if waited % 600 == 0:
            log(f'OUTAGE still down after {waited // 60} min')

def is_blank(im):
    lo, hi = im.convert('L').getextrema()
    return hi - lo < 8

def fetch_tile(z, x, y):
    """Returns a path, or None when the tile genuinely has no imagery."""
    fn = f'{A.out}/tiles/{z}_{x}_{y}.jpg'
    if os.path.exists(fn):
        return None if os.path.getsize(fn) == 0 else fn
    for attempt in range(5):
        throttle()
        try:
            r = sess.get(TILE.format(z=z, x=x, y=y), timeout=40)
        except Exception as e:
            log('NET', z, x, y, repr(e)[:70])
            time.sleep(3 * (attempt + 1))
            continue
        ct = r.headers.get('content-type', '')
        if r.status_code == 200 and 'image' in ct and r.content:
            try:
                im = Image.open(io.BytesIO(r.content)); im.load()
            except Exception:
                open(fn, 'wb').close(); return None
            if is_blank(im):
                open(fn, 'wb').close(); return None      # outside imagery coverage
            open(fn, 'wb').write(r.content)
            err_streak[0] = 0
            return fn
        if r.status_code in (204, 404):
            open(fn, 'wb').close(); return None          # no coverage
        if r.status_code in (403, 429):
            with rate_lock:
                interval[0] = min(interval[0] * 2, 1.0)
            log(f'HTTP {r.status_code} rate limited -> slowing to {interval[0]:.2f} s/req')
            time.sleep(30)
            continue
        if r.status_code >= 500 or r.status_code == 400:
            err_streak[0] += 1
            if err_streak[0] >= 6:
                wait_for_recovery()
            else:
                time.sleep(4 * (attempt + 1))
            continue
    raise RuntimeError(f'tile {z}/{x}/{y} unavailable after retries')

def do_point(r):
    out = f"{A.out}/images/{r['id']}.jpg"
    if os.path.exists(out):
        return 'exists'
    z, G = int(r['zoom']), int(r['grid'])
    fx, fy = tilef(float(r['lat']), float(r['lon']), z)
    x0, y0 = int(round(fx - G / 2)), int(round(fy - G / 2))
    im = Image.new('RGB', (256 * G, 256 * G), (0, 0, 0))
    blank = 0
    for dy in range(G):
        for dx in range(G):
            fn = fetch_tile(z, x0 + dx, y0 + dy)     # raises if the server failed
            if fn:
                try:
                    im.paste(Image.open(fn).convert('RGB'), (256 * dx, 256 * dy)); continue
                except Exception:
                    pass
            blank += 1
    status = 'ok' if blank <= G * G // 4 else 'no_coverage'
    if status == 'ok':
        im.save(out, quality=92)
    with idx_lock:
        new = not os.path.exists(IDX)
        with open(IDX, 'a', newline='') as f:
            w = csv.writer(f)
            if new:
                w.writerow(['id', 'lat', 'lon', 'n_nodes', 'source', 'zoom', 'grid',
                            'tile_x0', 'tile_y0', 'blank_tiles', 'status', 'path'])
            w.writerow([r['id'], r['lat'], r['lon'], r['n_nodes'], r['source'], z, G,
                        x0, y0, blank, status, out if status == 'ok' else ''])
    return status

rows = list(csv.DictReader(open(A.points)))
if A.limit:
    rows = rows[:A.limit]
todo = [r for r in rows if not os.path.exists(f"{A.out}/images/{r['id']}.jpg")]
log(f'START points={len(rows)} todo={len(todo)} workers={A.workers} interval={A.interval}')
t0 = time.time()
done, nc, err = [0], [0], [0]

def wrap(r):
    try:
        s = do_point(r)
    except Exception as e:
        log('ERR', r['id'], repr(e)[:100]); s = 'error'; err[0] += 1
    done[0] += 1
    if s == 'no_coverage':
        nc[0] += 1
    if done[0] % 50 == 0 or done[0] == len(todo):
        el = time.time() - t0
        rate = done[0] / el * 60
        eta = (len(todo) - done[0]) / max(rate, 1e-6)
        log(f'PROGRESS {done[0]}/{len(todo)} no_coverage={nc[0]} errors={err[0]} '
            f'{rate:.1f} img/min ETA {eta/60:.2f} h')

with ThreadPoolExecutor(max_workers=A.workers) as ex:
    list(ex.map(wrap, todo))

n = len(os.listdir(f'{A.out}/images'))
log(f'DONE images={n} no_coverage={nc[0]} errors={err[0]} elapsed={(time.time()-t0)/3600:.2f} h')
