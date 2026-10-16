/**
 * layers.js - layer Leaflet tambahan (fasilitas umum). Membutuhkan `L` global.
 */
import { FASILITAS, SENSOR, PARIT_GAYA, RENDER } from "./config.js";
import { statusDariPersen } from "./simulation.js";
import { esc, fmt } from "./util.js";

/** Pane khusus agar urutan tumpukan pasti: genangan (400) < parit (410) < kecamatan (420) < penanda. */
function pane(peta, nama, z) {
  const p = peta.getPane(nama) || peta.createPane(nama);
  p.style.zIndex = z;
}

export async function muatGeoJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Gagal memuat ${url} (HTTP ${r.status})`);
  return r.json();
}

/** Dasar layer yang bisa dinyalakan/dimatikan. Subkelas mengisi `this.grup`. */
class LayerBiasa {
  constructor(peta) {
    this.peta = peta;
    this.terlihat = false;
  }
  tampilkan(ya) {
    if (ya === this.terlihat) return;
    this.terlihat = ya;
    if (ya) this.grup.addTo(this.peta);
    else this.grup.remove();
  }
  hapus() {
    this.grup.remove();
    this.terlihat = false;
  }
}

export class LayerFasilitas {
  constructor(fasilitas, peta) {
    this.peta = peta;
    this.H = 0;
    this.terdampakTerakhir = [];
    this.terlihat = true;
    this.items = new Map();
    this.grup = L.layerGroup().addTo(peta);

    for (const f of fasilitas) {
      const j = FASILITAS[f.jenis];
      if (!j) continue;
      const icon = L.divIcon({
        className: "fas-wrap",
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        popupAnchor: [0, -14],
        html: `<div class="fas j-${f.jenis}" style="--w:${j.warna}"><div class="bentuk"><span>${j.huruf}</span></div></div>`,
      });
      const marker = L.marker([f.lat, f.lon], { icon, title: f.nama, alt: f.nama, keyboard: true, riseOnHover: true });
      marker.bindPopup(() => this.isiPopup(f));
      marker.addTo(this.grup);
      this.items.set(f.id, { f, marker, kena: false });
    }
  }

  isiPopup(f) {
    const j = FASILITAS[f.jenis];
    const kena = this.H > 0 && f.z <= this.H;
    const status = kena
      ? `<p class="pop-kena">&#9888; Terdampak, kedalaman perkiraan &asymp; ${fmt(this.H - f.z, 2)} m</p>`
      : `<p class="pop-aman">&#10004; Belum terdampak (butuh muka air &gt; ${fmt(Math.max(f.z, 0), 2)} m)</p>`;
    return `<strong>${esc(f.nama)}</strong><br>${j.label} &middot; ${esc(f.kecamatan)}${status}`;
  }

  /** Tandai fasilitas terdampak untuk muka air H. */
  perbarui(H, terdampak) {
    this.H = H;
    this.terdampakTerakhir = terdampak;
    const kenaSet = new Set(terdampak.map((t) => t.id));
    for (const it of this.items.values()) {
      const kena = kenaSet.has(it.f.id);
      const el = it.marker.getElement();
      if (el) el.querySelector(".fas").classList.toggle("kena", kena);
      if (kena !== it.kena) {
        it.kena = kena;
        it.marker.setZIndexOffset(kena ? 1000 : 0);
      }
      if (it.marker.isPopupOpen()) it.marker.getPopup().setContent(this.isiPopup(it.f));
    }
  }

  /** Nyalakan/matikan layer; penanda dibuat ulang saat dinyalakan, jadi status terdampak dipasang lagi. */
  tampilkan(ya) {
    if (ya === this.terlihat) return;
    this.terlihat = ya;
    if (ya) {
      this.grup.addTo(this.peta);
      this.perbarui(this.H, this.terdampakTerakhir);
    } else {
      this.grup.remove();
    }
  }

  /** Zoom ke fasilitas dan buka popup-nya. */
  fokus(id) {
    const it = this.items.get(id);
    if (!it) return;
    this.peta.setView(it.marker.getLatLng(), Math.max(this.peta.getZoom(), 15));
    it.marker.openPopup();
  }

  hapus() {
    this.grup.remove();
  }
}

/** Batas kecamatan: garis tipis, label nama, popup luas tergenang saat ini (FR-20). */
export class LayerKecamatan extends LayerBiasa {
  constructor(geojson, peta) {
    super(peta);
    pane(peta, "paneKecamatan", 420);
    this.data = new Map(); // id -> hasil hitung terbaru dari hitungGenangan().perKec
    this.grup = L.geoJSON(geojson, {
      pane: "paneKecamatan",
      style: { color: "#44546a", weight: 1.3, fill: true, fillColor: "#000", fillOpacity: 0 },
      onEachFeature: (f, layer) => {
        layer.bindTooltip(esc(f.properties.nama), {
          permanent: true,
          direction: "center",
          className: "label-kec",
          interactive: false,
        });
        layer.bindPopup(() => this.isiPopup(f.properties));
        layer.kecId = f.properties.id;
      },
    });
  }

  isiPopup(p) {
    const d = this.data.get(p.id);
    if (!d) return `<strong>${esc(p.nama)}</strong>`;
    const st = statusDariPersen(d.persen);
    return (
      `<strong>${esc(p.nama)}</strong>` +
      `<p>Luas tergenang saat ini: <b>${fmt(d.luasHa)} ha</b> (${fmt(d.persen, 1)}% wilayah)</p>` +
      `<p><span class="mini ${st.id}">${st.label}</span></p>`
    );
  }

  /** Simpan angka terbaru; popup yang sedang terbuka ikut diperbarui. */
  perbarui(perKec) {
    for (const k of perKec) this.data.set(k.id, k);
    this.grup.eachLayer((l) => {
      if (l.isPopupOpen()) l.getPopup().setContent(this.isiPopup(l.feature.properties));
    });
  }
}

/** Sungai, kanal, dan parit dari OpenStreetMap (FR-21). */
export class LayerParit extends LayerBiasa {
  constructor(geojson, peta) {
    super(peta);
    pane(peta, "paneParit", 410);
    this.grup = L.geoJSON(geojson, {
      pane: "paneParit",
      interactive: false,
      style: (f) => ({ ...(PARIT_GAYA[f.properties.jenis] || PARIT_GAYA.ditch), opacity: 0.85, lineCap: "round" }),
    });
  }
}

/** Titik sensor ILUSTRATIF (FR-23): informatif, tidak terhubung ke data nyata. */
export class LayerSensor extends LayerBiasa {
  constructor(geojson, peta) {
    super(peta);
    this.grup = L.layerGroup();
    for (const f of geojson.features) {
      const p = f.properties;
      const j = SENSOR[p.jenis];
      if (!j) continue;
      const [lon, lat] = f.geometry.coordinates;
      const icon = L.divIcon({
        className: "fas-wrap",
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        popupAnchor: [0, -12],
        html: `<div class="snr j-${p.jenis}" style="--w:${j.warna}"><span>${j.huruf}</span></div>`,
      });
      L.marker([lat, lon], { icon, title: p.nama, alt: p.nama, keyboard: true, riseOnHover: true })
        .bindPopup(
          `<strong>${esc(p.nama)}</strong><br>${j.label}` +
            `<p>${esc(p.fungsi)}</p>` +
            `<p class="pop-ilus">&#9432; Lokasi ilustratif: titik ini bukan lokasi sensor sebenarnya dan tidak terhubung ke data nyata.</p>`
        )
        .addTo(this.grup);
    }
  }
}

/** Legenda lengkap di pojok kanan bawah peta (Corner Scale & Pop - Apple/Mapbox style). */
export function buatLegenda(peta) {
  const kontrol = L.control({ position: "bottomright" });
  kontrol.onAdd = () => {
    const maks = RENDER.KEDALAMAN_MAKS_M;
    const warna = RENDER.PALET.map((c) => `rgb(${c.join(",")})`).join(", ");
    const tanda = [0, 0.25, 0.5, 0.75, 1].map((f, i, a) => (i === a.length - 1 ? `≥ ${fmt(maks, 1)} m` : fmt(maks * f, 1)));

    const wadah = L.DomUtil.create("div", "map-legend-wrap");
    L.DomEvent.disableClickPropagation(wadah);
    L.DomEvent.disableScrollPropagation(wadah);

    wadah.innerHTML = `
      <div class="map-legend-card" role="region" aria-label="Legenda peta">
        <div class="map-legend-header">
          <div class="map-legend-title">
            <svg class="map-legend-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
              <polyline points="2 17 12 22 22 17"></polyline>
              <polyline points="2 12 12 17 22 12"></polyline>
            </svg>
            <span>Legenda Peta</span>
          </div>
          <button type="button" class="map-legend-btn" aria-label="Tutup legenda" title="Tutup legenda">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        </div>

        <div class="map-legend-content">
          <!-- Kedalaman Genangan -->
          <div class="map-legend-sec">
            <div class="map-legend-subtitle">Kedalaman genangan</div>
            <div class="map-legend-bar" style="background:linear-gradient(to right, ${warna})"></div>
            <div class="map-legend-scale">
              ${tanda.map((t) => `<span>${t}</span>`).join("")}
            </div>
          </div>

          <!-- Batas & Aliran Air -->
          <div class="map-legend-sec">
            <div class="map-legend-grid-2">
              <div class="map-legend-item">
                <span class="legend-swatch-line swatch-parit"></span>
                <span>Sungai & parit</span>
              </div>
              <div class="map-legend-item">
                <span class="legend-swatch-line swatch-kec"></span>
                <span>Batas kecamatan</span>
              </div>
            </div>
          </div>

          <!-- Fasilitas Umum -->
          <div class="map-legend-sec">
            <div class="map-legend-subtitle">Fasilitas umum</div>
            <div class="map-legend-chips">
              <div class="map-legend-chip" title="${FASILITAS.rumah_sakit.label}">
                <span class="legend-badge fas-rs">${FASILITAS.rumah_sakit.huruf}</span>
                <span>${FASILITAS.rumah_sakit.label}</span>
              </div>
              <div class="map-legend-chip" title="${FASILITAS.puskesmas_klinik.label}">
                <span class="legend-badge fas-klinik">${FASILITAS.puskesmas_klinik.huruf}</span>
                <span>Puskesmas</span>
              </div>
              <div class="map-legend-chip" title="${FASILITAS.sekolah.label}">
                <span class="legend-badge fas-sekolah"><span>${FASILITAS.sekolah.huruf}</span></span>
                <span>${FASILITAS.sekolah.label}</span>
              </div>
            </div>
          </div>

          <!-- Titik Sensor -->
          <div class="map-legend-sec">
            <div class="map-legend-subtitle">Titik sensor <small>(ilustratif)</small></div>
            <div class="map-legend-chips">
              <div class="map-legend-chip" title="${SENSOR.stasiun_hujan.label}">
                <span class="legend-badge snr-r">${SENSOR.stasiun_hujan.huruf}</span>
                <span>Hujan</span>
              </div>
              <div class="map-legend-chip" title="${SENSOR.stasiun_cuaca.label}">
                <span class="legend-badge snr-c">${SENSOR.stasiun_cuaca.huruf}</span>
                <span>Cuaca</span>
              </div>
              <div class="map-legend-chip" title="${SENSOR.sensor_debit.label}">
                <span class="legend-badge snr-d">${SENSOR.sensor_debit.huruf}</span>
                <span>Debit</span>
              </div>
              <div class="map-legend-chip" title="${SENSOR.stasiun_pasut.label}">
                <span class="legend-badge snr-p">${SENSOR.stasiun_pasut.huruf}</span>
                <span>Pasut</span>
              </div>
              <div class="map-legend-chip" title="${SENSOR.pusat_data.label}">
                <span class="legend-badge snr-b">${SENSOR.pusat_data.huruf}</span>
                <span>BPBD</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <button type="button" class="map-legend-pill" aria-label="Buka legenda peta" title="Buka legenda peta">
        <svg class="map-legend-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
          <polyline points="2 17 12 22 22 17"></polyline>
          <polyline points="2 12 12 17 22 12"></polyline>
        </svg>
        <span class="map-legend-pill-text">Legenda</span>
        <span class="map-legend-pill-swatch" aria-hidden="true" style="background:linear-gradient(to right, ${warna})"></span>
        <svg class="map-legend-chevron" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="18 15 12 9 6 15"></polyline>
        </svg>
      </button>
    `;

    const btnClose = wadah.querySelector(".map-legend-btn");
    const btnPill = wadah.querySelector(".map-legend-pill");

    btnClose.addEventListener("click", () => {
      wadah.classList.add("is-minimized");
      btnPill.focus();
    });

    btnPill.addEventListener("click", () => {
      wadah.classList.remove("is-minimized");
      btnClose.focus();
    });

    return wadah;
  };
  return kontrol;
}
