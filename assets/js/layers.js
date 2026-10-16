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

/** Legenda kedalaman di pojok kiri bawah peta, warnanya diambil dari palet render. */
export function buatLegenda(peta) {
  const kontrol = L.control({ position: "bottomleft" });
  kontrol.onAdd = () => {
    const maks = RENDER.KEDALAMAN_MAKS_M;
    const warna = RENDER.PALET.map((c) => `rgb(${c.join(",")})`).join(", ");
    const tanda = [0, 0.25, 0.5, 0.75, 1].map((f, i, a) => (i === a.length - 1 ? `≥ ${fmt(maks, 1)} m` : fmt(maks * f, 1)));
    const div = L.DomUtil.create("div", "legenda");
    div.setAttribute("role", "img");
    div.setAttribute("aria-label", `Legenda kedalaman genangan, dari 0 sampai ${fmt(maks, 1)} meter atau lebih`);
    div.innerHTML =
      `<strong>Kedalaman genangan</strong>` +
      `<div class="legenda-bar" style="background:linear-gradient(to right, ${warna})"></div>` +
      `<div class="legenda-skala">${tanda.map((t) => `<span>${t}</span>`).join("")}</div>`;
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  return kontrol;
}
