// Word-timed lyrics support: fetch from LyricsPlus (an unofficial aggregator of Apple Music /
// Musixmatch word-timed data) and normalise it to { source, lines: [{ time, end, text, words }] }
// with all times in SECONDS. Kept separate from server.js so it can be tested on its own.

const LYRICSPLUS_HOSTS = [
  'https://lyricsplus.prjktla.my.id',
  'https://lyricsplus.binimum.org'
];
const REQUEST_TIMEOUT_MS = 4000;

function cleanTrackTitle(title) {
  return String(title)
    .replace(/\s*[-–—]\s*(\d{4}\s*)?(remaster(ed)?|live|radio edit|mono|stereo|single version|deluxe|bonus track|from\b).*$/i, '')
    .replace(/\s*[(\[]\s*(feat|ft|with|remaster(ed)?|live|radio edit)\b[^)\]]*[)\]]/gi, '')
    .trim();
}

const cleanText = s => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));

// LyricsPlus "Word" payload -> normalised lines. Returns null if the payload has no usable
// word timing (so the caller can fall back to line-synced lyrics).
function normalizeLyricsPlus(payload) {
  if (!payload || payload.type !== 'Word' || !Array.isArray(payload.lyrics)) return null;

  const lines = [];
  let timedLines = 0;

  for (const raw of payload.lyrics) {
    const lineStartMs = num(raw.time);
    if (!Number.isFinite(lineStartMs)) continue;
    const lineText = cleanText(raw.text);

    const syl = (Array.isArray(raw.syllabus) ? raw.syllabus : [])
      .filter(s => s && !s.isBackground && typeof s.text === 'string' && Number.isFinite(num(s.time)));

    let words = [];
    if (syl.length) {
      // Syllables -> words: a syllable whose text ends in whitespace closes the word.
      let cur = null;
      const flush = () => { if (cur && cur.text) words.push(cur); cur = null; };
      syl.forEach((s, i) => {
        const start = num(s.time) / 1000;
        const dur = num(s.duration);
        const nextStart = syl[i + 1] ? num(syl[i + 1].time) / 1000 : null;
        let end = Number.isFinite(dur) && dur > 0 ? start + dur / 1000 : (nextStart ?? start + 0.3);
        if (end <= start) end = start + 0.05;
        const piece = cleanText(s.text);
        if (!cur) cur = { text: '', time: start, end };
        cur.text += piece;
        cur.end = Math.max(cur.end, end);
        if (/\s$/.test(s.text)) flush();
      });
      flush();
      timedLines++;
    } else if (lineText) {
      // No syllable data for this line: spread its words across the line's own duration.
      const ws = lineText.split(' ').filter(Boolean);
      const dur = num(raw.duration);
      const span = Number.isFinite(dur) && dur > 0 ? dur / 1000 : Math.min(4, 0.35 * ws.length);
      const total = ws.reduce((a, w) => a + w.length + 1, 0);
      let acc = 0;
      words = ws.map(w => {
        const t = lineStartMs / 1000 + (span * acc) / total;
        acc += w.length + 1;
        return { text: w, time: t, end: lineStartMs / 1000 + (span * acc) / total };
      });
    }

    if (!words.length) continue;

    // Keep order monotonic and never let a word end after the next one starts.
    for (let i = 0; i < words.length; i++) {
      if (i > 0 && words[i].time < words[i - 1].time) words[i].time = words[i - 1].time;
      const next = words[i + 1];
      if (next && words[i].end > next.time && next.time > words[i].time) words[i].end = next.time;
      if (words[i].end <= words[i].time) words[i].end = words[i].time + 0.05;
    }

    lines.push({
      time: words[0].time,
      end: words[words.length - 1].end,
      text: words.map(w => w.text).join(' '),
      words
    });
  }

  if (!lines.length || !timedLines) return null; // nothing genuinely word-timed
  lines.sort((a, b) => a.time - b.time);
  return { source: payload.metadata?.source || 'LyricsPlus', lines };
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'QUE-player/1.0', Accept: 'application/json' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolves with the first attempt that yields usable word-timed lyrics, else null.
function firstValid(tasks) {
  return new Promise(resolve => {
    let left = tasks.length;
    if (!left) return resolve(null);
    const done = v => { if (v) resolve(v); else if (--left === 0) resolve(null); };
    tasks.forEach(t => t.then(done, () => done(null)));
  });
}

async function getWordLyrics({ title, artist, album, durationSec }) {
  const titles = [...new Set([title, cleanTrackTitle(title)])].filter(Boolean);
  for (const t of titles) {
    const build = (host, withDuration) => {
      const q = new URLSearchParams({ title: t, artist });
      if (album) q.set('album', album);
      if (withDuration && durationSec) q.set('duration', String(durationSec));
      return `${host}/v2/lyrics/get?${q}`;
    };
    const attempts = [
      [LYRICSPLUS_HOSTS[0], true],
      [LYRICSPLUS_HOSTS[0], false],
      [LYRICSPLUS_HOSTS[1], false]
    ].map(([host, d]) => fetchJson(build(host, d)).then(normalizeLyricsPlus));
    const hit = await firstValid(attempts);
    if (hit) return hit;
  }
  return null;
}

module.exports = { getWordLyrics, normalizeLyricsPlus, cleanTrackTitle };
