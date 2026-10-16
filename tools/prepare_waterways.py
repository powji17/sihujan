#!/usr/bin/env python3
"""
prepare_waterways.py - Ambil sungai, kanal, dan parit dari OpenStreetMap lalu simpan sebagai
data/vector/waterways.geojson (PRD 6.2, ukuran target < 1,5 MB).

Garis diambil dalam kotak (bbox) kota, dipotong ke area kota (poligon kecamatan + penyangga
sekitar 330 m), disederhanakan, dan diberi atribut: jenis (river | canal | drain | ditch | stream), nama.

Jalankan dari root proyek:
    python tools/prepare_waterways.py --fetch
    python tools/prepare_waterways.py --json data/raw/overpass_waterways.json   # pakai hasil Overpass yang ada
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

import geopandas as gpd
from shapely.geometry import LineString

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
JENIS = ("river", "canal", "drain", "ditch", "stream")
BATAS_MB = 1.5
PENYANGGA_DEG = 0.003  # ~330 m di luar batas kecamatan agar garis tidak terpotong tepat di tepi


def buat_query(bbox):
    s, w, n, e = bbox
    return (
        "[out:json][timeout:120];\n"
        f'way["waterway"~"^({"|".join(JENIS)})$"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});\n'
        "out geom;"
    )


def ambil_overpass(query, endpoints):
    data = urllib.parse.urlencode({"data": query}).encode()
    galat = []
    for url in endpoints:
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "FloodSense-Pontianak/1.0 (proyek kuliah)"})
            with urllib.request.urlopen(req, timeout=180) as r:
                hasil = json.loads(r.read().decode("utf-8"))
            print(f"Overpass OK: {url} ({len(hasil.get('elements', []))} elemen)")
            return hasil
        except Exception as e:  # noqa: BLE001 - coba server berikutnya
            galat.append(f"{url}: {e}")
            print(f"Gagal: {url}: {e}")
    sys.exit("Semua server Overpass gagal. Coba lagi beberapa menit lagi, atau pakai --endpoint.\n"
             "Query yang dipakai:\n" + query + "\n" + "\n".join(galat))


def bulatkan(koordinat, n=5):
    if isinstance(koordinat[0], (int, float)):
        return [round(koordinat[0], n), round(koordinat[1], n)]
    return [bulatkan(k, n) for k in koordinat]


def tulis(gdf, path, tol):
    gs = gdf.copy()
    gs["geometry"] = gs.geometry.simplify(tol, preserve_topology=True)
    gs = gs[~gs.geometry.is_empty & gs.geometry.notna()]
    fitur = []
    for r in gs.itertuples():
        g = r.geometry.__geo_interface__
        fitur.append({
            "type": "Feature",
            "properties": {"jenis": r.jenis, "nama": r.nama},
            "geometry": {"type": g["type"], "coordinates": bulatkan(g["coordinates"])},
        })
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": fitur}, f, ensure_ascii=False, separators=(",", ":"))
    return gs, os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--fetch", action="store_true", help="ambil dari Overpass API")
    src.add_argument("--json", help="berkas hasil Overpass (format JSON)")
    ap.add_argument("--kec", default="data/vector/kecamatan.geojson")
    ap.add_argument("--out", default="data/vector/waterways.geojson")
    ap.add_argument("--raw-out", default="data/raw/overpass_waterways.json")
    ap.add_argument("--endpoint", default=None, help="URL Overpass sendiri (menggantikan daftar bawaan)")
    ap.add_argument("--tol", type=float, default=0.00002, help="toleransi penyederhanaan awal (derajat, ~2 m)")
    a = ap.parse_args()

    kec = gpd.read_file(a.kec).to_crs(4326)
    w, s, e, n = kec.total_bounds
    bbox = (s - 0.005, w - 0.005, n + 0.005, e + 0.005)

    if a.fetch:
        data = ambil_overpass(buat_query(bbox), [a.endpoint] if a.endpoint else ENDPOINTS)
        os.makedirs(os.path.dirname(a.raw_out) or ".", exist_ok=True)
        with open(a.raw_out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        print(f"Hasil mentah disimpan: {a.raw_out}")
    else:
        data = json.load(open(a.json, encoding="utf-8"))

    # ---------- 1. Elemen OSM -> garis ----------
    baris, geom, tanpa_geom = [], [], 0
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        pts = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
        jenis = el.get("tags", {}).get("waterway")
        if len(pts) < 2 or jenis not in JENIS:
            tanpa_geom += 1
            continue
        baris.append({"jenis": jenis, "nama": (el["tags"].get("name") or "").strip()})
        geom.append(LineString(pts))
    if not geom:
        sys.exit("Tidak ada garis air yang valid. Periksa data masukan.")
    gdf = gpd.GeoDataFrame(baris, geometry=geom, crs=4326)

    # ---------- 2. Potong ke area kota ----------
    area = kec.geometry.union_all().buffer(PENYANGGA_DEG) if hasattr(kec.geometry, "union_all") \
        else kec.geometry.unary_union.buffer(PENYANGGA_DEG)
    awal = len(gdf)
    gdf = gpd.clip(gdf, area)
    gdf = gdf[~gdf.geometry.is_empty].explode(index_parts=False).reset_index(drop=True)
    gdf = gdf[gdf.geometry.geom_type == "LineString"].reset_index(drop=True)
    dipotong = awal - len(gdf)

    # ---------- 3. Tulis; naikkan toleransi bila melebihi batas ukuran ----------
    tol = a.tol
    for _ in range(8):
        hasil, ukuran = tulis(gdf, a.out, tol)
        if ukuran <= BATAS_MB * 1024 * 1024:
            break
        tol *= 1.8
        print(f"Ukuran {ukuran / 1024 / 1024:.2f} MB melebihi {BATAS_MB} MB, naikkan toleransi ke {tol:.6f}")

    # ---------- 4. Ringkasan ----------
    panjang = hasil.to_crs(32749).geometry.length / 1000
    print("\n=== RINGKASAN ===")
    print(f"Elemen OSM: {len(data.get('elements', []))} | dilewati (tanpa geometri/jenis lain): {tanpa_geom}")
    print(f"Segmen setelah dipotong ke area kota: {len(gdf)} (dibuang di luar area: {dipotong})")
    print(f"Disimpan: {a.out} ({ukuran / 1024:.0f} KB, toleransi {tol:.6f} derajat)")
    print("Per jenis (jumlah segmen | panjang km | bernama):")
    for j in JENIS:
        m = hasil.jenis == j
        print(f"  {j:<8}{int(m.sum()):>6} {panjang[m].sum():>9.1f} {int((hasil.nama[m] != '').sum()):>8}")
    nama = hasil[hasil.nama != ""].groupby("nama").size().sort_values(ascending=False).head(8)
    print("Nama terbanyak:", ", ".join(f"{k} ({v})" for k, v in nama.items()) or "-")


if __name__ == "__main__":
    main()
