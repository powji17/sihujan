/**
 * dem.js - muat PNG terenkode, dekode ke elevasi, dan sediakan akses sel.
 * Encoding (PRD 6.1): z = ((R*256 + G) / scale) - z_offset ; B = ID kecamatan (0 = diabaikan).
 */
import { MODEL, DATA } from "./config.js";

/**
 * Dekode piksel RGBA mentah menjadi struktur DEM.
 * Elevasi dikurangi `offset` (koreksi vertikal dari config.js) lalu dijepit ke `lantai` (buang lubang artefak).
 */
export function dekodeRGBA(rgba, meta, offset = MODEL.DEM_OFFSET_M, lantai = MODEL.DEM_LANTAI_M) {
  const { width, height, encoding } = meta;
  const n = width * height;
  if (rgba.length !== n * 4) {
    throw new Error(`Ukuran DEM tidak cocok: ${rgba.length / 4} piksel, seharusnya ${n}`);
  }
  const z = new Float32Array(n);
  const ids = new Uint8Array(n);
  const selPerKec = new Uint32Array(Math.max(...meta.kecamatan.map((k) => k.id)) + 1);
  const { z_offset: zOff, scale } = encoding;
  let selKota = 0;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const id = rgba[p + 2];
    ids[i] = id;
    z[i] = Math.max(lantai, (rgba[p] * 256 + rgba[p + 1]) / scale - zOff - offset);
    if (id) {
      selPerKec[id]++;
      selKota++;
    }
  }

  return {
    z, ids, width, height,
    bounds: meta.bounds,
    cellAreaM2: meta.cell_size_m ** 2,
    kecamatan: meta.kecamatan,
    selPerKec,
    selKota,
  };
}

function muatGambar(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Gagal memuat gambar: ${url}`));
    img.src = url;
  });
}

/** Muat DEM dari server (hanya di browser). `base` = awalan path bila perlu. */
export async function muatDem(base = "") {
  const [meta, img] = await Promise.all([
    fetch(base + DATA.demJson).then((r) => {
      if (!r.ok) throw new Error(`Gagal memuat ${DATA.demJson} (HTTP ${r.status})`);
      return r.json();
    }),
    muatGambar(base + DATA.demPng),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  if (canvas.width !== meta.width || canvas.height !== meta.height) {
    throw new Error("Ukuran PNG tidak sama dengan metadata JSON");
  }
  if (data[3] !== 255) {
    throw new Error("Alpha bukan 255: nilai elevasi di PNG kemungkinan rusak");
  }
  return dekodeRGBA(data, meta);
}
