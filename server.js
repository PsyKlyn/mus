const express = require('express');
const path = require('path');
const { getWordLyrics } = require('./lyrics');

const app = express();
const PORT = process.env.PORT || 3000;
const root = __dirname;

app.disable('x-powered-by');
app.use(express.static(root, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js')) res.type('application/javascript');
    if (filePath.endsWith('.css')) res.type('text/css');
  }
}));

// Word-timed lyrics proxy (browser can't call the providers directly: CORS + keeps requests server-side).
const lyricsCache = new Map(); // key -> { at, value }
const HIT_TTL = 24 * 60 * 60 * 1000;
const MISS_TTL = 15 * 60 * 1000;
const CACHE_MAX = 1000;

app.get('/api/lyrics', async (req, res) => {
  const title = String(req.query.title || '').slice(0, 200).trim();
  const artist = String(req.query.artist || '').slice(0, 200).trim();
  const album = String(req.query.album || '').slice(0, 200).trim();
  const durationSec = Math.round(Number(req.query.duration)) || 0;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist are required' });

  const key = [title, artist, durationSec].join('|').toLowerCase();
  const hit = lyricsCache.get(key);
  if (hit && Date.now() - hit.at < (hit.value ? HIT_TTL : MISS_TTL)) {
    return hit.value ? res.json(hit.value) : res.status(404).json({ error: 'not found' });
  }

  const value = await getWordLyrics({ title, artist, album, durationSec }).catch(() => null);
  if (lyricsCache.size >= CACHE_MAX) lyricsCache.delete(lyricsCache.keys().next().value);
  lyricsCache.set(key, { at: Date.now(), value });
  res.set('Cache-Control', 'public, max-age=3600');
  return value ? res.json(value) : res.status(404).json({ error: 'not found' });
});

app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QUE web service listening on ${PORT}`);
});
