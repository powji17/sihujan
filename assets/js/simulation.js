/**
 * simulation.js - rumus PRD bagian 5. Tanpa dependensi DOM, aman diuji di Node.
 */
import { MODEL, AMBANG_STATUS } from "./config.js";

/**
 * Muka air efektif H(t) dalam meter di atas MSL.
 * @param {{I:number, D:number, T:number, drainase:'baik'|'sedang'|'buruk'}} input
 * @param {number} t jam sejak hujan mulai (dijepit ke 0..D)
 */
export function mukaAirEfektif(input, t = input.D, model = MODEL) {
  const { I, D, T, drainase } = input;
  const qEff = model.Q_DRAIN[drainase] * Math.max(0, 1 - T / model.T_REF); // efek backwater
  const rNet = Math.max(0, model.C[drainase] * I - qEff);                 // mm/jam
  const waktu = Math.min(Math.max(t, 0), D);
  const H = T + (model.K * rNet * waktu) / 1000;
  return Math.min(H, model.H_MAX);
}

/** Status berdasarkan persentase luas tergenang. */
export function statusDariPersen(persen, ambang = AMBANG_STATUS) {
  let hasil = ambang[0];
  for (const a of ambang) if (persen >= a.min) hasil = a;
  return hasil;
}

/**
 * Hitung genangan untuk muka air H dalam satu putaran atas seluruh sel.
 * Sel tergenang bila z <= H; kedalaman = H - z. Jika H <= 0, tidak ada genangan.
 * @param dem hasil dekodeRGBA()/muatDem()
 */
export function hitungGenangan(dem, H) {
  const { z, ids, cellAreaM2, selPerKec, kecamatan, selKota } = dem;
  const selKec = new Uint32Array(selPerKec.length);
  let total = 0;
  let jumlahDalam = 0;
  let dalamMaks = 0;

  if (H > 0) {
    for (let i = 0; i < z.length; i++) {
      const id = ids[i];
      if (id === 0) continue;
      const d = H - z[i];
      if (d >= 0) {
        selKec[id]++;
        total++;
        jumlahDalam += d;
        if (d > dalamMaks) dalamMaks = d;
      }
    }
  }

  const haPerSel = cellAreaM2 / 10000;
  const persenKota = selKota ? (total / selKota) * 100 : 0;
  return {
    H,
    sel: total,
    luasHa: total * haPerSel,
    luasKm2: (total * haPerSel) / 100,
    persenKota,
    kedalamanRata: total ? jumlahDalam / total : 0,
    kedalamanMaks: dalamMaks,
    status: statusDariPersen(persenKota),
    perKec: kecamatan.map((k) => ({
      id: k.id,
      nama: k.nama,
      sel: selKec[k.id],
      luasHa: selKec[k.id] * haPerSel,
      persen: selPerKec[k.id] ? (selKec[k.id] / selPerKec[k.id]) * 100 : 0,
    })),
  };
}
