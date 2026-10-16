/**
 * main.js - sambungkan input, simulasi, animasi timeline, dan peta.
 */
import {
  INPUT_DEFAULT, PRESET, BASEMAP, BASEMAP_DEFAULT, ANIMASI, FASILITAS, REKOMENDASI, DAFTAR_FASILITAS_MAKS,
  DATA, LAYER_AWAL, RENDER,
} from "./config.js";
import { muatDem } from "./dem.js";
import { mukaAirEfektif, hitungGenangan } from "./simulation.js";
import { LayerGenangan, ekstenDem } from "./renderer.js";
import { muatFasilitas, analisaFasilitas, urutkanKecamatan } from "./impact.js";
import {
  LayerFasilitas, LayerKecamatan, LayerParit, LayerSensor, buatLegenda, muatGeoJSON,
} from "./layers.js";
import { fmt, esc } from "./util.js";
import { inisiasiUI } from "./ui.js";

const $ = (id) => document.getElementById(id);
const IKON = { aman: "✔", waspada: "⚠", siaga: "⚠", banjir: "⛔" }; // status tidak hanya lewat warna

// ---------- Peta ----------
const peta = L.map("peta").setView([-0.03, 109.33], 12);

const webglAda = (() => {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
})();
const vektorSiap = webglAda && typeof L.maplibreGL === "function";

function buatBasemap(b) {
  if (b.jenis === "vektor") {
    return L.maplibreGL({ style: b.style, attributionControl: { customAttribution: b.attribution } });
  }
  return L.tileLayer(b.url, { maxZoom: b.maxZoom ?? 19, attribution: b.attribution });
}

const tersedia = BASEMAP.filter((b) => b.jenis !== "vektor" || vektorSiap);
const pilihan = Object.fromEntries(tersedia.map((b) => [b.id, buatBasemap(b)]));
const awal = tersedia.find((b) => b.id === BASEMAP_DEFAULT) ?? tersedia[0];
let basemapAktif = awal.id;
pilihan[awal.id].addTo(peta);

// Kontrol Basemap Kustom (Pill segmented switch yang profesional)
const KontrolBasemap = L.Control.extend({
  options: { position: "topright" },
  onAdd() {
    const wadah = L.DomUtil.create("div", "basemap-switch");
    L.DomEvent.disableClickPropagation(wadah);
    L.DomEvent.disableScrollPropagation(wadah);

    wadah.innerHTML = `
      <div class="basemap-group" role="radiogroup" aria-label="Pilihan basemap">
        ${tersedia
          .map(
            (b) => `
          <button type="button" class="basemap-btn ${b.id === basemapAktif ? "aktif" : ""}"
            data-id="${b.id}" role="radio" aria-checked="${b.id === basemapAktif}">
            <span class="basemap-icon">${b.id === "osm" ? "🗺️" : "⚪"}</span>
            <span class="basemap-teks">${b.id === "osm" ? "Standar" : "Terang"}</span>
          </button>
        `
          )
          .join("")}
      </div>
    `;

    wadah.querySelectorAll(".basemap-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (id === basemapAktif) return;

        peta.removeLayer(pilihan[basemapAktif]);
        pilihan[id].addTo(peta);
        basemapAktif = id;

        wadah.querySelectorAll(".basemap-btn").forEach((b) => {
          const aktif = b.dataset.id === id;
          b.classList.toggle("aktif", aktif);
          b.setAttribute("aria-checked", String(aktif));
        });
      });
    });

    return wadah;
  },
});
new KontrolBasemap().addTo(peta);

buatLegenda(peta).addTo(peta);
inisiasiUI(peta);

// ---------- State ----------
const state = { ...INPUT_DEFAULT, t: INPUT_DEFAULT.D };
const anim = { jalan: false, kecepatan: 1, terakhir: 0, raf: 0 };
let dem = null;
let layer = null;
let antre = false;
let hTerakhir = null; // muka air yang terakhir digambar; hindari gambar ulang bila tidak berubah
let dTahap = null;
let jumlahFrame = 0;
let fasilitas = [];
let layerFas = null;
let layerKec = null;
let layerParit = null;
let layerSensor = null;
const barisKec = new Map(); // id kecamatan -> elemen <tr>
let urutanKec = "";
let statusTerakhir = null;
let sigFas = null;
let statusSr = null;

const jepit = (x, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));

// ---------- Penanda tahap (Gambar 1-5): tersebar merata sepanjang durasi hujan ----------
function waktuTahap() {
  const n = ANIMASI.JUMLAH_TAHAP;
  return Array.from({ length: n }, (_, i) => (state.D * (i + 1)) / n);
}

function bangunTahap() {
  $("tahap").innerHTML = waktuTahap()
    .map(
      (t, i) =>
        `<button type="button" class="tahap-btn" data-t="${t.toFixed(4)}" style="--p:${(((i + 1) / ANIMASI.JUMLAH_TAHAP) * 100).toFixed(2)}%" ` +
        `aria-label="Gambar ${i + 1}, jam ke-${fmt(t, 1)}">` +
        `<span class="no">${i + 1}</span><span class="jam">${fmt(t, 1)} j</span></button>`
    )
    .join("");
  dTahap = state.D;
}

function tandaiTahap() {
  const eps = state.D / 400;
  $("tahap").querySelectorAll(".tahap-btn").forEach((b) => {
    const t = parseFloat(b.dataset.t);
    b.classList.toggle("lewat", state.t >= t - eps);
    if (Math.abs(state.t - t) <= eps) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  });
}

// ---------- Tampilan ----------
function tulisKontrol() {
  $("in-I").value = state.I;
  $("in-D").value = state.D;
  $("in-T").value = state.T;
  $("in-drain").value = state.drainase;
  $("in-t").max = state.D;
  $("in-t").value = state.t;
  $("o-I").textContent = fmt(state.I);
  $("o-D").textContent = fmt(state.D, 1);
  $("o-T").textContent = fmt(state.T, 2);
  $("o-t").textContent = fmt(state.t, 1);
  $("o-Dt").textContent = `${fmt(state.D, 1)} jam`;
  if (dTahap !== state.D) bangunTahap();
}

// ---------- Output dampak ----------
const STATUS_IKON = { aman: "✔", waspada: "⚠", siaga: "⚠", banjir: "⛔" };

function bangunTabelKecamatan() {
  const tbody = $("tabel-kec").querySelector("tbody");
  tbody.innerHTML = "";
  barisKec.clear();
  urutanKec = "";
  for (const k of dem.kecamatan) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<th scope="row">${esc(k.nama.replace("Pontianak ", ""))}</th><td class="k-luas"></td><td class="k-persen"></td><td><span class="mini k-status"></span></td>`;
    tbody.appendChild(tr);
    barisKec.set(k.id, tr);
  }
}

function tulisKecamatan(perKec) {
  const urut = urutkanKecamatan(perKec);
  for (const k of urut) {
    const tr = barisKec.get(k.id);
    tr.querySelector(".k-luas").textContent = fmt(k.luasHa);
    tr.querySelector(".k-persen").textContent = `${fmt(k.persen, 1)}%`;
    const st = tr.querySelector(".k-status");
    st.className = `mini k-status ${k.status.id}`;
    st.textContent = `${STATUS_IKON[k.status.id]} ${k.status.label}`;
  }
  const kunci = urut.map((k) => k.id).join();
  if (kunci !== urutanKec) {
    // susun ulang baris hanya bila urutan berubah
    const tbody = $("tabel-kec").querySelector("tbody");
    urut.forEach((k) => tbody.appendChild(barisKec.get(k.id)));
    urutanKec = kunci;
  }
}

function tulisRekomendasi(status) {
  if (status.id === statusTerakhir) return;
  statusTerakhir = status.id;
  $("rekomendasi").innerHTML = (REKOMENDASI[status.id] || []).slice(0, 3).map((t) => `<li>${esc(t)}</li>`).join("");
}

function tulisFasilitas(fa) {
  if (!fasilitas.length) return;
  const sig = fa.terdampak.map((f) => `${f.id}:${f.kedalaman.toFixed(2)}`).join("|");
  if (sig === sigFas) return;
  sigFas = sig;
  const n = fa.terdampak.length;
  $("fas-ringkas").textContent = n
    ? `${n} dari ${fasilitas.length} fasilitas terdampak: rumah sakit ${fa.perJenis.rumah_sakit}, puskesmas/klinik ${fa.perJenis.puskesmas_klinik}, sekolah ${fa.perJenis.sekolah}.`
    : `Tidak ada fasilitas yang terdampak (dari ${fasilitas.length} fasilitas).`;
  const tampil = fa.terdampak.slice(0, DAFTAR_FASILITAS_MAKS);
  $("fas-daftar").innerHTML =
    tampil
      .map((f) => {
        const j = FASILITAS[f.jenis];
        return (
          `<li><button type="button" class="fas-item" data-id="${f.id}">` +
          `<span class="fas-ikon j-${f.jenis}" style="--w:${j.warna}" aria-hidden="true">${j.huruf}</span>` +
          `<span class="fas-nama">${esc(f.nama)}<small>${j.label} &middot; ${esc(f.kecamatan)}</small></span>` +
          `<span class="fas-dalam">&asymp; ${fmt(f.kedalaman, 2)} m</span></button></li>`
        );
      })
      .join("") + (n > tampil.length ? `<li class="fas-sisa">+ ${n - tampil.length} fasilitas lainnya</li>` : "");
}

function hitung() {
  const H = mukaAirEfektif(state, state.t);
  const r = hitungGenangan(dem, H);
  if (H !== hTerakhir) {
    layer.perbarui(H);
    hTerakhir = H;
  }
  $("badge").className = `badge ${r.status.id}`;
  $("badge").textContent = `${IKON[r.status.id]} ${r.status.label}`;
  $("r-H").textContent = `${fmt(H, 2)} m`;
  $("r-luas").textContent = `${fmt(r.luasHa)} ha (${fmt(r.luasKm2, 1)} km²)`;
  $("r-persen").textContent = `${fmt(r.persenKota, 1)}%`;
  $("r-dalam").textContent = r.sel ? `${fmt(r.kedalamanRata, 2)} m` : "-";
  $("r-dalam-maks").textContent = r.sel ? `${fmt(r.kedalamanMaks, 2)} m` : "-";
  tulisKecamatan(r.perKec);
  if (layerKec) layerKec.perbarui(r.perKec);
  tulisRekomendasi(r.status);
  const fa = analisaFasilitas(fasilitas, H);
  if (layerFas) layerFas.perbarui(H, fa.terdampak);
  tulisFasilitas(fa);
  $("r-sel").textContent = r.sel; // untuk pengujian
  $("in-t").value = state.t;
  $("in-t").style.setProperty("--isi", `${state.D ? (state.t / state.D) * 100 : 0}%`);
  $("o-t").textContent = fmt(state.t, 1);
  $("r-ringkas").textContent = `Muka air ${fmt(H, 2)} m, ${fmt(r.persenKota, 1)}% kota tergenang.`;
  if (r.status.id !== statusSr) {
    // pembaca layar hanya diberi tahu saat status berganti, bukan di setiap frame animasi
    statusSr = r.status.id;
    $("status-sr").textContent = `Status ${r.status.label}: ${fmt(r.persenKota, 1)}% kota tergenang.`;
  }
  tandaiTahap();
  $("peta").dataset.frame = ++jumlahFrame; // penghitung frame, untuk pengujian
}

function jadwalkan() {
  if (antre) return;
  antre = true;
  requestAnimationFrame(() => {
    antre = false;
    hitung();
  });
}

// ---------- Animasi ----------
function aturTombolPlay() {
  const b = $("btn-play");
  b.innerHTML = anim.jalan ? "&#9208; Jeda" : "&#9654; Putar";
  b.setAttribute("aria-pressed", String(anim.jalan));
}

function hentikan() {
  if (anim.raf) cancelAnimationFrame(anim.raf);
  anim.raf = 0;
  anim.jalan = false;
  aturTombolPlay();
}

function putar() {
  if (!dem) return;
  if (state.t >= state.D - 1e-9) state.t = 0; // putar ulang dari awal bila sudah di akhir
  anim.jalan = true;
  anim.terakhir = performance.now();
  aturTombolPlay();
  anim.raf = requestAnimationFrame(langkah);
}

function langkah(now) {
  if (!anim.jalan) return;
  const dt = Math.min(0.25, (now - anim.terakhir) / 1000); // jepit agar tidak melompat setelah tab tertidur
  anim.terakhir = now;
  // Waktu simulasi mengikuti jam dinding, jadi frame yang lambat melewati langkah, bukan memperlambat animasi
  state.t = Math.min(state.D, state.t + dt * (state.D / ANIMASI.DURASI_DETIK) * anim.kecepatan);
  hitung();
  if (state.t >= state.D) {
    hentikan();
    return;
  }
  anim.raf = requestAnimationFrame(langkah);
}

// ---------- Kontrol ----------
// Mengubah input apa pun menghentikan animasi dan menampilkan keadaan akhir hujan;
// tekan "Jalankan simulasi" untuk memutar ulang dengan nilai baru.
for (const [id, kunci, lo, hi] of [
  ["in-I", "I", 0, 100],
  ["in-D", "D", 0.5, 24],
  ["in-T", "T", 0, 1.5],
]) {
  $(id).addEventListener("input", (e) => {
    hentikan();
    state[kunci] = jepit(parseFloat(e.target.value), lo, hi);
    state.t = state.D;
    tulisKontrol();
    jadwalkan();
  });
}
$("in-drain").addEventListener("change", (e) => {
  hentikan();
  state.drainase = e.target.value;
  state.t = state.D;
  tulisKontrol();
  jadwalkan();
});
$("in-t").addEventListener("input", (e) => {
  hentikan();
  state.t = jepit(parseFloat(e.target.value), 0, state.D);
  jadwalkan();
});
document.querySelectorAll("[data-preset]").forEach((tombol) =>
  tombol.addEventListener("click", () => {
    hentikan();
    Object.assign(state, PRESET[tombol.dataset.preset]);
    state.t = state.D;
    tulisKontrol();
    jadwalkan();
  })
);
$("btn-play").addEventListener("click", () => (anim.jalan ? hentikan() : putar()));
$("btn-awal").addEventListener("click", () => {
  hentikan();
  state.t = 0;
  hitung();
});
$("btn-akhir").addEventListener("click", () => {
  hentikan();
  state.t = state.D;
  hitung();
});
$("in-speed").addEventListener("change", (e) => {
  anim.kecepatan = Number(e.target.value) || 1;
});
$("tahap").addEventListener("click", (e) => {
  const b = e.target.closest(".tahap-btn");
  if (!b) return;
  hentikan();
  state.t = parseFloat(b.dataset.t);
  hitung();
});
$("btn-jalankan").addEventListener("click", () => {
  hentikan();
  state.t = 0;
  putar();
});
$("btn-reset").addEventListener("click", () => {
  hentikan();
  Object.assign(state, INPUT_DEFAULT);
  state.t = state.D;
  tulisKontrol();
  hitung();
});
$("fas-daftar").addEventListener("click", (e) => {
  const b = e.target.closest(".fas-item");
  if (b && layerFas) layerFas.fokus(Number(b.dataset.id));
});
$("coba-lagi").addEventListener("click", mulai);

// ---------- Panel layer ----------
const DAFTAR_LAYER = {
  genangan: () => layer,
  kecamatan: () => layerKec,
  parit: () => layerParit,
  fasilitas: () => layerFas,
  sensor: () => layerSensor,
};

for (const [kunci, cek] of Object.entries(LAYER_AWAL)) $(`lyr-${kunci}`).checked = cek;

function terapkanLayer() {
  for (const [kunci, ambil] of Object.entries(DAFTAR_LAYER)) {
    const cek = $(`lyr-${kunci}`);
    const l = ambil();
    cek.disabled = !l; // data layer gagal dimuat -> pilihan dinonaktifkan
    if (l) l.tampilkan(cek.checked);
  }
}

for (const kunci of Object.keys(DAFTAR_LAYER)) {
  $(`lyr-${kunci}`).addEventListener("change", (e) => {
    const l = DAFTAR_LAYER[kunci]();
    if (l) l.tampilkan(e.target.checked);
  });
}

const opasitasSekarang = () => Number($("lyr-opasitas").value) / 100;
$("lyr-opasitas").value = Math.round(RENDER.OPACITY * 100);
$("o-opasitas").textContent = `${$("lyr-opasitas").value}%`;
$("lyr-opasitas").addEventListener("input", () => {
  $("o-opasitas").textContent = `${$("lyr-opasitas").value}%`;
  if (layer) layer.setOpacity(opasitasSekarang());
});

// ---------- Muat data ----------
async function mulai() {
  $("galat").hidden = true;
  $("muat").hidden = false;
  try {
    dem = await muatDem();
  } catch (e) {
    console.error(e);
    $("muat").hidden = true;
    $("galat-teks").textContent = `Data elevasi gagal dimuat: ${e.message}`;
    $("galat").hidden = false;
    return;
  }
  const { north, west, south, east } = ekstenDem(dem);
  peta.fitBounds([[south, west], [north, east]]);
  if (layer) layer.hapus();
  layer = new LayerGenangan(dem, peta, { opacity: opasitasSekarang() });
  hTerakhir = null;
  bangunTabelKecamatan();

  // Fasilitas bersifat pelengkap: bila gagal dimuat, simulasi utama tetap jalan
  if (layerFas) layerFas.hapus();
  layerFas = null;
  fasilitas = [];
  sigFas = null;
  statusTerakhir = null;
  try {
    fasilitas = await muatFasilitas(dem);
    layerFas = new LayerFasilitas(fasilitas, peta);
  } catch (e) {
    console.warn("Data fasilitas tidak termuat:", e);
    $("fas-ringkas").textContent = "Data fasilitas tidak dapat dimuat.";
    $("fas-daftar").innerHTML = "";
  }
  // Layer vektor bersifat pelengkap: yang gagal dimuat dinonaktifkan, simulasi tetap jalan
  for (const l of [layerKec, layerParit, layerSensor]) if (l) l.hapus();
  const [rKec, rAir, rSen] = await Promise.allSettled([
    muatGeoJSON(DATA.kecamatan),
    muatGeoJSON(DATA.waterways),
    muatGeoJSON(DATA.sensors),
  ]);
  const buat = (hasil, Kelas, nama) => {
    if (hasil.status === "fulfilled") return new Kelas(hasil.value, peta);
    console.warn(`Layer ${nama} tidak termuat:`, hasil.reason);
    return null;
  };
  layerKec = buat(rKec, LayerKecamatan, "kecamatan");
  layerParit = buat(rAir, LayerParit, "parit");
  layerSensor = buat(rSen, LayerSensor, "sensor");
  terapkanLayer();

  $("muat").hidden = true;
  $("kontrol").disabled = false;
  $("layer-kontrol").disabled = false;
  // Kontrol animasi kini di dalam panel (bukan fieldset terpisah), tidak perlu di-enable.
  tulisKontrol();
  hitung();
}

mulai();
