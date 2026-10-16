/**
 * impact.js - statistik dampak: fasilitas terdampak dan urutan kecamatan.
 * Fungsi murni, tanpa DOM, aman diuji di Node.
 */
import { DATA } from "./config.js";
import { ekstenDem } from "./renderer.js";
import { statusDariPersen } from "./simulation.js";

/**
 * Elevasi DEM (sudah terkoreksi offset) pada koordinat lat/lon.
 * Bila titik jatuh di sel tanpa ID (air/luar kota), pakai sel darat terdekat dalam radius 3 sel.
 * @returns {number|null} null bila di luar jangkauan DEM
 */
export function elevasiTitik(dem, lat, lon) {
  const { north, west, east } = ekstenDem(dem);
  const dx = (east - west) / dem.width;
  const x = Math.floor((lon - west) / dx);
  const y = Math.floor((north - lat) / dx);
  if (x < 0 || y < 0 || x >= dem.width || y >= dem.height) return null;

  let i = y * dem.width + x;
  if (dem.ids[i] === 0) {
    let terbaik = -1;
    let jarak = Infinity;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dxx = -3; dxx <= 3; dxx++) {
        const xx = x + dxx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= dem.width || yy >= dem.height) continue;
        const j = yy * dem.width + xx;
        const d = dxx * dxx + dy * dy;
        if (dem.ids[j] !== 0 && d < jarak) {
          jarak = d;
          terbaik = j;
        }
      }
    }
    if (terbaik >= 0) i = terbaik;
  }
  return dem.z[i];
}

/** Muat facilities.geojson dan hitung elevasi tiap fasilitas dari DEM (sekali saat startup). */
export async function muatFasilitas(dem, url = DATA.fasilitas) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Gagal memuat ${url} (HTTP ${r.status})`);
  const g = await r.json();
  const hasil = [];
  for (const f of g.features) {
    const [lon, lat] = f.geometry.coordinates;
    const z = elevasiTitik(dem, lat, lon);
    if (z === null) continue; // di luar DEM
    const p = f.properties;
    hasil.push({ id: p.id, nama: p.nama, jenis: p.jenis, kecamatan: p.kecamatan, lat, lon, z });
  }
  return hasil;
}

/** Fasilitas yang tergenang pada muka air H (z <= H), diurutkan dari yang terdalam. */
export function analisaFasilitas(fasilitas, H) {
  const terdampak = [];
  const perJenis = { rumah_sakit: 0, puskesmas_klinik: 0, sekolah: 0 };
  if (H > 0) {
    for (const f of fasilitas) {
      if (f.z <= H) {
        terdampak.push({ ...f, kedalaman: H - f.z });
        perJenis[f.jenis] = (perJenis[f.jenis] || 0) + 1;
      }
    }
    terdampak.sort((a, b) => b.kedalaman - a.kedalaman || a.id - b.id);
  }
  return { terdampak, perJenis, total: fasilitas.length };
}

/** Kecamatan diurutkan dari luas tergenang terbesar, dengan status mini per kecamatan. */
export function urutkanKecamatan(perKec) {
  return perKec
    .map((k) => ({ ...k, status: statusDariPersen(k.persen) }))
    .sort((a, b) => b.luasHa - a.luasHa || a.id - b.id);
}
