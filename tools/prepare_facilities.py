#!/usr/bin/env python3
"""
prepare_facilities.py - Ambil fasilitas umum (rumah sakit, puskesmas/klinik, sekolah)
dari OpenStreetMap lalu simpan sebagai data/vector/facilities.geojson (PRD 6.2).

Fasilitas diambil dalam kotak (bbox) kota, diubah menjadi titik (pusat bangunan bila berupa
area), dipotong ke poligon kecamatan, dibersihkan dari duplikat, dan diberi atribut:
    nama, jenis (rumah_sakit | puskesmas_klinik | sekolah), kecamatan, osm

Jalankan dari root proyek:
    python tools/prepare_facilities.py --fetch                    # ambil langsung dari Overpass API
    python tools/prepare_facilities.py --json data/raw/overpass.json   # pakai hasil Overpass yang sudah ada
"""
import argparse
import json
import math
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request

import geopandas as gpd
from shapely.geometry import Point

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
JENIS_LABEL = {"rumah_sakit": "Rumah sakit", "puskesmas_klinik": "Puskesmas/klinik", "sekolah": "Sekolah"}
RE_KLINIK = re.compile(r"puskesmas|pustu|klinik|poliklinik|balai pengobatan", re.I)
JARAK_DUPLIKAT_DEG = 0.003  # ~330 m; nama dan jenis sama dalam jarak ini dianggap satu fasilitas


def buat_query(bbox):
    s, w, n, e = bbox
    kotak = f"({s:.5f},{w:.5f},{n:.5f},{e:.5f})"
    return (
        "[out:json][timeout:90];\n(\n"
        f'  nwr["amenity"~"^(hospital|clinic|school)$"]{kotak};\n'
        f'  nwr["healthcare"~"^(hospital|clinic|centre)$"]{kotak};\n'
        ");\nout center tags;"
    )


def ambil_overpass(query, endpoints):
    data = urllib.parse.urlencode({"data": query}).encode()
    galat = []
    for url in endpoints:
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "FloodSense-Pontianak/1.0 (proyek kuliah)"})
            with urllib.request.urlopen(req, timeout=120) as r:
                hasil = json.loads(r.read().decode("utf-8"))
            print(f"Overpass OK: {url} ({len(hasil.get('elements', []))} elemen)")
            return hasil
        except Exception as e:  # noqa: BLE001 - coba server berikutnya
            galat.append(f"{url}: {e}")
            print(f"Gagal: {url}: {e}")
    sys.exit("Semua server Overpass gagal. Coba lagi beberapa menit lagi, atau pakai --endpoint.\n"
             "Query yang dipakai:\n" + query + "\n" + "\n".join(galat))


def klasifikasi(tags):
    amenity, health, nama = tags.get("amenity", ""), tags.get("healthcare", ""), tags.get("name", "")
    if amenity == "hospital" or health == "hospital":
        return "rumah_sakit"
    if amenity == "clinic" or health in ("clinic", "centre") or RE_KLINIK.search(nama):
        return "puskesmas_klinik"
    if amenity == "school":
        return "sekolah"
    return None


def normal(nama):
    s = unicodedata.normalize("NFKD", nama).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def titik(el):
    if el["type"] == "node":
        return el.get("lon"), el.get("lat")
    c = el.get("center") or {}
    return c.get("lon"), c.get("lat")


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--fetch", action="store_true", help="ambil dari Overpass API")
    src.add_argument("--json", help="berkas hasil Overpass (format JSON)")
    ap.add_argument("--kec", default="data/vector/kecamatan.geojson")
    ap.add_argument("--out", default="data/vector/facilities.geojson")
    ap.add_argument("--raw-out", default="data/raw/overpass_fasilitas.json", help="simpan hasil mentah Overpass")
    ap.add_argument("--endpoint", default=None, help="URL Overpass sendiri (menggantikan daftar bawaan)")
    a = ap.parse_args()

    kec = gpd.read_file(a.kec).to_crs(4326)
    w, s, e, n = kec.total_bounds
    bbox = (s - 0.005, w - 0.005, n + 0.005, e + 0.005)

    if a.fetch:
        query = buat_query(bbox)
        data = ambil_overpass(query, [a.endpoint] if a.endpoint else ENDPOINTS)
        os.makedirs(os.path.dirname(a.raw_out) or ".", exist_ok=True)
        with open(a.raw_out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        print(f"Hasil mentah disimpan: {a.raw_out}")
    else:
        data = json.load(open(a.json, encoding="utf-8"))

    # ---------- 1. Elemen OSM -> baris ----------
    baris, tanpa_nama, tanpa_titik, tak_dikenal = [], 0, 0, 0
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        jenis = klasifikasi(tags)
        if not jenis:
            tak_dikenal += 1
            continue
        lon, lat = titik(el)
        if lon is None or lat is None:
            tanpa_titik += 1
            continue
        nama = re.sub(r"\s+", " ", (tags.get("name") or tags.get("official_name") or "")).strip()
        if not nama:
            tanpa_nama += 1
            continue
        # area (way/relation) didahulukan: pusatnya lebih mewakili bangunan utama daripada titik pintu
        prioritas = 0 if el["type"] != "node" else 1
        baris.append((prioritas, jenis, nama, lon, lat, f"{el['type']}/{el['id']}"))
    baris.sort(key=lambda r: (r[0], r[2]))

    # ---------- 2. Duplikat (nama + jenis sama, berdekatan) ----------
    dipakai, duplikat = [], 0
    for pr, jenis, nama, lon, lat, osm in baris:
        kunci = normal(nama)
        sama = any(j == jenis and k == kunci and math.hypot(lon - x, lat - y) < JARAK_DUPLIKAT_DEG
                   for j, k, x, y in ((d[1], normal(d[2]), d[3], d[4]) for d in dipakai))
        if sama:
            duplikat += 1
        else:
            dipakai.append((pr, jenis, nama, lon, lat, osm))

    # ---------- 3. Potong ke poligon kecamatan ----------
    gdf = gpd.GeoDataFrame(
        [{"nama": r[2], "jenis": r[1], "osm": r[5]} for r in dipakai],
        geometry=[Point(r[3], r[4]) for r in dipakai], crs=4326,
    )
    if gdf.empty:
        sys.exit("Tidak ada fasilitas yang cocok. Periksa data masukan.")
    gabung = gpd.sjoin(gdf, kec[["nama", "geometry"]].rename(columns={"nama": "kecamatan"}),
                       how="inner", predicate="within")
    di_luar = len(gdf) - len(gabung)
    gabung = gabung.sort_values(["jenis", "nama"]).reset_index(drop=True)

    # ---------- 4. Tulis GeoJSON ----------
    fitur = [{
        "type": "Feature",
        "properties": {"id": i + 1, "nama": r.nama, "jenis": r.jenis, "kecamatan": r.kecamatan, "osm": r.osm},
        "geometry": {"type": "Point", "coordinates": [round(r.geometry.x, 5), round(r.geometry.y, 5)]},
    } for i, r in gabung.iterrows()]
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": fitur}, f, ensure_ascii=False, separators=(",", ":"))

    # ---------- 5. Ringkasan ----------
    print("\n=== RINGKASAN ===")
    print(f"Elemen OSM: {len(data.get('elements', []))} | bukan target: {tak_dikenal} | tanpa koordinat: {tanpa_titik}")
    print(f"Dibuang: tanpa nama {tanpa_nama} | duplikat {duplikat} | di luar kota {di_luar}")
    print(f"Fasilitas tersimpan: {len(fitur)} -> {a.out} ({os.path.getsize(a.out) / 1024:.1f} KB)")
    print("Per jenis:")
    for j, lab in JENIS_LABEL.items():
        print(f"  {lab:<18}{(gabung.jenis == j).sum():>4}")
    print("Per kecamatan:")
    print(f"  {'Kecamatan':<20}{'RS':>4}{'Pusk/Klinik':>13}{'Sekolah':>9}")
    pivot = gabung.groupby(["kecamatan", "jenis"]).size().unstack(fill_value=0)
    for k in kec["nama"]:
        v = [int(pivot.loc[k, j]) if (k in pivot.index and j in pivot.columns) else 0 for j in JENIS_LABEL]
        print(f"  {k:<20}{v[0]:>4}{v[1]:>13}{v[2]:>9}")
    print("Contoh:")
    for r in gabung.groupby("jenis").head(3).itertuples():
        print(f"  [{JENIS_LABEL[r.jenis]}] {r.nama} ({r.kecamatan})")


if __name__ == "__main__":
    main()
