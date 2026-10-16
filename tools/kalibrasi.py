#!/usr/bin/env python3
"""
kalibrasi.py - Uji skenario PRD (bagian 9.2) langsung dari data DEM, tanpa UI.

Memakai model yang sama dengan PRD bagian 5:
    Q_eff = Q_drain[drainase] * max(0, 1 - T / T_ref)
    R_net = max(0, C[drainase] * I - Q_eff)
    H     = T + k * (R_net * D) / 1000
    sel tergenang bila (z - offset) <= H ; jika H <= 0 tidak ada genangan

Jalankan dari root proyek:
    python tools/kalibrasi.py                      # cari offset + k terbaik
    python tools/kalibrasi.py --offset 1.2 --k 7   # lihat satu kombinasi saja
"""
import argparse

import numpy as np
from PIL import Image

PNG = "data/dem/pontianak_dem.png"
C = {"baik": 0.50, "sedang": 0.70, "buruk": 0.90}
Q_DRAIN = {"baik": 10.0, "sedang": 5.0, "buruk": 1.0}
T_REF = 1.5
H_MAKS = 3.0
AMBANG = [(5, "Aman"), (20, "Waspada"), (40, "Siaga")]  # sisanya Banjir

# (no, I mm/jam, D jam, T m, drainase, batas bawah %, batas atas %, harapan)
SKENARIO = [
    (1, 3, 3, 0.1, "baik", 0, 5, "Aman"),
    (2, 7, 4, 0.2, "sedang", 0, 20, "Aman atau Waspada"),
    (3, 15, 6, 0.4, "sedang", 5, 40, "Waspada atau Siaga"),
    (4, 30, 8, 0.6, "buruk", 20, 100.01, "Siaga atau Banjir"),
    (5, 0, 6, 0.0, "baik", 0, 5, "Aman, tanpa genangan"),
    (6, 15, 6, 1.0, "buruk", None, None, "status >= skenario 3"),
]


def status(persen):
    for batas, nama in AMBANG:
        if persen < batas:
            return nama
    return "Banjir"


def muka_air(I, D, T, drain, k):
    q_eff = Q_DRAIN[drain] * max(0.0, 1.0 - T / T_REF)
    r_net = max(0.0, C[drain] * I - q_eff)
    return min(H_MAKS, T + k * (r_net * D) / 1000.0)


def persen_tergenang(zs, n, H):
    if H <= 0:
        return 0.0
    return np.searchsorted(zs, H, side="right") / n * 100.0


def evaluasi(z_darat, offset, k):
    """Kembalikan ([(no, H, persen, status, margin)], skor = margin terkecil)."""
    zs = np.sort(z_darat - offset)
    n = zs.size
    hasil = []
    f3 = None
    for no, I, D, T, drain, lo, hi, _ in SKENARIO:
        H = muka_air(I, D, T, drain, k)
        f = persen_tergenang(zs, n, H)
        if no == 3:
            f3 = f
        if no == 6:
            margin = f - f3
        elif no == 5:
            margin = 5 - f if H <= 0 else -1
        else:
            kandidat = [hi - f]
            if lo > 0:
                kandidat.append(f - lo)
            margin = min(kandidat)
        hasil.append((no, H, f, status(f), margin))
    return hasil, min(h[4] for h in hasil)


def cetak_tabel(hasil):
    print(f"  {'#':<3}{'H (m)':>8}{'tergenang':>12}  {'status':<9}{'margin':>8}  harapan")
    for (no, H, f, st, m), s in zip(hasil, SKENARIO):
        tanda = "OK" if m >= 0 else "GAGAL"
        print(f"  {no:<3}{H:8.2f}{f:11.1f}%  {st:<9}{m:8.1f}  {s[7]}  [{tanda}]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", default=PNG)
    ap.add_argument("--offset", type=float, default=None)
    ap.add_argument("--k", type=float, default=4.0)
    ap.add_argument("--top", type=int, default=10)
    a = ap.parse_args()

    png = np.array(Image.open(a.png))
    z = ((png[..., 0].astype(int) * 256 + png[..., 1]) / 100.0) - 10.0
    z_darat = z[png[..., 2] > 0].astype("float64")
    print(f"Sel darat: {z_darat.size:,} | persentil z: "
          + " | ".join(f"p{p} {np.percentile(z_darat, p):.2f}" for p in (1, 5, 10, 25, 50, 75, 90)))

    if a.offset is not None:
        hasil, skor = evaluasi(z_darat, a.offset, a.k)
        print(f"\nOffset {a.offset:.2f} m, k = {a.k:g}  ->  skor (margin terkecil) {skor:.1f} poin%")
        cetak_tabel(hasil)
        return

    kandidat = []
    for off in np.arange(0.0, 3.01, 0.1):
        for k in np.arange(2.0, 12.01, 0.5):
            hasil, skor = evaluasi(z_darat, float(off), float(k))
            if skor >= 0:
                kandidat.append((skor, float(off), float(k), hasil))
    # margin >= 2 poin% sudah cukup aman; di antara yang cukup aman, pilih k terkecil (paling dekat PRD)
    kandidat.sort(key=lambda x: (-min(x[0], 2.0), x[2], x[1]))
    print(f"\nKombinasi yang meloloskan semua skenario: {len(kandidat)}")
    if not kandidat:
        print("Tidak ada. Kirim output ini, kita periksa asumsi lain (C, Q_drain, ambang).")
        return
    for skor, off, k, hasil in kandidat[:a.top]:
        f = [h[2] for h in hasil]
        print(f"  offset {off:.1f} | k {k:4.1f} | margin {skor:4.1f} | tergenang S1-S4,S6: "
              + ", ".join(f"{x:.1f}%" for x in (f[0], f[1], f[2], f[3], f[5])))
    skor, off, k, hasil = kandidat[0]
    print(f"\nRincian kombinasi teratas (offset {off:.1f} m, k {k:g}):")
    cetak_tabel(hasil)


if __name__ == "__main__":
    main()
