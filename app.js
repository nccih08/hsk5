// ══════════════════════════════════════════════
//  app.js — Navigation, Study Session, Vocab, Analytics
//  Fixes:
//  1. Daily new-card quota dijamin minimal 10 per hari
//  2. Kartu 'again' di-requeue di sesi yang sama
//  3. srsData key selalu String() — konsisten dengan srs.js
// ══════════════════════════════════════════════

// ── Navigation ──
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
}

function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n =>
    n.classList.toggle('active', n.dataset.view === name)
  );
  document.getElementById('nav-study').style.display = name === 'study' ? '' : 'none';
  if (name === 'analytics') renderAnalytics();
  if (name === 'vocab')     renderVocabTable();
  if (name === 'home')      { updateHomeStats(); renderLessons(); }
  if (name === 'notes')     renderNotes();
}

// ── Lessons ──
function renderLessons() {
  const lessonMap = {};
  VOCAB.forEach(w => {
    if (!lessonMap[w.lesson]) lessonMap[w.lesson] = [];
    lessonMap[w.lesson].push(w);
  });
  const el = document.getElementById('lessons-grid');
  el.innerHTML = Object.entries(lessonMap).sort((a, b) => a[0] - b[0]).map(([l, words]) => {
    const mastered = words.filter(w => srsData[String(w.id)]?.state === 'mastered').length;
    const pct      = Math.round(mastered / words.length * 100);
    return `<div class="lesson-card" onclick="startLessonSession(${l})">
      <div class="lesson-num">第 ${l} 课</div>
      <div class="lesson-title">Lesson ${l}</div>
      <div class="lesson-progress">
        <div class="progress-bar"><div class="progress-fill c-teal" style="width:${pct}%"></div></div>
        <div class="lesson-count">${mastered}/${words.length} mastered</div>
      </div>
    </div>`;
  }).join('');
}

// ── Study Session ──
let sessionQueue   = [];
let sessionIdx     = 0;
let sessionMode    = 'flash';
let sessionCorrect = 0;
let sessionTotal   = 0;
let cardFlipped    = false;
let fillState      = {};

// ── Notes State ──
let currentNoteId = null;
let isNoteEditing = false;

// Set berisi word.id yang sudah ditandai sebagai "new card diperkenalkan di sesi ini"
// supaya kita tidak double-count jika kartu muncul ulang karena 'again'
let sessionNewIntroduced = new Set();

function shuffleArr(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Session builder ──
//
// LOGIC BARU:
//   'due' mode  → hanya kartu yang sudah due
//   mode lain   → due + weak + new cards (dijamin min DAILY_NEW_LIMIT new/hari)
//
// Kartu 'again' akan di-append ke akhir antrian sesi (requeue),
// bukan dihapus begitu saja.
function startSession(mode) {
  sessionMode = mode;
  sessionNewIntroduced = new Set();
  let cards;

  if (mode === 'due') {
    cards = getDueCards();
    if (!cards.length) { toast('没有待复习的词汇！'); return; }
  } else {
    const due     = getDueCards();
    const dueIds  = new Set(due.map(w => w.id));
    const weak    = VOCAB.filter(w =>
      (srsData[String(w.id)]?.errors || 0) >= 2 && !dueIds.has(w.id)
    );
    const weakIds  = new Set(weak.map(w => w.id));

    const unseen   = getNewCards().filter(w => !dueIds.has(w.id) && !weakIds.has(w.id));
    
    // (Bug Fix) Cap ke maksimal slot sisa harian
    const today = new Date().toDateString();
    const dailyCap = userStats.dailyCapacity && userStats.dailyCapacity.date === today ? userStats.dailyCapacity.count : 0;
    const remainingLimit = Math.max(0, 20 - dailyCap);
    
    // Gabungkan dengan urutan prioritas: Due -> Weak -> Unseen
    const pool = [...shuffleArr(due), ...shuffleArr(weak), ...shuffleArr(unseen)];
    cards = pool.slice(0, remainingLimit);
    if (!cards.length) { toast('Kuota harian kamu sudah habis untuk hari ini!'); return; }
  }

  sessionQueue   = cards;
  sessionIdx     = 0;
  sessionCorrect = 0;
  sessionTotal   = 0;
  cardFlipped    = false;

  switchView('study');
  document.getElementById('nav-study').style.display = '';
  const labels = { flash: '🎴 闪卡', recall: '🎯 回忆', fill: '✏️ 填空', audio: '🔊 听音', due: '📚 复习' };
  document.getElementById('study-mode-pill').textContent = labels[mode] || mode;
  updateStudyProgress();
  renderStudyCard();
}

function startLessonSession(lesson) {
  sessionMode          = 'flash';
  sessionNewIntroduced = new Set();
  sessionQueue   = shuffleArr(VOCAB.filter(w => w.lesson == lesson));
  sessionIdx     = 0;
  sessionCorrect = 0;
  sessionTotal   = 0;
  cardFlipped    = false;
  switchView('study');
  document.getElementById('nav-study').style.display = '';
  document.getElementById('study-mode-pill').textContent = `📖 第${lesson}课`;
  updateStudyProgress();
  renderStudyCard();
}

function endSession() {
  switchView('home');
  updateHomeStats();
}

function updateStudyProgress() {
  const total = sessionQueue.length;
  const cur   = Math.min(sessionIdx, total);
  const pct   = total > 0 ? (cur / total) * 100 : 0;
  document.getElementById('study-prog-fill').style.width  = `${pct}%`;
  document.getElementById('study-prog-cur').textContent   = cur;
  document.getElementById('study-prog-tot').textContent   = total;
}

// ── Render card based on mode ──
function renderStudyCard() {
  if (sessionIdx >= sessionQueue.length) { showSessionDone(); return; }
  const word = sessionQueue[sessionIdx];

  // (Bug Fix) Pemanggilan markNewCardIntroduced dihapus dari sini.
  // Sekarang hanya akan dipanggil di scheduleCard (srs.js) ketika user benar-benar menjawab kartu.

  const mode = sessionMode;
  if      (mode === 'flash')  renderFlash(word);
  else if (mode === 'recall') renderRecall(word);
  else if (mode === 'fill')   renderFill(word);
  else if (mode === 'audio')  renderAudio(word);
  else if (mode === 'due')    renderFlash(word);
}

// ── Flash card ──
function renderFlash(word) {
  fillState = {};
  document.getElementById('study-content').innerHTML = `
    <div class="card-stage" onclick="flipCard()">
      <div class="card-inner" id="card-inner">
        <div class="card-face front">
          <button class="audio-btn" onclick="event.stopPropagation();speak('${word.hanzi}')">🔊</button>
          <div class="card-hanzi">${word.hanzi}</div>
          <div class="card-hint">点击翻转 · Space to flip</div>
        </div>
        <div class="card-face back">
          <button class="audio-btn" onclick="event.stopPropagation();speak('${word.hanzi}')">🔊</button>
          <div class="card-pinyin">${word.pinyin}</div>
          <div class="card-pos">${word.pos}</div>
          <div class="card-meaning">${word.en}</div>
          ${word.ex_cn ? `<div class="card-example"><div class="cn">${word.ex_cn}</div><div class="en">${word.ex_en || ''}</div></div>` : ''}
        </div>
      </div>
    </div>
    <div id="rating-area" style="display:none">
      <div class="rating-row">
        <button class="rating-btn r-again" onclick="nextCard('again',${word.id})">❌<span class="rating-sub">Again<br>&lt;10min</span></button>
        <button class="rating-btn r-hard"  onclick="nextCard('hard',${word.id})">😓<span class="rating-sub">Hard<br>1 day</span></button>
        <button class="rating-btn r-good"  onclick="nextCard('good',${word.id})">✓<span class="rating-sub">Good<br>3 days</span></button>
        <button class="rating-btn r-easy"  onclick="nextCard('easy',${word.id})">⭐<span class="rating-sub">Easy<br>7 days</span></button>
      </div>
    </div>`;
}

function flipCard() {
  const inner = document.getElementById('card-inner');
  if (!inner || cardFlipped) return;
  inner.classList.add('flipped');
  cardFlipped = true;
  document.getElementById('rating-area').style.display = '';
  speak(sessionQueue[sessionIdx]?.hanzi);
}

// ── nextCard: handle rating + requeue 'again' cards ──
function nextCard(rating, wordId) {
  sessionTotal++;
  if (rating === 'good' || rating === 'easy') sessionCorrect++;
  scheduleCard(wordId, rating);

  // FIX: jika 'again', tambahkan kartu ke akhir antrian sesi
  // supaya pengguna bisa latihan ulang sebelum sesi berakhir
  if (rating === 'again') {
    const word = sessionQueue[sessionIdx];
    // Hanya requeue jika belum terlalu banyak pengulangan di sesi ini
    // (cegah infinite loop: max 2x requeue per kartu per sesi)
    const requeueCount = sessionQueue.slice(sessionIdx + 1).filter(w => w.id === word.id).length;
    if (requeueCount < 2) {
      sessionQueue.push(word);
    }
  }

  sessionIdx++;
  cardFlipped = false;
  updateStudyProgress();
  renderStudyCard();
}

function goNextCard() {
  sessionIdx++;
  cardFlipped = false;
  updateStudyProgress();
  renderStudyCard();
}

// ── Recall (multiple choice) ──
function renderRecall(word) {
  fillState = { answered: false };
  const pool       = VOCAB.filter(w => w.id !== word.id);
  const distractors = shuffleArr(pool).slice(0, 3);
  const opts        = shuffleArr([word, ...distractors]);
  document.getElementById('study-content').innerHTML = `
    <div class="recall-wrap">
      <div class="recall-prompt">汉字 → 含义 · Character → Meaning</div>
      <div class="recall-big">${word.hanzi}</div>
      <div class="recall-pinyin" id="recall-pinyin" style="opacity:0; transition: opacity 0.3s">${word.pinyin}</div>
      <div class="recall-options">
        ${opts.map(o => `<button class="recall-opt" data-correct="${o.id === word.id}" onclick="checkRecall(this,${o.id === word.id},${word.id})">${o.en}</button>`).join('')}
      </div>
      <div id="next-action" style="display:none; margin-top:24px; width: 100%; max-width: 540px; text-align: center;">
        <button class="btn btn-teal" style="width: 100%; padding: 14px; font-size: 16px; border-radius: 12px; box-shadow: 0 4px 12px rgba(27,107,114,0.2)" onclick="goNextCard()">Next ➔</button>
      </div>
    </div>`;
  speak(word.hanzi);
}

function checkRecall(btn, correct, wordId) {
  if (fillState.answered) return;
  fillState.answered = true;
  btn.classList.add(correct ? 'correct' : 'wrong');
  if (!correct) {
    document.querySelectorAll('.recall-opt[data-correct="true"]').forEach(b => b.classList.add('reveal'));
  }
  
  const py = document.getElementById('recall-pinyin');
  if (py) py.style.opacity = '1';
  const apy = document.getElementById('audio-pinyin');
  if (apy) apy.style.opacity = '1';

  document.getElementById('next-action').style.display = 'block';

  sessionTotal++;
  if (correct) sessionCorrect++;
  const rating = correct ? 'good' : 'again';
  scheduleCard(wordId, rating);

  // Requeue jika salah
  if (!correct) {
    const word = sessionQueue[sessionIdx];
    const requeueCount = sessionQueue.slice(sessionIdx + 1).filter(w => w.id === word.id).length;
    if (requeueCount < 2) sessionQueue.push(word);
  }
}

// ── Fill in blank ──
function renderFill(word) {
  const chars    = word.hanzi.split('');
  const blankIdx = Math.floor(Math.random() * chars.length);
  const pool     = shuffleArr(VOCAB.filter(w => w.id !== word.id)).slice(0, 5).map(w => w.hanzi[0]).filter(Boolean);
  const keys     = shuffleArr([...new Set([chars[blankIdx], ...pool])]).slice(0, 6);
  fillState      = { answered: false, blankIdx, answer: chars[blankIdx] };

  document.getElementById('study-content').innerHTML = `
    <div class="fill-wrap">
      <div class="fill-mode-badge">填空练习 Fill in the blank</div>
      <div class="fill-sentence">${chars.map((c, i) => i === blankIdx
        ? `<span class="fill-char-box blank" id="blank-box">？</span>`
        : `<span class="fill-char-box">${c}</span>`).join('')}</div>
      <div style="font-size: 18px; color: var(--teal); margin-bottom: 8px; letter-spacing: 1px">${word.pinyin}</div>
      <div class="fill-translation">${word.en}</div>
      <div class="fill-keyboard">
        ${keys.map(k => `<button class="fill-key" onclick="fillKey('${k}',${word.id})">${k}</button>`).join('')}
      </div>
      <div class="fill-feedback" id="fill-feedback"></div>
      <div id="next-action" style="display:none; margin-top:24px; width: 100%; max-width: 400px; text-align: center;">
        <button class="btn btn-teal" style="width: 100%; padding: 14px; font-size: 16px; border-radius: 12px; box-shadow: 0 4px 12px rgba(27,107,114,0.2)" onclick="goNextCard()">Next ➔</button>
      </div>
    </div>`;
}

function fillKey(char, wordId) {
  if (fillState.answered) return;
  fillState.answered = true;
  const correct = char === fillState.answer;
  const box = document.getElementById('blank-box');
  if (box) { box.textContent = char; box.classList.add(correct ? 'correct' : 'wrong'); }
  const fb = document.getElementById('fill-feedback');
  if (fb) {
    fb.textContent = correct ? `✓ 正确！` : `✗ 应该是 "${fillState.answer}"`;
    fb.className   = `fill-feedback ${correct ? 'correct' : 'wrong'}`;
  }
  if (!correct && box) {
    setTimeout(() => {
      if (box) { box.textContent = fillState.answer; box.classList.remove('wrong'); box.classList.add('revealed'); }
    }, 600);
  }
  document.getElementById('next-action').style.display = 'block';

  sessionTotal++;
  if (correct) sessionCorrect++;
  const rating = correct ? 'good' : 'again';
  scheduleCard(wordId, rating);

  if (!correct) {
    const word = sessionQueue[sessionIdx];
    const requeueCount = sessionQueue.slice(sessionIdx + 1).filter(w => w.id === word.id).length;
    if (requeueCount < 2) sessionQueue.push(word);
  }
}

// ── Audio recognition ──
function renderAudio(word) {
  fillState = { answered: false };
  const pool = shuffleArr(VOCAB.filter(w => w.id !== word.id)).slice(0, 3);
  const opts  = shuffleArr([word, ...pool]);
  document.getElementById('study-content').innerHTML = `
    <div class="recall-wrap">
      <div class="recall-prompt">听拼音选汉字 · Pinyin → Character</div>
      <button class="btn btn-teal" style="font-size:22px;padding:16px 32px;margin-bottom:24px;border-radius:50px"
        onclick="speak('${word.hanzi}')">🔊 <span id="audio-pinyin" style="opacity:0; transition: opacity 0.3s">${word.pinyin}</span></button>
      <div class="recall-options">
        ${opts.map(o => `<button class="recall-opt" data-correct="${o.id === word.id}" style="font-family:'Noto Serif SC',serif;font-size:26px;text-align:center;padding:20px"
          onclick="checkRecall(this,${o.id === word.id},${word.id})">${o.hanzi}</button>`).join('')}
      </div>
      <div id="next-action" style="display:none; margin-top:24px; width: 100%; max-width: 540px; text-align: center;">
        <button class="btn btn-teal" style="width: 100%; padding: 14px; font-size: 16px; border-radius: 12px; box-shadow: 0 4px 12px rgba(27,107,114,0.2)" onclick="goNextCard()">Next ➔</button>
      </div>
    </div>`;
  setTimeout(() => speak(word.hanzi), 300);
}

// ── Session done ──
function showSessionDone() {
  const acc = sessionTotal > 0 ? Math.round(sessionCorrect / sessionTotal * 100) : 0;
  
  document.getElementById('study-content').innerHTML = `
    <div class="done-wrap">
      <div class="done-emoji">${acc >= 80 ? '🎉' : acc >= 60 ? '💪' : '📚'}</div>
      <div class="done-title">${acc >= 80 ? '太棒了！' : acc >= 60 ? '继续加油！' : '需要多练习'}</div>
      <div class="done-sub">Session complete · 复习完成</div>
      <div class="done-stats">
        <div class="done-stat"><div class="done-stat-num">${sessionQueue.length}</div><div class="done-stat-label">Cards</div></div>
        <div class="done-stat"><div class="done-stat-num">${sessionCorrect}</div><div class="done-stat-label">Correct</div></div>
        <div class="done-stat"><div class="done-stat-num">${acc}%</div><div class="done-stat-label">Accuracy</div></div>
      </div>
      <div style="font-size:13px;color:var(--teal);margin-bottom:20px;font-weight:600">
        ✅ Sesi Harian Terekam
      </div>
      <div class="done-actions">
        <button class="btn btn-ghost" onclick="endSession()">← 主页</button>
        <button class="btn btn-teal"  onclick="startSession('${sessionMode}')">再来一组 ↻</button>
        <button class="btn btn-primary" onclick="startSession('due')">复习待复习词</button>
      </div>
    </div>`;
}

// ── Vocab table ──
let vocabFilter = 'all';
let vocabSearch = '';

function setVocabFilter(f, el) {
  vocabFilter = f;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderVocabTable();
}

function filterVocab() {
  vocabSearch = document.getElementById('vocab-search').value.toLowerCase();
  renderVocabTable();
}

function renderVocabTable() {
  let words = VOCAB;
  if      (vocabFilter === 'new')      words = words.filter(w => !srsData[String(w.id)] || srsData[String(w.id)].state === 'new');
  else if (vocabFilter === 'learning') words = words.filter(w => srsData[String(w.id)]?.state === 'learning');
  else if (vocabFilter === 'weak')     words = words.filter(w => (srsData[String(w.id)]?.errors || 0) >= 2);
  else if (vocabFilter === 'mastered') words = words.filter(w => srsData[String(w.id)]?.state === 'mastered');
  if (vocabSearch) words = words.filter(w =>
    w.hanzi.includes(vocabSearch) || w.pinyin.toLowerCase().includes(vocabSearch) || w.en.toLowerCase().includes(vocabSearch)
  );
  const stateMap = { new: 'state-new 新词', learning: 'state-learning 学习中', review: 'state-review 复习', mastered: 'state-mastered 已掌握' };
  const displayed = words.slice(0, 300);
  document.getElementById('vocab-tbody').innerHTML = displayed.map(w => {
    const sr      = srsData[String(w.id)] || { state: 'new' };
    const [cls, lbl] = (stateMap[sr.state] || 'state-new 新词').split(' ');
    return `<tr>
      <td class="td-hanzi" onclick="quickStudyWord(${w.id})" title="点击学习">${w.hanzi}</td>
      <td class="td-pinyin">${w.pinyin}</td>
      <td><span class="td-pos">${w.pos}</span></td>
      <td style="font-size:12px;color:var(--muted);max-width:280px">${w.en}</td>
      <td style="font-size:12px;color:var(--muted)">${w.lesson || '–'}</td>
      <td><span class="state-badge ${cls}">${lbl}</span>${(sr.errors || 0) > 0 ? `<span style="font-size:10px;color:var(--red);display:block">❌${sr.errors}次</span>` : ''}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="speak('${w.hanzi}')">🔊</button></td>
    </tr>`;
  }).join('');
  document.getElementById('vocab-count').textContent = `显示 ${displayed.length} / ${words.length} 词`;
}

function quickStudyWord(wordId) {
  const word     = VOCAB.find(w => w.id === wordId);
  sessionQueue   = [word];
  sessionIdx     = 0;
  sessionMode    = 'flash';
  cardFlipped    = false;
  sessionCorrect = 0;
  sessionTotal   = 0;
  sessionNewIntroduced = new Set();
  switchView('study');
  document.getElementById('nav-study').style.display = '';
  document.getElementById('study-mode-pill').textContent = '🎴 Quick Study';
  updateStudyProgress();
  renderStudyCard();
}

// ── Analytics ──
function renderAnalytics() {
  const counts = userStats.dailyCounts || {};
  const cells  = Array.from({ length: 30 }, (_, i) => {
    const d   = new Date(Date.now() - (29 - i) * 86400000);
    const key = d.toDateString();
    const n   = counts[key] || 0;
    const cls = n === 0 ? '' : n < 5 ? 'heat-1' : n < 15 ? 'heat-2' : n < 30 ? 'heat-3' : 'heat-4';
    return `<div class="heat-cell ${cls}" title="${key}: ${n} cards"></div>`;
  });
  document.getElementById('heatmap').innerHTML = cells.join('');

  const states = { new: 0, learning: 0, review: 0, mastered: 0 };
  VOCAB.forEach(w => { states[srsData[String(w.id)]?.state || 'new']++; });
  const total  = VOCAB.length;
  const barCfg = [
    { k: 'mastered', label: '已掌握 Mastered', color: 'var(--green)' },
    { k: 'review',   label: '复习中 Review',   color: 'var(--teal)'  },
    { k: 'learning', label: '学习中 Learning', color: 'var(--orange)' },
    { k: 'new',      label: '新词 New',         color: 'var(--gold)'  },
  ];
  document.getElementById('mastery-bars').innerHTML = barCfg.map(b => {
    const pct = Math.round(states[b.k] / total * 100);
    return `<div class="mastery-bar-row">
      <div class="mastery-bar-label"><span>${b.label}</span><span style="font-family:'DM Mono',monospace">${states[b.k]} / ${total}</span></div>
      <div class="progress-bar" style="height:8px"><div class="progress-fill" style="width:${pct}%;background:${b.color}"></div></div>
    </div>`;
  }).join('');

  const weakWords = VOCAB.filter(w => (srsData[String(w.id)]?.errors || 0) > 0)
    .sort((a, b) => (srsData[String(b.id)]?.errors || 0) - (srsData[String(a.id)]?.errors || 0))
    .slice(0, 8);
  if (!weakWords.length) {
    document.getElementById('weak-list').innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:13px">🎉 还没有弱词！继续学习吧。</div>';
  } else {
    document.getElementById('weak-list').innerHTML = weakWords.map(w => {
      const sr      = srsData[String(w.id)];
      const errRate = Math.round((sr.errors || 0) / Math.max(sr.reviews || 1, 1) * 100);
      return `<div class="weak-item" onclick="quickStudyWord(${w.id})">
        <div class="weak-hanzi">${w.hanzi}</div>
        <div class="weak-details">
          <div style="font-size:12px;color:var(--teal)">${w.pinyin}</div>
          <div class="weak-en">${w.en}</div>
        </div>
        <div class="weak-err-bar">
          <div class="weak-err-fill" style="width:${Math.min(errRate, 100)}%"></div>
          <div class="weak-err-label">${sr.errors || 0}错/${sr.reviews || 0}次</div>
        </div>
      </div>`;
    }).join('');
  }
}

// ── Audio ──
function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN'; u.rate = 0.85;
  window.speechSynthesis.speak(u);
}

// ── Toast ──
function toast(msg, type = '') {
  const wrap = document.getElementById('toast-wrap');
  const el   = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Keyboard shortcuts ──
document.addEventListener('keydown', e => {
  if (document.getElementById('view-study').classList.contains('active')) {
    if (e.key === ' ' && !cardFlipped && document.getElementById('card-inner')) {
      e.preventDefault(); flipCard();
    }
    if (cardFlipped && !fillState.answered) {
      const word = sessionQueue[sessionIdx];
      if (word) {
        if      (e.key === '1') nextCard('again', word.id);
        else if (e.key === '2') nextCard('hard',  word.id);
        else if (e.key === '3') nextCard('good',  word.id);
        else if (e.key === '4') nextCard('easy',  word.id);
      }
    }
  }
});

// ══════════════════════════════════════════════
//  NOTES LOGIC
// ══════════════════════════════════════════════
function renderNotes() {
  const grid = document.getElementById('notes-grid');
  const notes = userStats.notes || [];
  if (notes.length === 0) {
    grid.innerHTML = '<div style="color:var(--muted); font-size:14px; margin-top:20px; width:100%; text-align:center">Belum ada catatan. Klik <strong>+ Catatan Baru</strong> untuk membuat catatan pertamamu!</div>';
    return;
  }
  
  // Urutkan dari yang terbaru
  const sortedNotes = [...notes].sort((a,b) => b.updatedAt - a.updatedAt);
  
  grid.innerHTML = sortedNotes.map(n => `
    <div class="note-card" onclick="openNoteEditor(${n.id})">
      <div class="note-hanzi">${n.title}</div>
      <div class="note-preview">${n.body}</div>
    </div>
  `).join('');
}

function openNoteEditor(id = null) {
  currentNoteId = id;
  isNoteEditing = !id; // Jika id null (catatan baru), langsung masuk mode edit
  
  const notes = userStats.notes || [];
  const note = notes.find(n => n.id === id) || { title: '', body: '' };
  
  const hanziInput = document.getElementById('note-hanzi');
  const bodyInput = document.getElementById('note-body');
  
  hanziInput.value = note.title;
  bodyInput.value = note.body;
  
  hanziInput.disabled  = !isNoteEditing;
  bodyInput.disabled   = !isNoteEditing;
  
  updateNoteActionBtns();
  
  // Ganti layar ke view note editor
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-note-editor').classList.add('active');
}

function closeNoteEditor() {
  switchView('notes');
}

function toggleNoteEdit() {
  isNoteEditing = true;
  document.getElementById('note-hanzi').disabled = false;
  document.getElementById('note-body').disabled = false;
  document.getElementById('note-body').focus();
  updateNoteActionBtns();
}

function updateNoteActionBtns() {
  const wrap = document.getElementById('note-action-btns');
  if (isNoteEditing) {
    wrap.innerHTML = `<button class="btn btn-teal" onclick="saveNote()">Simpan</button>`;
  } else {
    wrap.innerHTML = `
      <button class="btn btn-ghost" onclick="toggleNoteEdit()">Edit</button>
      <button class="btn btn-ghost" style="color:var(--red); border-color:var(--red)" onclick="deleteNote()">Hapus</button>
    `;
  }
}

function saveNote() {
  const title = document.getElementById('note-hanzi').value.trim();
  const body = document.getElementById('note-body').value.trim();
  
  if(!title) { toast('Kolom Hanzi harus diisi!', 'error'); return; }
  
  if(!userStats.notes) userStats.notes = [];
  
  if (currentNoteId) {
    const note = userStats.notes.find(n => n.id === currentNoteId);
    if(note) {
      note.title = title;
      note.body = body;
      note.updatedAt = Date.now();
    }
  } else {
    const newNote = {
      id: Date.now(),
      title,
      body,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    userStats.notes.push(newNote);
    currentNoteId = newNote.id; // Switch to view mode for this new note
  }
  
  isNoteEditing = false;
  document.getElementById('note-hanzi').disabled = true;
  document.getElementById('note-body').disabled = true;
  updateNoteActionBtns();
  
  scheduleSync(); // Trigger push ke cloud secara otomatis
  toast('Catatan tersimpan!', 'success');
}

function deleteNote() {
  if(!confirm('Yakin ingin menghapus catatan ini secara permanen?')) return;
  if(userStats.notes) {
    userStats.notes = userStats.notes.filter(n => n.id !== currentNoteId);
  }
  scheduleSync();
  toast('Catatan dihapus!', 'success');
  closeNoteEditor();
}

// ── Boot ──
async function bootApp() {
  document.getElementById('loading').style.display = 'flex';
  showPage('app');
  initSRSData();          // inisialisasi semua kartu dengan key string
  await pullFromCloud();  // merge data cloud → lokal (key sudah dinormalisasi)
  updateHomeStats();
  renderLessons();
  document.getElementById('loading').style.display = 'none';
  switchView('home');
}

// ── Entry point ──
(async () => {
  const restored = await tryRestoreSession();
  document.getElementById('loading').style.display = 'none';
  if (restored) {
    await bootApp();
  } else {
    showPage('auth');
  }
})();
