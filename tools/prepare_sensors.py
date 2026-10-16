#!/usr/bin/env python3
"""
prepare_sensors.py - Buat data/vector/sensors.geojson: titik sensor ILUSTRATIF (fiktif) untuk FloodSense.

Titik tidak berasal dari data nyata. Posisinya dipilih agar masuk akal:
  - stasiun hujan, stasiun cuaca, dan pusat data: di daratan, tersebar di beberapa kecamatan
  - sensor debit dan stasiun pasang surut: dipasang di badan sungai, jadi posisinya "ditempelkan"
    ke garis sungai terdekat dari data/vector/waterways.geojson (nama sungai dipakai bila ada)

Posisi awal ditulis sebagai piksel pada grid DEM 619 x 759 (sama dengan preview_elevasi.png),
lalu dikonversi ke lon/lat memakai batas kota dari kecamatan.geojson. Semua titik dipastikan di dalam kota.

Jalankan dari root proyek:
    python tools/prepare_sensors.py
"""
import argparse
import json
import os
import sys

import geopandas as gpd
from shapely.geometry import Point
from shapely.ops import nearest_points

REF_W, REF_H = 619, 759
MAKS_GESER_M = 1500  # titik sungai yang lebih jauh dari ini dari garis terdekat tidak ditempelkan

FUNGSI = {
    "stasiun_hujan": "Mengukur intensitas hujan setempat (mm/jam) sebagai masukan utama simulasi genangan.",
    "stasiun_cuaca": "Memantau curah hujan, suhu, kelembapan, dan angin untuk melengkapi data stasiun hujan.",
    "sensor_debit": "Mengukur debit dan tinggi muka air sungai untuk mendeteksi kenaikan aliran dari hulu.",
    "stasiun_pasut": "Mengukur tinggi pasang surut yang menahan aliran drainase ke sungai (efek backwater).",
    "pusat_data": "Mengumpulkan data semua sensor dan menyebarkan peringatan dini ke petugas dan warga.",
}

# nama, jenis, px, py, tempel ke sungai (None = di daratan)
#   tempel = {"jenis": [...jenis garis air...], "nama": "kata kunci nama (opsional)"}
SENSOR = [
    ("Stasiun Hujan Plenteng",        "stasiun_hujan", 330, 100, None),
    ("Stasiun Hujan Sungai Jawi",     "stasiun_hujan", 150, 310, None),
    ("Stasiun Hujan Sungai Raya",     "stasiun_hujan", 330, 650, None),
    ("Stasiun Hujan Tanjung Hulu",    "stasiun_hujan", 510, 410, None),
    ("Stasiun Cuaca PLN Pontianak",   "stasiun_cuaca", 280, 445, None),
    ("Sensor Debit Sungai Landak",    "sensor_debit",  500, 328, {"jenis": ["river"], "nama": "landak"}),
    ("Sensor Debit Sungai Kapuas",    "sensor_debit",  470, 445, {"jenis": ["river"]}),
    ("Sensor Debit Sungai Raya",      "sensor_debit",  340, 620, {"jenis": ["river", "canal", "stream"]}),
    ("Stasiun Pasang Surut Muara Kapuas",  "stasiun_pasut", 95, 190,  {"jenis": ["river"], "nama": "kapuas kecil"}),
    ("Stasiun Pasang Surut Kapuas Hilir",  "stasiun_pasut", 250, 225, {"jenis": ["river"], "nama": "kapuas kecil"}),
    ("Pusat Data BPBD Kota Pontianak",     "pusat_data",    365, 415, None),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kec", default="data/vector/kecamatan.geojson")
    ap.add_argument("--air", default="data/vector/waterways.geojson")
    ap.add_argument("--out", default="data/vector/sensors.geojson")
    a = ap.parse_args()

    kec = gpd.read_file(a.kec).to_crs(32749)
    air = gpd.read_file(a.air).to_crs(32749)
    kota = kec.geometry.union_all() if hasattr(kec.geometry, "union_all") else kec.geometry.unary_union
    west, south, east, north = gpd.read_file(a.kec).to_crs(4326).total_bounds
    sungai = air[air.geometry.geom_type.isin(["LineString", "MultiLineString"])]

    fitur, baris = [], []
    for nama, jenis, px, py, tempel in SENSOR:
        lon = west + (px / REF_W) * (east - west)
        lat = north - (py / REF_H) * (north - south)
        p = gpd.GeoSeries([Point(lon, lat)], crs=4326).to_crs(32749).iloc[0]
        catatan = []

        if tempel:
            cand = sungai[sungai.jenis.isin(tempel["jenis"])]
            kata = tempel.get("nama")
            if kata:
                bernama = cand[cand.nama.str.lower().str.contains(kata, na=False)]
                if len(bernama):
                    cand = bernama
                else:
                    catatan.append(f"tidak ada garis bernama '{kata}', pakai sungai terdekat")
            if len(cand):
                gabung = cand.geometry.union_all() if hasattr(cand.geometry, "union_all") else cand.geometry.unary_union
                titik = nearest_points(gabung, p)[0]
                jarak = titik.distance(p)
                if jarak <= MAKS_GESER_M:
                    catatan.append(f"ditempel ke sungai (geser {jarak:.0f} m)")
                    p = titik
                else:
                    catatan.append(f"sungai terdekat {jarak:.0f} m, tidak ditempel")
            else:
                catatan.append("tidak ada garis air cocok, tidak ditempel")

        if not kota.contains(p):
            p = nearest_points(kota, p)[0]
            catatan.append("ditarik ke dalam batas kota")

        ll = gpd.GeoSeries([p], crs=32749).to_crs(4326).iloc[0]
        kec_nama = next((r.nama for r in gpd.read_file(a.kec).to_crs(32749).itertuples() if r.geometry.contains(p)), "-")
        fitur.append({
            "type": "Feature",
            "properties": {"nama": nama, "jenis": jenis, "fungsi": FUNGSI[jenis], "ilustratif": True},
            "geometry": {"type": "Point", "coordinates": [round(ll.x, 5), round(ll.y, 5)]},
        })
        baris.append((nama, kec_nama, "; ".join(catatan) or "di daratan"))

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": fitur}, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Sensor ilustratif tersimpan: {len(fitur)} titik -> {a.out} ({os.path.getsize(a.out)} byte)\n")
    print(f"{'Nama':<38}{'Kecamatan':<20}Keterangan")
    for nama, k, c in baris:
        print(f"{nama:<38}{k:<20}{c}")


if __name__ == "__main__":
    main()
