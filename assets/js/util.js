/** util.js - pembantu kecil yang dipakai beberapa modul. */

/** Angka berformat Indonesia (koma desimal). */
export const fmt = (x, d = 0) =>
  x.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Escape HTML; wajib untuk teks dari luar (nama fasilitas dari OSM) sebelum masuk innerHTML. */
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
