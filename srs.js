// ══════════════════════════════════════════════
//  srs.js — Spaced Repetition Engine
//  Fixes:
//  1. Daily new-card quota (min 10/hari, configurable)
//  2. 'Again' cards re-queued in same session
//  3. Consistent string keys for srsData
// ══════════════════════════════════════════════

const DAILY_NEW_LIMIT = 10; // Minimal kartu baru per hari

const DEFAULT_STATS = {
  streak: 0,
  totalReviews: 0,
  correct: 0,
  lastStudyDate: null,
  dailyCounts: {},
  dailyNewCounts: {}   // ← track berapa new cards per hari
};

let srsData = {};
let userStats = { ...DEFAULT_STATS };

// ── Initialise SRS entries ──
// NEW CARDS start with state:'new' and NO dueDate set.
function initSRSData() {
  VOCAB.forEach(w => {
    const key = String(w.id);
    if (!srsData[key]) {
      srsData[key] = {
        interval: 0,
        ease: 2.5,
        dueDate: null,   // null = belum pernah dipelajari
        reviews: 0,
        errors: 0,
        state: 'new'
      };
    }
  });
}

// ── Helpers ──
function todayKey() {
  return new Date().toDateString();
}

// ── Due cards (sudah pernah dipelajari & jadwalnya sudah tiba) ──
function getDueCards() {
  const now = Date.now();
  return VOCAB.filter(w => {
    const d = srsData[String(w.id)];
    return d && d.dueDate !== null && d.dueDate <= now;
  });
}

// ── New (belum pernah dipelajari) cards ──
function getNewCards() {
  return VOCAB.filter(w => {
    const d = srsData[String(w.id)];
    return d && d.state === 'new' && d.reviews === 0;
  });
}

// ── Schedule a card after rating ──
function scheduleCard(wordId, rating) {
  const key  = String(wordId);
  const card = srsData[key];
  if (!card) return;

  const DAY = 86400000;
  const newIntervals = { again: 0.007, hard: 1, good: 3, easy: 7 };
  const easeMult     = { again: 0.85,  hard: 0.95, good: 1.0, easy: 1.15 };

  if (rating === 'again') {
    card.interval = newIntervals.again;
    card.ease     = Math.max(1.3, card.ease * easeMult.again);
    card.errors   = (card.errors || 0) + 1;
    card.state    = 'learning';
  } else {
    card.errors = 0; // RECOVER dari weak cards jika dijawab benar
    const baseInterval = card.reviews === 0 ? newIntervals[rating] : (card.interval || 0.5);
    const newInterval  = Math.max(newIntervals[rating], baseInterval * card.ease * easeMult[rating]);
    card.interval = newInterval;
    card.ease     = Math.min(3.0, card.ease * (rating === 'easy' ? 1.05 : 1.0));
    card.state    = card.interval > 21 ? 'mastered' : card.interval > 3 ? 'review' : 'learning';
  }

  card.dueDate = Date.now() + card.interval * DAY;
  card.reviews = (card.reviews || 0) + 1;

  // Update stats
  userStats.totalReviews = (userStats.totalReviews || 0) + 1;
  if (rating === 'good' || rating === 'easy') userStats.correct = (userStats.correct || 0) + 1;

  const today = todayKey();
  
  if (!userStats.dailyCapacity) userStats.dailyCapacity = { date: today, count: 0 };
  if (userStats.dailyCapacity.date !== today) {
    userStats.dailyCapacity = { date: today, count: 0 };
  }
  
  if (rating !== 'again') {
    userStats.dailyCapacity.count++;
  }
  userStats.dailyCounts = userStats.dailyCounts || {};
  userStats.dailyCounts[today] = (userStats.dailyCounts[today] || 0) + 1;

  if (userStats.lastStudyDate !== today) {
    const yest = new Date(Date.now() - 86400000).toDateString();
    userStats.streak = userStats.lastStudyDate === yest ? (userStats.streak || 0) + 1 : 1;
    userStats.lastStudyDate = today;
  }

  scheduleSync();
}

// ── Stats banner ──
function updateHomeStats() {
  const today = todayKey();
  if (!userStats.dailyCapacity) userStats.dailyCapacity = { date: today, count: 0 };
  if (userStats.dailyCapacity.date !== today) {
    userStats.dailyCapacity = { date: today, count: 0 };
  }
  
  const dailyRemaining = Math.max(0, 20 - userStats.dailyCapacity.count);

  const due     = getDueCards();
  const dueIds  = new Set(due.map(w => w.id));
  const weak    = VOCAB.filter(w => (srsData[String(w.id)]?.errors || 0) >= 2 && !dueIds.has(w.id));
  const weakIds = new Set(weak.map(w => w.id));
  const unseen  = getNewCards().filter(w => !dueIds.has(w.id) && !weakIds.has(w.id));
  
  const queueSize = Math.min(dailyRemaining, due.length + weak.length + unseen.length);

  const acc     = userStats.totalReviews > 0
    ? Math.round(userStats.correct / userStats.totalReviews * 100) + '%'
    : '-';

  document.getElementById('stat-due').textContent     = queueSize;
  
  const elLearned = document.getElementById('stat-learned');
  if (elLearned) {
     const learned = VOCAB.filter(w => srsData[String(w.id)] && srsData[String(w.id)].state !== 'new').length;
     elLearned.textContent = learned;
  }
  
  document.getElementById('stat-streak').textContent  = userStats.streak || 0;
  document.getElementById('stat-acc').textContent     = acc;
  document.getElementById('due-count').textContent    = queueSize;
}
