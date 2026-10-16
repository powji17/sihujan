/**
 * config.js - semua parameter yang boleh disetel ada di sini (AC-10).
 * Mengubah nilai di file ini langsung mengubah hasil, tanpa menyentuh kode lain.
 * Satuan: mm, jam, meter.
 */

export const MODEL = {
  C: { baik: 0.5, sedang: 0.7, buruk: 0.9 },   // koefisien limpasan
  Q_DRAIN: { baik: 10, sedang: 5, buruk: 1 },  // kemampuan drainase membuang air (mm/jam)
  T_REF: 1.5,                                  // tinggi pasang yang melumpuhkan drainase (m)
  K: 7,                                        // faktor konsentrasi limpasan ke cekungan (PRD awal: 4)
  H_MAX: 3,                                    // batas atas muka air efektif (m)

  // Koreksi vertikal DEM (m), dikurangkan dari elevasi DEM saat dimuat.
  // Alasan: DEMNAS berupa permukaan (DSM, memuat bangunan dan vegetasi). Setelah dihaluskan,
  // median daratan Pontianak di DEM masih ~4,2 m, jauh di atas elevasi tanah sebenarnya (~0,1-1,5 m).
  DEM_OFFSET_M: 1.2,

  // Lantai elevasi (m, setelah offset). Sel DEM yang lebih rendah dianggap lubang artefak dan dinaikkan
  // ke nilai ini agar kedalaman maksimum tidak berlebihan. Tidak mengubah luas genangan (selalu tergenang bila H > 0).
  DEM_LANTAI_M: -0.5,
};

// Urut dari rendah ke tinggi. `min` = batas bawah persentase luas tergenang (%).
export const AMBANG_STATUS = [
  { id: "aman", label: "Aman", min: 0 },
  { id: "waspada", label: "Waspada", min: 5 },
  { id: "siaga", label: "Siaga", min: 20 },
  { id: "banjir", label: "Banjir", min: 40 },
];

export const PRESET = {
  ringan: { I: 3, D: 3, T: 0.1, drainase: "baik" },
  sedang: { I: 7, D: 4, T: 0.2, drainase: "sedang" },
  lebat: { I: 15, D: 6, T: 0.4, drainase: "sedang" },
  sangatLebat: { I: 30, D: 8, T: 0.6, drainase: "buruk" },
};

export const INPUT_DEFAULT = { I: 15, D: 6, T: 0.2, drainase: "sedang" };

export const DATA = {
  demPng: "data/dem/pontianak_dem.png",
  demJson: "data/dem/pontianak_dem.json",
  fasilitas: "data/vector/facilities.geojson",
  kecamatan: "data/vector/kecamatan.geojson",
  waterways: "data/vector/waterways.geojson",
  sensors: "data/vector/sensors.geojson",
};

// Tampilan genangan di peta
export const RENDER = {
  OPACITY: 0.75,             // opasitas awal overlay genangan (0-1)
  KEDALAMAN_MAKS_M: 2,       // kedalaman yang dipetakan ke warna tergelap
  // Palet dangkal -> dalam (RGB), diinterpolasi linear; sama dengan token --dalam-1..4 di tokens.css
  PALET: [[190, 227, 248], [92, 179, 230], [30, 111, 181], [10, 61, 117]], // #BEE3F8 > #5CB3E6 > #1E6FB5 > #0A3D75
};

// Sumber peta dasar. Urutan pertama = bawaan, kecuali BASEMAP_DEFAULT diisi id lain.
// Catatan: CARTO Positron butuh API key sejak 26 Agustus 2026 (tampil "API KEY REQUIRED"),
// jadi tidak dipakai lagi. Kalau satu sumber bermasalah, cukup ganti di sini.
export const BASEMAP_DEFAULT = "osm";
export const BASEMAP = [
  {
    id: "osm",
    nama: "OpenStreetMap",
    jenis: "raster",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  {
    id: "terang",
    nama: "Peta terang (OpenFreeMap)",
    jenis: "vektor", // butuh WebGL + MapLibre; otomatis disembunyikan bila tidak tersedia
    style: "https://tiles.openfreemap.org/styles/positron",
    attribution:
      '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  },
];

// Animasi timeline
export const ANIMASI = {
  DURASI_DETIK: 12,      // lama putar dari jam 0 sampai akhir hujan pada kecepatan 1x
  KECEPATAN: [1, 2, 4],  // pilihan kecepatan di menu
  JUMLAH_TAHAP: 5,       // jumlah penanda tahap (Gambar 1-5) di bawah slider waktu
};

// Jenis fasilitas umum: huruf pada ikon (agar tidak hanya mengandalkan warna) dan warna garis.
export const FASILITAS = {
  rumah_sakit: { label: "Rumah sakit", huruf: "H", warna: "#c62828" },
  puskesmas_klinik: { label: "Puskesmas/klinik", huruf: "+", warna: "#00796b" },
  sekolah: { label: "Sekolah", huruf: "S", warna: "#5e35b1" },
};
export const DAFTAR_FASILITAS_MAKS = 8; // jumlah fasilitas terdampak yang dirinci di panel

// Teks rekomendasi per status (maksimal 3 butir). Mudah diubah di sini.
export const REKOMENDASI = {
  aman: [
    "Kondisi terkendali. Tetap pantau prakiraan cuaca BMKG.",
    "Pastikan saluran di sekitar rumah tidak tersumbat.",
  ],
  waspada: [
    "Pantau cuaca dan tinggi muka air sungai secara berkala.",
    "Bersihkan saluran dan parit dari sampah.",
    "Siapkan perlengkapan darurat dan dokumen penting.",
  ],
  siaga: [
    "Siapkan pompa dan jalur evakuasi.",
    "Pindahkan barang berharga dan kendaraan ke tempat yang lebih tinggi.",
    "Koordinasikan kesiapan dengan RT/RW dan BPBD setempat.",
  ],
  banjir: [
    "Aktifkan posko dan evakuasi warga di area rendah.",
    "Prioritaskan fasilitas kesehatan yang terdampak.",
    "Hindari area tergenang dan matikan listrik pada bangunan yang terendam.",
  ],
};

// Layer peta: keadaan awal tiap layer (true = menyala saat halaman dibuka)
export const LAYER_AWAL = {
  genangan: true,
  kecamatan: true,
  parit: false,
  fasilitas: true,
  sensor: false,
};

// Gaya garis sungai/kanal/parit: biru tipis, makin kecil makin pucat
export const PARIT_GAYA = {
  river: { color: "#0B6FA4", weight: 2.4 },
  canal: { color: "#2F86BE", weight: 1.6 },
  stream: { color: "#5FA8D8", weight: 1.2 },
  drain: { color: "#7DB9E3", weight: 1 },
  ditch: { color: "#8FC3E8", weight: 0.9 },
};

// Jenis sensor ilustratif (FR-23): huruf pada ikon, warna isi
export const SENSOR = {
  stasiun_hujan: { label: "Stasiun hujan", huruf: "R", warna: "#0277BD" },
  stasiun_cuaca: { label: "Stasiun cuaca", huruf: "C", warna: "#6D4C41" },
  sensor_debit: { label: "Sensor debit sungai", huruf: "D", warna: "#1565C0" },
  stasiun_pasut: { label: "Stasiun pasang surut", huruf: "P", warna: "#00838F" },
  pusat_data: { label: "Pusat data BPBD", huruf: "B", warna: "#455A64" },
};
