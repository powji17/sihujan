/**
 * renderer.js - gambar genangan ke canvas lalu tampilkan lewat L.imageOverlay.
 * Bagian piksel (buatLut, isiPiksel) murni dan tidak menyentuh DOM, jadi bisa diuji di Node.
 */
import { RENDER } from "./config.js";

const M_PER_DEG = 111320; // harus sama dengan tools/prepare_dem.py

/** Batas gambar DEM sebenarnya (grid dibulatkan ke atas, jadi sedikit melebihi bounds JSON). */
export function ekstenDem(dem) {
  const dx = Math.sqrt(dem.cellAreaM2) / M_PER_DEG;
  const { north, west } = dem.bounds;
  return { north, west, south: north - dem.height * dx, east: west + dem.width * dx };
}

/** Tabel 256 warna (RGBA little-endian dalam Uint32) dari dangkal ke dalam. */
export function buatLut(stops = RENDER.PALET) {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (stops.length - 1);
    const a = Math.min(Math.floor(p), stops.length - 2);
    const f = p - a;
    const [r, g, b] = [0, 1, 2].map((j) => Math.round(stops[a][j] + (stops[a + 1][j] - stops[a][j]) * f));
    lut[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
  return lut;
}

/**
 * Isi buffer piksel: sel tergenang diwarnai menurut kedalaman, sisanya transparan.
 * @returns {number} jumlah sel tergenang
 */
export function isiPiksel(dem, H, piksel, lut, kedalamanMaks = RENDER.KEDALAMAN_MAKS_M) {
  piksel.fill(0);
  if (H <= 0) return 0;
  const { z, ids } = dem;
  const skala = 255 / kedalamanMaks;
  let n = 0;
  for (let i = 0; i < z.length; i++) {
    if (ids[i] === 0) continue;
    const d = H - z[i];
    if (d >= 0) {
      piksel[i] = lut[Math.min(255, (d * skala) | 0)];
      n++;
    }
  }
  return n;
}

/** Layer Leaflet untuk genangan. Membutuhkan `L` global (Leaflet 1.9.x). */
export class LayerGenangan {
  constructor(dem, peta, { opacity = RENDER.OPACITY } = {}) {
    this.dem = dem;
    this.peta = peta;
    this.H = 0;
    this.terlihat = true;
    this.canvas = document.createElement("canvas");
    this.canvas.width = dem.width;
    this.canvas.height = dem.height;
    this.ctx = this.canvas.getContext("2d");
    this.gambar = this.ctx.createImageData(dem.width, dem.height);
    this.piksel = new Uint32Array(this.gambar.data.buffer);
    this.lut = buatLut();
    const { north, west, south, east } = ekstenDem(dem);
    this.overlay = L.imageOverlay(this.canvas.toDataURL(), [[south, west], [north, east]], {
      opacity,
      interactive: false,
    }).addTo(peta);
  }

  _gambar(H) {
    const n = isiPiksel(this.dem, H, this.piksel, this.lut);
    this.ctx.putImageData(this.gambar, 0, 0);
    this.overlay.setUrl(this.canvas.toDataURL("image/png")); // setUrl, bukan layer baru
    return n;
  }

  /** Gambar ulang untuk muka air H (dilewati bila layer sedang disembunyikan). */
  perbarui(H) {
    this.H = H;
    return this.terlihat ? this._gambar(H) : 0;
  }

  /** Nyalakan/matikan layer; saat dinyalakan kembali langsung menampilkan keadaan terbaru. */
  tampilkan(ya) {
    if (ya === this.terlihat) return;
    this.terlihat = ya;
    if (ya) {
      this.overlay.addTo(this.peta);
      this._gambar(this.H);
    } else {
      this.overlay.remove();
    }
  }

  setOpacity(o) {
    this.overlay.setOpacity(o);
  }

  hapus() {
    this.overlay.remove();
  }
}
