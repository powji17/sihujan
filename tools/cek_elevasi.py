#!/usr/bin/env python3
"""
cek_elevasi.py - Diagnostik hasil prepare_dem.py (hanya membaca, tidak mengubah data).

Jalankan dari root proyek:
    python tools/cek_elevasi.py
"""
import json

import numpy as np
from PIL import Image

PNG = "data/dem/pontianak_dem.png"
META = "data/dem/pontianak_dem.json"
OUT = "data/raw/preview_bertingkat.png"

png = np.array(Image.open(PNG))
meta = json.load(open(META, encoding="utf-8"))
z = ((png[..., 0].astype(int) * 256 + png[..., 1]) / 100.0) - 10.0
ids = png[..., 2]
dalam = ids > 0
zin = z[dalam]
n = zin.size

print(f"Sel dalam kota: {n:,}\n")

# 1. Persentil seluruh sel dalam kota
print("== Persentil elevasi (semua sel dalam kota, m) ==")
for p in (1, 5, 10, 25, 50, 75, 90, 99):
    print(f"  p{p:<2} = {np.percentile(zin, p):6.2f}")

# 2. Perkiraan daratan = buang sel <= 0,5 m (sungai / sel tanpa data)
darat = zin[zin > 0.5]
print(f"\n== Perkiraan daratan (z > 0,5 m): {darat.size:,} sel = {darat.size / n * 100:.1f}% ==")
for p in (1, 5, 10, 25, 50, 75, 90, 99):
    print(f"  p{p:<2} = {np.percentile(darat, p):6.2f}")

# 3. Sebaran per interval 1 m
print("\n== Sebaran per interval ==")
batas = [-99, 0, 1, 2, 3, 4, 5, 6, 8, 10, 99]
for lo, hi in zip(batas[:-1], batas[1:]):
    persen = ((zin > lo) & (zin <= hi)).mean() * 100
    label = f"<= {hi}" if lo == -99 else (f"> {lo}" if hi == 99 else f"{lo} - {hi}")
    print(f"  {label:>8} m : {persen:5.1f}%  {'#' * int(persen / 2)}")

# 4. Per kecamatan (median daratan, p10 daratan, persen sel <= 0,5 m)
print("\n== Per kecamatan ==")
print(f"  {'Kecamatan':<20}{'median':>8}{'p10':>8}{'<=0,5m':>9}")
for k in meta["kecamatan"]:
    zk = z[ids == k["id"]]
    dk = zk[zk > 0.5]
    med = np.median(dk) if dk.size else float("nan")
    p10 = np.percentile(dk, 10) if dk.size else float("nan")
    print(f"  {k['nama']:<20}{med:8.2f}{p10:8.2f}{(zk <= 0.5).mean() * 100:8.1f}%")

# 5. Preview bertingkat
warna = np.array([
    [8, 48, 107],     # <= 0 m     biru tua (sungai / tanpa data)
    [215, 48, 39],    # 0 - 1 m    merah
    [252, 141, 89],   # 1 - 2 m    oranye
    [254, 224, 139],  # 2 - 3 m    kuning
    [217, 239, 139],  # 3 - 5 m    hijau muda
    [102, 189, 99],   # 5 - 8 m    hijau
    [64, 64, 64],     # > 8 m      abu tua
], dtype=np.uint8)
kelas = np.digitize(z, [0.0, 1.0, 2.0, 3.0, 5.0, 8.0], right=True)
img = warna[kelas]
img[~dalam] = 255
Image.fromarray(img).save(OUT)
print(f"\nPreview bertingkat: {OUT}")
print("Legenda: biru tua <=0 | merah 0-1 | oranye 1-2 | kuning 2-3 | "
      "hijau muda 3-5 | hijau 5-8 | abu >8 (meter)")
