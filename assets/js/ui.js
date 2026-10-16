/**
 * ui.js - perilaku tampilan: tab, bottom sheet (HP), tombol panel (tablet),
 * pemindahan kontrol animasi, dan penyesuaian ukuran peta.
 */
const $ = (id) => document.getElementById(id);
const klem = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function inisiasiUI(peta) {
  inisiasiTab();
  inisiasiLayout(peta);
}

/* ---------- Tab (pola ARIA tabs: panah kiri/kanan, Home, End) ---------- */
function inisiasiTab() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const aktifkan = (tab, fokus = false) => {
    for (const t of tabs) {
      const aktif = t === tab;
      t.setAttribute("aria-selected", String(aktif));
      t.tabIndex = aktif ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !aktif;
    }
    if (fokus) tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => aktifkan(t));
    t.addEventListener("keydown", (e) => {
      const ke = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (ke === undefined) return;
      e.preventDefault();
      aktifkan(tabs[(ke + tabs.length) % tabs.length], true);
    });
  });
}

/* ---------- Layout responsif ---------- */
function inisiasiLayout(peta) {
  const mobil = matchMedia("(max-width: 767px)");
  const tablet = matchMedia("(min-width: 768px) and (max-width: 1023px)");
  const sheet = buatSheet(mobil);

  // Tablet: sidebar bisa disembunyikan.
  const btn = $("btn-panel");
  btn.addEventListener("click", () => {
    const tutup = document.body.classList.toggle("panel-tutup");
    btn.setAttribute("aria-expanded", String(!tutup));
  });
  tablet.addEventListener("change", () => {
    document.body.classList.remove("panel-tutup");
    btn.setAttribute("aria-expanded", "true");
  });

  // Peta harus tahu bila wadahnya berubah ukuran (sidebar ditutup, sheet berubah, layar diputar).
  new ResizeObserver(() => peta.invalidateSize({ pan: false })).observe($("peta"));
}

/* ---------- Bottom sheet: tiga posisi (kecil, setengah, penuh) ---------- */
function buatSheet(mobil) {
  const panel = $("panel");
  const handle = $("sheet-handle");
  const kepala = document.querySelector(".panel-kepala");
  const slot = $("animasi-panel");
  const NAMA = ["kecil", "setengah", "penuh"];
  let idx = 0;
  let tinggiSekarang = 0;

  // Posisi kecil = pegangan + status + kontrol animasi, jadi ukurannya mengikuti isi.
  const tinggiKecil = () => Math.ceil(handle.offsetHeight + kepala.offsetHeight + $("animasi-panel").offsetHeight + 4);
  const tinggiPosisi = (i) => (i === 2 ? Math.round(innerHeight * 0.92) : i === 1 ? Math.round(innerHeight * 0.56) : tinggiKecil());

  const set = (px) => {
    tinggiSekarang = px;
    document.documentElement.style.setProperty("--tampil", `${px}px`);
  };
  const terapkan = () => {
    if (!mobil.matches) {
      document.documentElement.style.setProperty("--tampil", "0px");
      return;
    }
    set(tinggiPosisi(idx));
    handle.setAttribute("aria-label", `Ubah tinggi panel, sekarang ${NAMA[idx]}`);
  };
  const pindah = (i) => {
    idx = klem(i, 0, 2);
    terapkan();
  };

  // Seret pada pegangan atau kepala panel
  let pid = null;
  let mulaiY = 0;
  let mulaiH = 0;
  let digeser = false;
  let sudahGeser = false;
  let jejak = [];

  const akhir = (e) => {
    if (pid !== e.pointerId) return;
    pid = null;
    panel.classList.remove("menyeret");
    sudahGeser = digeser;
    if (!digeser) return;
    // Kecepatan lemparan jari menentukan arah; bila pelan, ambil posisi terdekat.
    const a = jejak[Math.max(0, jejak.length - 4)];
    const b = jejak[jejak.length - 1];
    const v = b.t > a.t ? (a.y - b.y) / (b.t - a.t) : 0; // px/ms, positif = ke atas
    if (Math.abs(v) > 0.5) {
      idx = klem(idx + (v > 0 ? 1 : -1), 0, 2);
    } else {
      const jarak = NAMA.map((_, i) => Math.abs(tinggiPosisi(i) - tinggiSekarang));
      idx = jarak.indexOf(Math.min(...jarak));
    }
    terapkan();
  };

  for (const el of [handle, kepala]) {
    el.addEventListener("pointerdown", (e) => {
      if (!mobil.matches) return;
      pid = e.pointerId;
      el.setPointerCapture(pid);
      mulaiY = e.clientY;
      mulaiH = tinggiSekarang;
      digeser = false;
      sudahGeser = false;
      jejak = [{ y: e.clientY, t: e.timeStamp }];
    });
    el.addEventListener("pointermove", (e) => {
      if (pid !== e.pointerId) return;
      const dy = mulaiY - e.clientY;
      if (!digeser && Math.abs(dy) > 6) {
        digeser = true;
        panel.classList.add("menyeret");
      }
      if (!digeser) return;
      set(klem(mulaiH + dy, tinggiPosisi(0), tinggiPosisi(2)));
      jejak.push({ y: e.clientY, t: e.timeStamp });
    });
    el.addEventListener("pointerup", akhir);
    el.addEventListener("pointercancel", akhir);
  }

  // Ketuk pegangan = ganti posisi; panah atas/bawah untuk pengguna keyboard
  handle.addEventListener("click", () => {
    if (sudahGeser) {
      sudahGeser = false;
      return;
    }
    pindah((idx + 1) % 3);
  });
  handle.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") (e.preventDefault(), pindah(idx + 1));
    if (e.key === "ArrowDown") (e.preventDefault(), pindah(idx - 1));
  });

  addEventListener("resize", terapkan);
  // Tinggi posisi kecil mengikuti isi: ukur ulang saat kepala atau kontrol animasi berubah tinggi
  // (mis. penanda tahap baru dibuat setelah data termuat).
  const ro = new ResizeObserver(() => {
    if (mobil.matches && idx === 0) terapkan();
  });
  ro.observe(kepala);
  ro.observe(slot);

  return { terapkan };
}
