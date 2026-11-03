# QUE — Enhanced Lyrics Web Service

This package is the current QUE browser player packaged as a Node/Express web service for Render.

## Deploy on Render
1. Upload these files to your GitHub repository (project root).
2. In Render, create **New > Web Service** and connect the repository.
3. Runtime: Node.
4. Build command: `npm install`
5. Start command: `npm start`
6. Deploy.

The server serves the static frontend and exposes `/health`.

## Spotify configuration
The configured Spotify Redirect URI is:

```text
https://muss-9l5v.onrender.com/
```

Add this exact URI in Spotify Developer Dashboard → your app → Settings → Redirect URIs. Keep the trailing slash, and ensure the same value is used in `script.js` and in the token exchange.

## Lyrics notes
The existing QUE client parses Enhanced LRC inline word timestamps when returned by its lyrics source. Standard line-timestamp LRC is handled with estimated word timings as a fallback. This package does not claim that standard LRC has genuine word-level timing.

## Word-timed lyrics (Apple Music style)
`server.js` exposes `GET /api/lyrics?title=&artist=&album=&duration=` (duration in seconds). It asks
the LyricsPlus aggregator for word/syllable-timed lyrics (`lyrics.js`), normalises them, caches results,
and returns `{ source, lines: [{ time, end, text, words: [{ text, time, end }] }] }` (times in seconds).
If nothing word-timed is found, the browser falls back to LRCLIB line-synced lyrics with estimated word timing.

LyricsPlus is an unofficial, community-run service: it can change or go offline, and its source data may
have licensing terms of its own. Needs Node 18+ (global `fetch`).

Lyric timing tweak in the browser: press `]` to show lyrics earlier, `[` for later (50 ms steps, saved locally).
