#!/usr/bin/env python3
"""
prepare_dem.py (v2) - Siapkan data elevasi untuk FloodSense Pontianak.

Input : GeoTIFF DEM gabungan + GeoJSON batas kecamatan
Output: data/dem/pontianak_dem.png   (R,G = elevasi; B = ID kecamatan; A = 255)
        data/dem/pontianak_dem.json  (metadata)
        data/vector/kecamatan.geojson (disederhanakan, atribut id + nama)

Encoding (PRD 6.1):
    nilai = round((z + 10) * 100)  ->  R = nilai // 256, G = nilai % 256
    Dekode di browser: z = ((R * 256 + G) / 100) - 10
    B = ID kecamatan (0 = di luar kota ATAU badan air, 1-6)

Perubahan v2 (karena DEMNAS adalah DSM dan sungai ikut terhitung sebagai genangan):
  1. Badan air dideteksi dari DEM (gumpalan besar sel rendah yang saling terhubung),
     lalu ID-nya dijadikan 0 supaya tidak dihitung sebagai genangan.
  2. Elevasi dihaluskan mendekati permukaan tanah: ambil elevasi rendah lokal
     (persentil dalam jendela kecil) lalu haluskan sedikit. Ini mengurangi efek
     atap bangunan dan tajuk pohon.

Contoh pakai:
    python tools/prepare_dem.py --dem data/raw/demnas_pontianak.tif \
        --kec data/raw/kecamatan_osm.geojson --name-field name
"""
import argparse
import json
import math
import os
import re
import sys

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from rasterio.windows import from_bounds
from scipy import ndimage as ndi

KECAMATAN = [
    (1, "Pontianak Kota", "kota"),
    (2, "Pontianak Selatan", "selatan"),
    (3, "Pontianak Tenggara", "tenggara"),
    (4, "Pontianak Timur", "timur"),
    (5, "Pontianak Barat", "barat"),
    (6, "Pontianak Utara", "utara"),
]
M_PER_DEG = 111_320.0
Z_OFFSET = 10.0
Z_MIN, Z_MAX = -10.0, 600.0
PERSENTIL = (1, 5, 10, 25, 50, 75, 90, 99)


def normalisasi(nama: str) -> str:
    s = str(nama).lower()
    s = re.sub(r"kecamatan|kec\.?|pontianak|kota pontianak", "", s)
    if not s.strip() and "kota" in str(nama).lower():
        return "kota"
    return re.sub(r"[^a-z]", "", s)


def deteksi_air(z, dalam, z_maks, min_sel):
    """Badan air = gumpalan besar sel rendah (z <= z_maks) yang saling terhubung."""
    rendah = (z <= z_maks) & dalam
    lab, n = ndi.label(rendah, structure=np.ones((3, 3)))
    if n == 0:
        return np.zeros_like(dalam), []
    ukuran = ndi.sum(rendah, lab, index=np.arange(1, n + 1))
    besar_id = np.where(ukuran >= min_sel)[0] + 1
    air = np.isin(lab, besar_id)
    # tutup celah sempit (jembatan, kapal) di dalam sungai; pad dulu agar tepi grid tidak terkikis
    pad = 4
    air = np.pad(air, pad, mode="edge")
    air = ndi.binary_closing(air, structure=np.ones((3, 3)), iterations=3)[pad:-pad, pad:-pad]
    top = sorted((int(u) for u in ukuran), reverse=True)[:6]
    return air & dalam, top


def pseudo_tanah(z, darat, jendela, persen, sigma):
    """Dekati permukaan tanah dari DSM: persentil rendah lokal + penghalusan."""
    # sel air diisi elevasi darat terdekat agar tepi sungai tidak ikut terseret turun
    idx = ndi.distance_transform_edt(~darat, return_distances=False, return_indices=True)
    z_isi = z[tuple(idx)]
    z_rendah = ndi.percentile_filter(z_isi, percentile=persen, size=jendela, mode="nearest")
    return ndi.gaussian_filter(z_rendah, sigma=sigma, mode="nearest") if sigma > 0 else z_rendah


def cetak_persentil(judul, nilai):
    baris = " | ".join(f"p{p} {np.percentile(nilai, p):.2f}" for p in PERSENTIL)
    print(f"  {judul}: {baris}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dem", required=True)
    ap.add_argument("--kec", required=True)
    ap.add_argument("--name-field", default=None, help="kolom nama kecamatan")
    ap.add_argument("--cell-m", type=float, default=20.0, help="ukuran sel target (m)")
    ap.add_argument("--out-dem", default="data/dem")
    ap.add_argument("--out-vec", default="data/vector")
    ap.add_argument("--simplify-deg", type=float, default=0.0001)
    ap.add_argument("--water-max-z", type=float, default=1.0, help="elevasi maks sel air (m)")
    ap.add_argument("--water-min-cells", type=int, default=800, help="ukuran minimum gumpalan air (sel)")
    ap.add_argument("--win", type=int, default=7, help="jendela persentil (sel ganjil)")
    ap.add_argument("--pct", type=float, default=10, help="persentil rendah lokal (0-100)")
    ap.add_argument("--sigma", type=float, default=1.5, help="penghalusan gaussian (sel)")
    ap.add_argument("--no-smooth", action="store_true", help="lewati pseudo-tanah")
    a = ap.parse_args()

    # ---------- 1. Kecamatan ----------
    gdf = gpd.read_file(a.kec)
    if gdf.crs is None:
        gdf = gdf.set_crs(4326)
    gdf = gdf.to_crs(4326)
    print(f"Kecamatan: {len(gdf)} fitur, kolom: {list(gdf.columns)}")

    if a.name_field is None:
        print("\nPilih salah satu kolom di bawah sebagai --name-field:")
        for c in gdf.columns:
            if c != "geometry":
                print(f"  {c}: {list(gdf[c].head(8))}")
        sys.exit(0)

    gdf["_key"] = gdf[a.name_field].map(normalisasi)
    id_by_key = {k: (i, n) for i, n, k in KECAMATAN}
    belum = [v for v in gdf[a.name_field] if normalisasi(v) not in id_by_key]
    if belum:
        sys.exit(f"Nama tidak cocok dengan 6 kecamatan: {belum}\n"
                 f"Nilai kolom {a.name_field}: {list(gdf[a.name_field])}")
    gdf["id"] = gdf["_key"].map(lambda k: id_by_key[k][0])
    gdf["nama"] = gdf["_key"].map(lambda k: id_by_key[k][1])
    gdf = gdf.dissolve(by=["id", "nama"], as_index=False)
    if len(gdf) != 6:
        print(f"PERINGATAN: hasil {len(gdf)} kecamatan (harusnya 6).")

    west, south, east, north = gdf.total_bounds

    # ---------- 2. Grid target ----------
    dx = a.cell_m / M_PER_DEG
    width = math.ceil((east - west) / dx)
    height = math.ceil((north - south) / dx)
    dst_transform = from_origin(west, north, dx, dx)
    print(f"Grid target: {width} x {height} = {width * height:,} sel @ ~{a.cell_m} m")

    # ---------- 3. Baca DEM (jendela kota) lalu resample bilinear ----------
    with rasterio.open(a.dem) as src:
        pad = 0.002
        win = from_bounds(west - pad, south - pad, east + pad, north + pad,
                          transform=src.transform).round_offsets().round_lengths()
        win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
        data = src.read(1, window=win).astype("float32")
        src_transform = src.window_transform(win)
        if src.nodata is not None:
            data[data == src.nodata] = np.nan
        z = np.full((height, width), np.nan, dtype="float32")
        reproject(
            source=data, destination=z,
            src_transform=src_transform, src_crs=src.crs,
            dst_transform=dst_transform, dst_crs="EPSG:4326",
            src_nodata=np.nan, dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )

    # ---------- 4. ID kecamatan ----------
    shapes = [(geom, int(i)) for geom, i in zip(gdf.geometry, gdf["id"])]
    ids = rasterize(shapes, out_shape=(height, width), transform=dst_transform,
                    fill=0, dtype="uint8")
    dalam = ids > 0

    # ---------- 5. Nodata di dalam kota ----------
    n_nan = int(np.isnan(z[dalam]).sum())
    if n_nan:
        print(f"Catatan: {n_nan:,} sel dalam kota tanpa data elevasi -> diisi 0,0 m "
              f"({n_nan / dalam.sum() * 100:.2f}%), umumnya badan air")
    z = np.where(np.isnan(z), 0.0, z)
    z = np.clip(z, Z_MIN, Z_MAX).astype("float32")

    # ---------- 6. Badan air ----------
    air, top = deteksi_air(z, dalam, a.water_max_z, a.water_min_cells)
    darat = dalam & ~air
    print(f"\nBadan air: {int(air.sum()):,} sel = {air.sum() / dalam.sum() * 100:.1f}% dari poligon kota "
          f"(z <= {a.water_max_z} m, gumpalan >= {a.water_min_cells} sel)")
    print(f"  ukuran gumpalan sel rendah terbesar: {top}")

    # ---------- 7. Pseudo-tanah ----------
    print("\nElevasi daratan (m):")
    cetak_persentil("mentah   ", z[darat])
    if a.no_smooth:
        zf = z
    else:
        win_sel = a.win if a.win % 2 == 1 else a.win + 1
        zf = pseudo_tanah(z, darat, win_sel, a.pct, a.sigma).astype("float32")
        print(f"  (persentil {a.pct:g} jendela {win_sel}x{win_sel} sel = {win_sel * a.cell_m:.0f} m, sigma {a.sigma:g})")
        cetak_persentil("dihaluskan", zf[darat])
    zf = np.clip(zf, Z_MIN, Z_MAX)

    # ID akhir: air dikeluarkan (0 = diabaikan)
    ids_akhir = np.where(air, 0, ids).astype("uint8")

    # ---------- 8. Encode PNG ----------
    val = np.rint((zf + Z_OFFSET) * 100).astype(np.uint16)
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[..., 0] = (val >> 8).astype(np.uint8)
    rgba[..., 1] = (val & 0xFF).astype(np.uint8)
    rgba[..., 2] = ids_akhir
    rgba[..., 3] = 255
    os.makedirs(a.out_dem, exist_ok=True)
    png_path = os.path.join(a.out_dem, "pontianak_dem.png")
    Image.fromarray(rgba).save(png_path, optimize=True)

    # ---------- 9. Metadata JSON ----------
    meta = {
        "bounds": {"south": south, "west": west, "north": north, "east": east},
        "width": width,
        "height": height,
        "cell_size_m": round(dx * M_PER_DEG, 2),
        "encoding": {
            "formula": "z = ((R*256 + G) / 100) - 10",
            "z_offset": Z_OFFSET, "scale": 100,
            "R": "byte tinggi", "G": "byte rendah",
            "B": "id kecamatan (0 = luar kota atau badan air)", "A": 255,
        },
        "kecamatan": [{"id": int(i), "nama": n} for i, n in zip(gdf["id"], gdf["nama"])],
        "pengolahan": {
            "badan_air": {"z_maks_m": a.water_max_z, "min_sel": a.water_min_cells},
            "pseudo_tanah": None if a.no_smooth else
                {"persentil": a.pct, "jendela_sel": a.win, "sigma_sel": a.sigma},
        },
    }
    json_path = os.path.join(a.out_dem, "pontianak_dem.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # ---------- 10. Kecamatan ringan untuk peta ----------
    os.makedirs(a.out_vec, exist_ok=True)
    kv = gdf[["id", "nama", "geometry"]].copy()
    kv["geometry"] = kv.geometry.simplify(a.simplify_deg, preserve_topology=True)
    kec_path = os.path.join(a.out_vec, "kecamatan.geojson")
    kv.to_file(kec_path, driver="GeoJSON")

    # ---------- 11. Preview: darat abu (0-10 m), air biru, luar kota putih ----------
    gray = (np.clip(zf / 10.0, 0, 1) * 255).astype(np.uint8)
    pv = np.stack([gray, gray, gray], axis=-1)
    pv[air] = (8, 48, 107)
    pv[~dalam] = 255
    prev_path = os.path.join(os.path.dirname(a.dem) or ".", "preview_elevasi.png")
    Image.fromarray(pv).save(prev_path)

    # ---------- 12. Ringkasan ----------
    zd = zf[darat]
    print("\n=== RINGKASAN ===")
    print(f"Sel darat: {zd.size:,} | min {zd.min():.2f} | median {np.median(zd):.2f} | maks {zd.max():.2f} m")
    for h in (0.5, 1.0, 1.5, 2.0, 3.0, 4.0):
        print(f"  sel darat dengan z <= {h:.1f} m: {(zd <= h).mean() * 100:5.1f}%")
    print("Sel darat per kecamatan (air sudah dikeluarkan):")
    for i, n, _ in KECAMATAN:
        print(f"  {i} {n:<20} {(ids_akhir == i).sum():>9,}")
    for p in (png_path, json_path, kec_path):
        print(f"{p}: {os.path.getsize(p) / 1024:.0f} KB")
    print(f"Preview: {prev_path}")


if __name__ == "__main__":
    main()
