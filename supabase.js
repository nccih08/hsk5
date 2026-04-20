// ══════════════════════════════════════════════
//  supabase.js — Auth & Sync
//  Fixes:
//  1. Key normalization: cloud pakai integer, local pakai string → sekarang
//     selalu normalize ke String saat pull & push
//  2. Merge dailyNewCounts antar device
//  3. Token refresh tetap robust
// ══════════════════════════════════════════════

const SB_URL = 'https://nvppvfrorzelqktyfjvr.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52cHB2ZnJvcnplbHFrdHlmanZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MzA0MjAsImV4cCI6MjA5MjEwNjQyMH0.NLn6jvDKZewY_SIsdtH5J4IgL50vBC7ZL5GsihI7whE';

let AUTH_TOKEN    = null;
let REFRESH_TOKEN = null;
let USER_ID       = null;
let TOKEN_EXPIRY  = 0;

let syncTimer   = null;
let pendingSync = false;
let isSyncing   = false;

// ── Header builder ──
function sbHeaders(extra = {}) {
  return {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${AUTH_TOKEN || SB_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

// ── Low-level fetch ──
async function sbFetch(path, opts = {}) {
  if (AUTH_TOKEN && Date.now() > TOKEN_EXPIRY - 120_000) {
    await tryRefreshToken();
  }
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...sbHeaders(), ...(opts.headers || {}) }
  });
  if (!res.ok) {
    if (res.status === 401 && REFRESH_TOKEN) {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        const retry = await fetch(`${SB_URL}/rest/v1/${path}`, {
          ...opts,
          headers: { ...sbHeaders(), ...(opts.headers || {}) }
        });
        if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
        if (retry.status === 204) return null;
        const retryText = await retry.text();
        return retryText ? JSON.parse(retryText) : null;
      }
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Token refresh ──
async function tryRefreshToken() {
  if (!REFRESH_TOKEN) return false;
  try {
    const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: REFRESH_TOKEN })
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.access_token) {
      AUTH_TOKEN    = data.access_token;
      REFRESH_TOKEN = data.refresh_token;
      TOKEN_EXPIRY  = Date.now() + (data.expires_in || 3600) * 1000;
      persistSession();
      return true;
    }
  } catch (e) { /* network error */ }
  return false;
}

// ── Session persistence ──
function persistSession() {
  localStorage.setItem('hsk5_uid',     USER_ID);
  localStorage.setItem('hsk5_token',   AUTH_TOKEN);
  localStorage.setItem('hsk5_refresh', REFRESH_TOKEN || '');
  localStorage.setItem('hsk5_expiry',  String(TOKEN_EXPIRY));
}

function clearSession() {
  AUTH_TOKEN = null; REFRESH_TOKEN = null; USER_ID = null; TOKEN_EXPIRY = 0;
  ['hsk5_uid','hsk5_token','hsk5_refresh','hsk5_expiry'].forEach(k => localStorage.removeItem(k));
}

// ── Auth ──
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t, i) =>
    t.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'register'))
  );
  document.getElementById('auth-login-form').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('auth-register-form').style.display = tab === 'register' ? '' : 'none';
}

function setAuthMsg(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className   = `auth-msg ${type}`;
}

async function handleLogin() {
  const email = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-pass').value;
  if (!email || !pass) return setAuthMsg('auth-msg', 'Isi email dan password', 'error');
  setAuthMsg('auth-msg', '⏳ Masuk...', 'info');
  try {
    const res  = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass })
    });
    const data = await res.json();
    if (data.access_token) {
      AUTH_TOKEN    = data.access_token;
      REFRESH_TOKEN = data.refresh_token || null;
      TOKEN_EXPIRY  = Date.now() + (data.expires_in || 3600) * 1000;
      USER_ID       = data.user.id;
      persistSession();
      setAuthMsg('auth-msg', '✓ Berhasil!', 'success');
      setTimeout(bootApp, 400);
    } else {
      setAuthMsg('auth-msg', data.error_description || 'Login gagal', 'error');
    }
  } catch (e) { setAuthMsg('auth-msg', 'Gagal terhubung ke server', 'error'); }
}

async function handleRegister() {
  const email = document.getElementById('reg-email').value.trim();
  const pass  = document.getElementById('reg-pass').value;
  if (!email || !pass) return setAuthMsg('reg-msg', 'Isi semua field', 'error');
  if (pass.length < 6) return setAuthMsg('reg-msg', 'Password min. 6 karakter', 'error');
  setAuthMsg('reg-msg', '⏳ Mendaftar...', 'info');
  try {
    const res  = await fetch(`${SB_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass })
    });
    const data = await res.json();
    if (data.id || data.user) {
      setAuthMsg('reg-msg', '✓ Akun dibuat! Silakan login.', 'success');
      setTimeout(() => switchAuthTab('login'), 1500);
    } else {
      setAuthMsg('reg-msg', data.error_description || data.msg || 'Gagal daftar', 'error');
    }
  } catch (e) { setAuthMsg('reg-msg', 'Gagal terhubung ke server', 'error'); }
}

async function handleLogout() {
  clearTimeout(syncTimer);
  const lbl = document.getElementById('sync-label');
  if (lbl) lbl.textContent = 'Menyimpan sebelum keluar...';
  
  // Tunggu jika ada proses upload yang sedang berjalan
  while(isSyncing) {
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Tembakan final untuk memastikan tabungan terakhir ikut terbawa (mengabaikan cooldown)
  await pushToCloud(true);

  clearSession();
  srsData = {}; userStats = { ...DEFAULT_STATS };
  showPage('auth');
}

// ── Sync status UI ──
function setSyncStatus(s, errMsg = '') {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-label');
  if (!dot) return;
  dot.className  = `sync-dot ${s === 'syncing' ? 'syncing' : s === 'error' ? 'error' : ''}`;
  lbl.textContent = { syncing: '同步中…', ok: '已同步', offline: '离线', error: '同步错误' }[s] || '已同步';
  if(errMsg) {
     lbl.textContent += ' : ' + errMsg;
  }
}

// ── Push to cloud ──
async function pushToCloud(force = false) {
  if (!USER_ID || isSyncing) return;
  isSyncing = true;
  pendingSync = false; // Reset tanda pending. Kalau ada klik masuk saat upload, ini akan jadi true lagi

  setSyncStatus('syncing');
  try {
    // Hanya push data yang pernah diklik/termodifikasi! (Sangat mempercepat sync dari 21 batches jadi 1)
    const rows = Object.entries(srsData)
      .filter(([wid, d]) => d.state !== 'new' || (d.reviews && d.reviews > 0))
      .map(([wid, d]) => ({
        user_id:    USER_ID,
        word_id:    parseInt(wid, 10),
        data:       d,
        updated_at: new Date().toISOString()
      }));

    // Batch upsert 100 baris sekaligus
    for (let i = 0; i < rows.length; i += 100) {
      await sbFetch('srs_data?on_conflict=user_id,word_id', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(rows.slice(i, i + 100))
      });
    }

    // Upsert stats (pastikan dailyNewCounts dan notes juga tersimpan)
    await sbFetch('user_stats?on_conflict=user_id', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify([{
        user_id:    USER_ID,
        stats:      userStats,
        updated_at: new Date().toISOString()
      }])
    });

    setSyncStatus('ok');
  } catch (e) {
    console.error('pushToCloud failed:', e);
    setSyncStatus('error', e.message);
  } finally {
    isSyncing = false;
    // Jika selama sedang mengunggah, user menekan kartu baru, maka tembak sync lagi!
    if (pendingSync && !force) {
      scheduleSync();
    }
  }
}

// ── Pull from cloud ──
// BUG FIX UTAMA: cloud mengembalikan word_id sebagai integer,
// tapi srsData menggunakan string key. Harus String(r.word_id).
async function pullFromCloud() {
  if (!USER_ID) return;
  setSyncStatus('syncing');
  try {
    const [srsRows, statsRows] = await Promise.all([
      sbFetch(`srs_data?user_id=eq.${USER_ID}&select=word_id,data`),
      sbFetch(`user_stats?user_id=eq.${USER_ID}&select=stats`)
    ]);

    // ── Merge SRS data ──
    if (Array.isArray(srsRows) && srsRows.length > 0) {
      srsRows.forEach(r => {
        const key      = String(r.word_id);   // ← FIX: pastikan string
        const existing = srsData[key];
        const incoming = r.data;

        if (!incoming) return;

        if (!existing || existing.state === 'new') {
          // Belum ada lokal, atau masih 'new' → pakai cloud
          srsData[key] = incoming;
        } else {
          // Keduanya sudah punya data → ambil yang lebih banyak reviews
          const existRev = existing.reviews || 0;
          const incomRev = incoming.reviews || 0;
          if (incomRev > existRev) {
            srsData[key] = incoming;
          } else if (incomRev === existRev) {
            // Sama banyak reviews → ambil yang dueDate-nya paling dekat (lebih agresif)
            const existDue = existing.dueDate || Infinity;
            const incomDue = incoming.dueDate || Infinity;
            if (incomDue < existDue) srsData[key] = incoming;
          }
        }
      });
    }

    // ── Merge stats ──
    if (Array.isArray(statsRows) && statsRows.length > 0) {
      const cloud = statsRows[0].stats || {};

      userStats.totalReviews = Math.max(userStats.totalReviews || 0, cloud.totalReviews || 0);
      userStats.correct      = Math.max(userStats.correct      || 0, cloud.correct      || 0);
      userStats.streak       = Math.max(userStats.streak       || 0, cloud.streak       || 0);

      // Merge dailyCounts (ambil max per hari)
      const cloudCounts = cloud.dailyCounts  || {};
      const localCounts = userStats.dailyCounts || {};
      const mergedCounts = { ...cloudCounts };
      Object.entries(localCounts).forEach(([day, n]) => {
        mergedCounts[day] = Math.max(mergedCounts[day] || 0, n);
      });
      userStats.dailyCounts = mergedCounts;

      // Merge dailyNewCounts (ambil max per hari)
      const cloudNew = cloud.dailyNewCounts  || {};
      const localNew = userStats.dailyNewCounts || {};
      const mergedNew = { ...cloudNew };
      Object.entries(localNew).forEach(([day, n]) => {
        mergedNew[day] = Math.max(mergedNew[day] || 0, n);
      });
      userStats.dailyNewCounts = mergedNew;

      if (!userStats.lastStudyDate && cloud.lastStudyDate) {
        userStats.lastStudyDate = cloud.lastStudyDate;
      }
      
      // ✅ RESTORE NOTES DARI CLOUD! (Bug Fix)
      if (cloud.notes) {
        userStats.notes = cloud.notes;
      }

      // ✅ RESTORE DAILY CAPACITY DARI CLOUD! (Bug Fix)
      if (cloud.dailyCapacity) {
        userStats.dailyCapacity = cloud.dailyCapacity;
      }
    }

    setSyncStatus('ok');
  } catch (e) {
    console.error('pullFromCloud failed:', e);
    setSyncStatus('error', e.message);
  }
}

// ── Schedule debounced sync (3 detik setelah aksi terakhir) ──
function scheduleSync() {
  pendingSync = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushToCloud, 3000);
}

// ── On boot: restore session from localStorage ──
async function tryRestoreSession() {
  const uid = localStorage.getItem('hsk5_uid');
  const tok = localStorage.getItem('hsk5_token');
  const ref = localStorage.getItem('hsk5_refresh');
  const exp = parseInt(localStorage.getItem('hsk5_expiry') || '0', 10);
  if (!uid || !tok) return false;

  USER_ID       = uid;
  AUTH_TOKEN    = tok;
  REFRESH_TOKEN = ref || null;
  TOKEN_EXPIRY  = exp || 0;

  if (Date.now() > TOKEN_EXPIRY) {
    const ok = await tryRefreshToken();
    if (!ok) { clearSession(); return false; }
  }
  return true;
}
