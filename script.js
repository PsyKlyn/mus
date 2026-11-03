// SPOTIFY CONFIG

const CLIENT_ID = "444ffc8623ac4e0f890787e960e4c040";
const REDIRECT_URI = "https://muss-9l5v.onrender.com/";
const SCOPES = [
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-top-read",
    "user-read-recently-played"
].join(" ");


// DOM ELEMENTS

const carousel = document.getElementById("carousel");
const cover = document.getElementById("cover");
const titleEl = document.getElementById("title");
const artistEl = document.getElementById("artist");
const icon = document.getElementById("playIcon");
const path = document.getElementById("waveProgress");
const slider = document.getElementById("slider");
const queueList = document.getElementById("queueList");
const bgElement = document.getElementById("bg");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const searchBtn = document.getElementById("searchBtn");
const loginScreen = document.getElementById("loginScreen");
const playerScreen = document.getElementById("playerScreen");


// STATE

let accessToken = null;
let spotifyPlayer = null;
let deviceId = null;
let songs = [];
let cardElements = [];
let current = 0;
let dynamicColors = { dominant: null, secondary: null };
let searchTimeout = null;
let isPlaying = false;
let progressInterval = null;
let currentPosition = 0;
let positionStamp = performance.now();
let lyricRaf = null;
let currentDuration = 0;
let smartShuffleEnabled = false;
let smartRecommendationBusy = false;
let smartAddedUris = new Set();
let endTransitionLock = false;

let currentLyrics = [];
let currentLyricIndex = -1;
let lyricInterval = null;
let lyricsRequestId = 0;

const colorThief = new ColorThief();


// WAVE PROGRESS SETUP

const pathLength = path.getTotalLength();
path.style.strokeDasharray = pathLength;
path.style.strokeDashoffset = pathLength;


// AUTH — SPOTIFY PKCE


async function generateCodeVerifier(length = 128) {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    let verifier = "";

    const array = new Uint8Array(length);
    crypto.getRandomValues(array);

    array.forEach(v => {
        verifier += chars[v % chars.length];
    });

    return verifier;
}

async function generateCodeChallenge(verifier) {

    const data = new TextEncoder().encode(verifier);

    const digest = await crypto.subtle.digest(
        "SHA-256",
        data
    );

    return btoa(
        String.fromCharCode(...new Uint8Array(digest))
    )
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

async function loginWithSpotify() {

    const verifier = await generateCodeVerifier();

    const challenge =
        await generateCodeChallenge(verifier);

    localStorage.setItem(
        "spotify_code_verifier",
        verifier
    );

    const authUrl =
        "https://accounts.spotify.com/authorize"
        + `?client_id=${CLIENT_ID}`
        + `&response_type=code`
        + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
        + `&scope=${encodeURIComponent(SCOPES)}`
        + `&code_challenge_method=S256`
        + `&code_challenge=${challenge}`;

    window.location.href = authUrl;
}

function getCodeFromUrl() {

    const params =
        new URLSearchParams(window.location.search);

    return params.get("code");
}

async function exchangeCodeForToken(code) {

    const verifier =
        localStorage.getItem(
            "spotify_code_verifier"
        );

    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
    });

    const response = await fetch(
        "https://accounts.spotify.com/api/token",
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded"
            },
            body
        }
    );

    const data = await response.json();

    console.log("TOKEN RESPONSE:", data);
    // Access token intentionally not logged.
    console.log("TOKEN STATUS:", response.status);


    if (data.access_token) {

        accessToken = data.access_token;

        window.history.replaceState(
            {},
            document.title,
            window.location.pathname
        );

        showPlayer();

    } else {

        console.error(
            "Token exchange failed:",
            data
        );

        showLogin();
    }
}

async function initAuth() {

    const code = getCodeFromUrl();

    if (!code) {
        showLogin();
        return;
    }

    await exchangeCodeForToken(code);
}

function showLogin() {
    loginScreen.style.display = "flex";
    playerScreen.style.display = "none";
}

function showPlayer() {
    loginScreen.style.display = "none";
    playerScreen.style.display = "block";
    initCarousel();
    renderQueue();
    initSpotifyPlayer();
}


// SPOTIFY WEB PLAYBACK SDK

window.onSpotifyWebPlaybackSDKReady = () => {
    // SDK is ready — player is initialized after login in initSpotifyPlayer()
};

function initSpotifyPlayer() {
    spotifyPlayer = new Spotify.Player({
        name: "Liquid Glass Player",
        getOAuthToken: cb => cb(accessToken),
        volume: 0.8
    });

    spotifyPlayer.addListener("ready", ({ device_id }) => {
        deviceId = device_id;
        console.log("Spotify player ready, device:", device_id);
    });

    spotifyPlayer.addListener("not_ready", ({ device_id }) => {
        console.log("Device offline:", device_id);
    });

    spotifyPlayer.addListener("player_state_changed", state => {
        if (!state) return;
        isPlaying = !state.paused;
        currentPosition = state.position; positionStamp = performance.now();
        currentDuration = state.duration;
        // Lyrics/progress depend on the current track duration and position.
        updateCurrentLyric();

        icon.classList.toggle("fa-play", state.paused);
        icon.classList.toggle("fa-pause", !state.paused);

        updateWaveProgress();

        if (state.paused) {

            stopLyricLoop();

        } else if (
            currentLyrics.length > 0 &&
            !lyricRaf
        ) {

            syncLyrics(currentLyrics);
        }

        if (isPlaying) {
            startProgressPoll();
        } else {
            stopProgressPoll();
        }

        // SDK state changes can indicate an ended track. Guard against repeated events.
        if (state.paused && state.position === 0 && currentDuration > 0 && !endTransitionLock) {
            handleTrackEnded();
        }
    });

    spotifyPlayer.addListener("authentication_error", () => {
        alert("Spotify session expired. Please log in again.");
        showLogin();
    });

    spotifyPlayer.connect();
}


// PROGRESS POLLING (SDK doesn't fire timeupdate like audio tag)

function startProgressPoll() {
    stopProgressPoll();
    progressInterval = setInterval(async () => {
        if (!spotifyPlayer || endTransitionLock) return;
        try {
            const t0 = performance.now();
            const state = await spotifyPlayer.getCurrentState();
            if (!state) return;
            samplePosition(state.position, t0);
            currentDuration = state.duration;
            updateWaveProgress();
            updateCurrentLyric();

            // Start advancing near the end; SDK end events are inconsistent
            // across browsers/devices. The lock makes this a single transition.
            if (state.duration > 0 && state.position >= state.duration - 700) {
                stopProgressPoll();
                await handleTrackEnded();
            }
        } catch (error) {
            console.warn("Playback state polling failed:", error);
        }
    }, 400);
}

function stopProgressPoll() {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
}

function updateWaveProgress() {
    if (!currentDuration) return;
    const percent = currentPosition / currentDuration;
    const point = path.getPointAtLength(percent * pathLength);
    const svg = path.ownerSVGElement;
    const box = svg.viewBox.baseVal;
    const scaleX = svg.clientWidth / box.width;
    const scaleY = svg.clientHeight / box.height;

    slider.style.left = (point.x * scaleX) + "px";
    slider.style.top = (point.y * scaleY) + "px";
    path.style.strokeDashoffset = pathLength - (percent * pathLength);
}


// SPOTIFY SEARCH

async function searchSpotify() {

    const query = searchInput.value.trim();

    if (!query || !accessToken) {
        console.log("No query or token");
        console.log("TOKEN:", accessToken);
        return;
    }

    console.log("ACCESS TOKEN VALUE:", accessToken);
    console.log(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`
    );

    searchBtn.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {

        const res = await fetch(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        );

        const data = await res.json();
        console.log("STATUS:", res.status);
        console.log("TRACK COUNT:", data?.tracks?.items?.length);
        console.log("FULL DATA:", data);

        console.log("SEARCH RESPONSE:", data);

        if (!res.ok) {
            console.error("SPOTIFY ERROR:", JSON.stringify(data, null, 2));
            return;
        }

        if (
            data.tracks &&
            data.tracks.items &&
            data.tracks.items.length > 0
        ) {

            renderSearchResults(
                data.tracks.items
            );

        } else {

            searchResults.innerHTML =
                '<div class="search-no-results">No songs found.</div>';
        }

    } catch (err) {

        console.error(
            "SEARCH ERROR:",
            err
        );

    }

    searchBtn.innerHTML =
        '<i class="fa-solid fa-arrow-right"></i>';
}


// RENDER SEARCH RESULTS

function renderSearchResults(tracks) {

    console.log("RENDERING TRACKS:", tracks);
    console.log("TRACKS LENGTH:", tracks?.length);

    searchResults.innerHTML = "";

    if (!tracks || tracks.length === 0) {

        console.log("NO TRACKS FOUND");

        searchResults.innerHTML = `
            <div class="search-no-results">
                No songs found.
            </div>
        `;

        searchResults.classList.add("active");
        return;
    }

    tracks.forEach(track => {

        const img =
            track.album?.images?.[1]?.url ||
            track.album?.images?.[0]?.url ||
            "";

        const item = document.createElement("div");

        item.className = "search-result-item";

        item.innerHTML = `
            <img
                src="${img}"
                alt="${track.name}"
                onerror="this.src='https://via.placeholder.com/44x44/333/fff?text=♪'"
            >

            <div class="search-result-info">
                <div class="search-result-title">
                    ${track.name}
                </div>

                <div class="search-result-artist">
                    ${track.artists.map(a => a.name).join(", ")}
                </div>
            </div>

            <button class="search-add-btn" title="Add to queue">
                <i class="fa-solid fa-plus"></i>
            </button>

            <button class="search-play-btn" title="Play now">
                <i class="fa-solid fa-play"></i>
            </button>
        `;

        item.querySelector(".search-add-btn").onclick = e => {
            e.stopPropagation();
            addToQueue(track);
            showAddedFeedback(item);
        };

        item.querySelector(".search-play-btn").onclick = e => {
            e.stopPropagation();
            addToQueue(track, true);
            closeSearch();
        };

        item.onclick = () => {
            addToQueue(track, true);
            closeSearch();
        };

        searchResults.appendChild(item);
    });

    searchResults.classList.add("active");

    console.log(
        "RENDER COMPLETE:",
        searchResults.children.length
    );
}


// ADD TRACK TO QUEUE

function addToQueue(track, playNow = false) {
    const img = track.album.images[1]?.url || track.album.images[0]?.url || "";
    const song = {
        uri: track.uri,
        title: track.name,
        artist: track.artists.map(a => a.name).join(", "),
        image: img,
        duration: track.duration_ms
    };

    songs.push(song);

    if (playNow || songs.length === 1) {
        current = songs.length - 1;
        updateCarousel();
        loadSong();
    }

    renderQueue();
}

function showAddedFeedback(item) {
    const btn = item.querySelector(".search-add-btn");
    btn.innerHTML = '<i class="fa-solid fa-check"></i>';
    btn.style.background = "rgba(100,255,150,0.3)";
    setTimeout(() => {
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.style.background = "";
    }, 1200);
}

function closeSearch() {
    searchResults.classList.remove("active");
    searchInput.value = "";
}

document.addEventListener("click", e => {
    if (!e.target.closest(".search-bar-wrapper")) {
        searchResults.classList.remove("active");
    }
});

searchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") searchSpotify();
});

searchInput.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    const query = searchInput.value.trim();
    if (query.length >= 3) {
        searchTimeout = setTimeout(searchSpotify, 500);
    } else if (query.length === 0) {
        searchResults.classList.remove("active");
    }
});


function cleanTrackTitle(title) {
    return String(title)
        .replace(/\s*[-–—]\s*(\d{4}\s*)?(remaster(ed)?|live|radio edit|mono|stereo|single version|deluxe|bonus track|from\b).*$/i, "")
        .replace(/\s*[\(\[]\s*(feat|ft|with|remaster(ed)?|live|radio edit)\b[^\)\]]*[\)\]]/gi, "")
        .trim();
}

async function fetchLyrics(track, artist, durationMs) {
    const durSec = durationMs ? Math.round(durationMs / 1000) : null;
    const base = "https://lrclib.net/api";
    const titles = [...new Set([track, cleanTrackTitle(track)])];
    const mainArtist = String(artist).split(/,|&| feat\.? | x /i)[0].trim();

    try {
        // 1) Exact match, constrained to the same recording length (±2s on LRCLIB).
        for (const t of titles) {
            const q = new URLSearchParams({ track_name: t, artist_name: artist });
            if (durSec) q.set("duration", String(durSec));
            const r = await fetch(`${base}/get?${q}`);
            if (r.ok) {
                const d = await r.json();
                if (d.syncedLyrics) return d.syncedLyrics;
            }
        }

        // 2) Search fallback: pick the synced result whose length is closest to the Spotify track.
        const q = new URLSearchParams({ track_name: titles[titles.length - 1], artist_name: mainArtist });
        const r = await fetch(`${base}/search?${q}`);
        if (!r.ok) return null;
        const results = (await r.json()).filter(x => x.syncedLyrics);
        if (!results.length) return null;
        if (!durSec) return results[0].syncedLyrics;
        results.sort((a, b) => Math.abs(a.duration - durSec) - Math.abs(b.duration - durSec));
        const best = results[0];
        // A length mismatch means a different version, whose timestamps would be off.
        return Math.abs(best.duration - durSec) <= 8 ? best.syncedLyrics : null;
    } catch (err) {
        console.error("Lyrics fetch error:", err);
        return null;
    }
}


// LOAD & PLAY SONG via Spotify API

async function loadSong() {

    if (current < 0 || current >= songs.length)
        return;

    const song = songs[current];

    titleEl.innerText = song.title;
    artistEl.innerText = song.artist;
    cover.src = song.image;
    currentDuration = song.duration;

    // Reset wave
    path.style.strokeDashoffset = pathLength;
    slider.style.left = "0px";

    // Start playback FIRST
    if (deviceId && accessToken) {

        try {

            await fetch(
                `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
                {
                    method: "PUT",
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        uris: [song.uri]
                    })
                }
            );

        } catch (err) {

            console.error(
                "Playback error:",
                err
            );
        }
    }

    // Reset lyric state and invalidate any older request (race protection).
    const thisLyricsRequest = ++lyricsRequestId;
    stopLyricLoop();
    lyricInterval = null;
    currentLyrics = [];
    currentLyricIndex = -1;

    const lyricElement = document.getElementById("current-lyric");
    if (lyricElement) {
        lyricElement.classList.remove("show");
        lyricElement.textContent = "Loading lyrics…";
    }

    fetchLyrics(song.title, song.artist, song.duration).then(lrc => {
        // A previous song's delayed response must never replace current lyrics.
        if (thisLyricsRequest !== lyricsRequestId || current !== songs.indexOf(song)) return;

        if (!lrc) {
            if (lyricElement) lyricElement.textContent = "No synced lyrics found";
            return;
        }

        const parsedLyrics = parseLRC(lrc);
        if (!parsedLyrics.length) {
            if (lyricElement) lyricElement.textContent = "No synced lyrics found";
            return;
        }

        currentLyrics = parsedLyrics;
        updateCurrentLyric();
        if (isPlaying) syncLyrics(currentLyrics);
    }).catch(err => {
        if (thisLyricsRequest !== lyricsRequestId) return;
        console.error("Lyrics error:", err);
        if (lyricElement) lyricElement.textContent = "Unable to load lyrics";
    });

    // Update visuals
    const img = new Image();

    img.crossOrigin = "anonymous";
    img.src = song.image;

    img.onload = () => {

        setBackground(img);
        extractColors(img);

    };
}


// PLAYBACK CONTROLS

function togglePlay() {
    if (!spotifyPlayer) return;
    spotifyPlayer.togglePlay();
}

function next() {
    if (songs.length === 0) return;
    if (current < songs.length - 1) current += 1;
    else if (smartShuffleEnabled) { handleTrackEnded(); return; }
    else return;
    updateCarousel();
    loadSong();
    renderQueue();
}

async function handleTrackEnded() {
    // Prevent duplicate end events while an item is being advanced/discovered.
    if (endTransitionLock) return;
    endTransitionLock = true;
    try {
        // First honor songs explicitly placed in the queue.
        if (current < songs.length - 1) {
            current += 1;
            updateCarousel();
            renderQueue();
            await loadSong();
            return;
        }

        // Queue exhausted: Smart Shuffle must discover an item not already in
        // the playlist/queue/history and start it, not merely append it.
        if (!smartShuffleEnabled) return;
        const recommendations = await fetchSmartRecommendations();
        if (!recommendations.length) {
            console.warn("Smart Shuffle: no eligible recommendations returned.");
            renderQueue();
            return;
        }
        const firstRecommendedIndex = songs.length;
        songs.push(...recommendations);
        current = firstRecommendedIndex;
        updateCarousel();
        renderQueue();
        await loadSong();
    } finally {
        // Keep a short cooldown against duplicate SDK end notifications.
        setTimeout(() => { endTransitionLock = false; }, 1200);
    }
}

function toggleSmartShuffle() {
    smartShuffleEnabled = !smartShuffleEnabled;
    const button = document.getElementById("smartShuffleBtn");
    if (button) {
        button.classList.toggle("enabled", smartShuffleEnabled);
        button.setAttribute("aria-pressed", String(smartShuffleEnabled));
        button.innerHTML = `<i class="fa-solid fa-shuffle"></i> Smart Shuffle ${smartShuffleEnabled ? "On" : "Off"}`;
    }
    renderQueue();

    // Pre-fill recommendations while the current track is still playing so
    // they are ready before the queue reaches its end.
    if (smartShuffleEnabled) {
        fetchSmartRecommendations().then(list => {
            if (!smartShuffleEnabled || !list.length) return;
            songs.push(...list);
            renderQueue();
        }).catch(error => console.warn("Smart Shuffle prefetch failed:", error));
    }
}

// Never inject Hindi-language/Bollywood tracks into Smart Shuffle. Spotify Search
// does not expose a dependable track-language field, so use script detection plus
// a conservative artist/label vocabulary as a practical exclusion filter.
function isHindiTrackCandidate(track) {
    const text = [track?.name, track?.album?.name, ...(track?.artists || []).map(a => a.name)]
        .filter(Boolean).join(' ');
    // Devanagari text is a strong signal for Hindi-language catalog entries.
    if (/[\u0900-\u097F]/u.test(text)) return true;
    const normalized = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
    const hindiArtistTerms = [
        'arijit singh','shreya ghoshal','pritam','ar rahman','a r rahman','atif aslam',
        'neha kakkar','badshah','honey singh','yo yo honey singh','jubin nautiyal',
        'armaan malik','sonu nigam','alka yagnik','kishore kumar','lata mangeshkar',
        'udit narayan','mohit chauhan','sunidhi chauhan','vishal shekhar','vishal dadlani',
        'amit trivedi','anu malik','sachet tandon','parampara thakur','tanishk bagchi',
        'bollywood','hindi soundtrack','hindi songs','t series','zee music company'
    ];
    return hindiArtistTerms.some(term => normalized.includes(term));
}

async function fetchSmartRecommendations() {
    if (!accessToken || !songs.length || smartRecommendationBusy) return [];
    smartRecommendationBusy = true;
    try {
        const seed = songs[current] || songs[songs.length - 1];
        const seedArtist = (seed.artist || "").split(",")[0].trim();
        const seedTitle = seed.title || "";
        const sessionCount = Number(window.smartShuffleEraCount || 0);
        const known = new Set([
            ...songs.map(x => x.uri).filter(Boolean),
            ...smartAddedUris
        ]);
        const found = [];
        const seenArtist = new Set();

        // Pull listening signals when the newly requested OAuth scopes are granted.
        // These are optional: recommendation discovery still works if either endpoint fails.
        let topArtists = [], topTracks = [], recentTracks = [];
        const getSpotify = async path => {
            const r = await fetch(`https://api.spotify.com/v1/${path}`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (!r.ok) throw new Error(`Spotify ${r.status} for ${path}`);
            return r.json();
        };
        try {
            const [artists, tracks, recent] = await Promise.all([
                getSpotify('me/top/artists?limit=20&time_range=medium_term').catch(() => ({items:[]})),
                getSpotify('me/top/tracks?limit=20&time_range=medium_term').catch(() => ({items:[]})),
                getSpotify('me/player/recently-played?limit=20').catch(() => ({items:[]}))
            ]);
            topArtists = artists.items || [];
            topTracks = tracks.items || [];
            recentTracks = (recent.items || []).map(x => x.track).filter(Boolean);
        } catch (e) { console.debug('Listening signals unavailable:', e); }

        // Find the seed's release year if it isn't already on the queue object.
        let seedYear = Number(seed.year || seed.releaseYear || 0);
        if (!seedYear && seed.uri) {
            try {
                const id = seed.uri.split(':').pop();
                const meta = await getSpotify(`tracks/${id}`);
                seedYear = parseInt((meta.album?.release_date || '').slice(0,4), 10) || 0;
            } catch (_) {}
        }
        if (!seedYear) seedYear = new Date().getFullYear();

        // Stay in the seed era for the first few injected songs, then gently
        // move toward current music. Every 3rd cycle broadens to newer releases.
        const moveToPresent = sessionCount >= 3;
        const lowEra = Math.max(1950, seedYear - 3);
        const highEra = Math.min(new Date().getFullYear(), seedYear + 3);
        const currentYear = new Date().getFullYear();

        const favoriteArtists = [...topArtists.map(a => a.name), ...topTracks.map(t => t.artists?.[0]?.name), ...recentTracks.map(t => t.artists?.[0]?.name)]
            .filter(Boolean);
        const seedGenres = (topArtists.find(a => a.name?.toLowerCase() === seedArtist.toLowerCase())?.genres || []);
        const genreTerms = [...new Set(seedGenres)].slice(0, 3);
        const artistTerms = [...new Set([seedArtist, ...favoriteArtists])].filter(Boolean).slice(0, 8);

        // Search era-specific music, not simply an artist's biggest hits.
        // Use a mix of favorite-artist catalog searches and year/genre searches.
        const queries = [];
        if (!moveToPresent) {
            for (const artist of artistTerms.slice(0, 5)) queries.push(`artist:"${artist}" year:${lowEra}-${highEra}`);
            for (const genre of genreTerms) queries.push(`genre:"${genre}" year:${lowEra}-${highEra}`);
            queries.push(`year:${lowEra}-${highEra}`);
        } else {
            const modernStart = Math.max(seedYear + 1, currentYear - 5);
            for (const artist of artistTerms.slice(0, 4)) queries.push(`artist:"${artist}" year:${modernStart}-${currentYear}`);
            for (const genre of genreTerms) queries.push(`genre:"${genre}" year:${Math.max(2021, modernStart)}-${currentYear}`);
            // Keep an era anchor in the mix so the transition feels gradual.
            queries.push(`year:${lowEra}-${highEra}`);
        }

        // Add familiar artists from the user's actual taste, without letting one
        // artist dominate. Search API's track limit is capped at 10.
        for (const query of [...new Set(queries)].slice(0, 12)) {
            const params = new URLSearchParams({ q: query, type: 'track', limit: '10' });
            const r = await fetch(`https://api.spotify.com/v1/search?${params}`, { headers: {Authorization:`Bearer ${accessToken}`} });
            if (!r.ok) continue;
            const data = await r.json();
            for (const track of data.tracks?.items || []) {
                if (isHindiTrackCandidate(track)) continue;
                if (!track.uri || known.has(track.uri)) continue;
                const year = parseInt((track.album?.release_date || '').slice(0,4), 10) || 0;
                // Keep the era filter meaningful; allow broader present-day transition.
                if (!moveToPresent && year && (year < lowEra || year > highEra)) continue;
                if (moveToPresent && year && year < Math.max(2021, seedYear + 1) && year < currentYear - 5) continue;
                known.add(track.uri);
                found.push({
                    uri: track.uri, title: track.name,
                    artist: (track.artists || []).map(a => a.name).join(', '),
                    image: track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || '',
                    duration: track.duration_ms, year,
                    popularity: track.popularity || 0,
                    smartRecommended: true
                });
            }
            if (found.length >= 30) break;
        }

        // Rank for the user's known taste, era-fit, and popularity; shuffle among
        // near-equals so successive batches don't sound identical.
        const fav = new Set(favoriteArtists.map(a => a.toLowerCase()));
        const score = t => {
            const main = (t.artist || '').split(',')[0].trim().toLowerCase();
            const eraFit = t.year ? (moveToPresent ? (t.year >= 2021 ? 2 : 0.5) : (Math.abs(t.year-seedYear) <= 3 ? 3 : 0)) : 0;
            return eraFit + (fav.has(main) ? 2 : 0) + (t.popularity / 100) + Math.random() * 0.8;
        };
        found.sort((a,b) => score(b)-score(a));
        const selected = [];
        for (const t of found) {
            const artist = (t.artist || '').split(',')[0].toLowerCase();
            if (artist && seenArtist.has(artist)) continue;
            selected.push(t); if (artist) seenArtist.add(artist);
            if (selected.length >= 5) break;
        }
        // Avoid empty results if the catalog returned multiple tracks by same artist.
        if (selected.length < 5) for (const t of found) {
            if (selected.some(x => x.uri === t.uri)) continue;
            selected.push(t); if (selected.length >= 5) break;
        }
        selected.forEach(t => smartAddedUris.add(t.uri));
        window.smartShuffleEraCount = sessionCount + selected.length;
        return selected;
    } catch (error) {
        console.warn('Era-aware Smart Shuffle failed:', error);
        return [];
    } finally { smartRecommendationBusy = false; }
}

function prev() {
    if (songs.length === 0) return;
    current = (current - 1 + songs.length) % songs.length;
    updateCarousel();
    loadSong();
    renderQueue();
}


// SEEK

async function seek(e) {
    if (!accessToken || !currentDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const position = Math.floor(percent * currentDuration);

    try {
        await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${position}&device_id=${deviceId}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        currentPosition = position; positionStamp = performance.now();
        updateCurrentLyric();
        updateWaveProgress();
    } catch (err) {
        console.error("Seek error:", err);
    }
}

// CAROUSEL

function initCarousel() {
    // Build the three carousel cards only once. showPlayer() can be
    // called again after authentication errors or re-entry.
    if (cardElements.length !== 3) {
        carousel.replaceChildren();
        cardElements = [];

        for (let i = 0; i < 3; i++) {
            const card = document.createElement("div");
            card.className = "card";
            card.innerHTML = '<img crossOrigin="anonymous" alt="Album cover">';
            carousel.appendChild(card);
            cardElements.push(card);
        }
    }

    updateCarousel();
}

function updateCarousel() {
    if (cardElements.length !== 3) return;

    if (songs.length === 0) {
        cardElements.forEach(card => {
            card.classList.remove("left", "center", "right");
            card.querySelector("img").removeAttribute("src");
            card.onclick = null;
        });
        return;
    }

    const leftIndex = (current - 1 + songs.length) % songs.length;
    const centerIndex = current;
    const rightIndex = (current + 1) % songs.length;

    cardElements[0].classList.remove("center", "right");
    cardElements[0].classList.add("left");
    cardElements[0].querySelector("img").src = songs[leftIndex].image;
    cardElements[0].onclick = () => selectSong(leftIndex);

    cardElements[1].classList.remove("left", "right");
    cardElements[1].classList.add("center");
    cardElements[1].querySelector("img").src = songs[centerIndex].image;
    cardElements[1].onclick = () => selectSong(centerIndex);

    cardElements[2].classList.remove("left", "center");
    cardElements[2].classList.add("right");
    cardElements[2].querySelector("img").src = songs[rightIndex].image;
    cardElements[2].onclick = () => selectSong(rightIndex);
}


// QUEUE

function renderQueue() {
    queueList.innerHTML = "";

    if (songs.length === 0) {
        queueList.innerHTML = '<div class="queue-empty">Search a song to get started</div>';
        return;
    }

    const nowLabel = document.createElement("div");
    nowLabel.className = "queue-section-label";
    nowLabel.textContent = "NOW PLAYING";
    queueList.appendChild(nowLabel);

    const d1 = document.createElement("div");
    d1.className = "queue-divider";
    queueList.appendChild(d1);

    if (current >= 0 && current < songs.length) {
        const s = songs[current];
        const item = document.createElement("div");
        item.className = "queue-item active";
        item.innerHTML = `
            <img src="${s.image}" alt="${s.title}" onerror="this.src='https://via.placeholder.com/58x58/333/fff?text=♪'">
            <div class="queue-item-info">
                <div class="queue-item-title">${s.title}</div>
                <div class="queue-item-artist">${s.artist}</div>
            </div>
        `;
        item.onclick = () => selectSong(current);
        queueList.appendChild(item);
    }

    const d2 = document.createElement("div");
    d2.className = "queue-divider";
    queueList.appendChild(d2);

    if (songs.length > 1) {
        const nextLabel = document.createElement("div");
        nextLabel.className = "queue-section-label next-up";
        nextLabel.textContent = "NEXT UP";
        queueList.appendChild(nextLabel);

        const d3 = document.createElement("div");
        d3.className = "queue-divider";
        queueList.appendChild(d3);

        let count = 0;
        let smartHeadingShown = false;
        for (let idx = 0; idx < songs.length && count < 10; idx++) {
            if (idx === current) continue;
            const s = songs[idx];
            if (s.smartRecommended && !smartHeadingShown) {
                const smartLabel = document.createElement("div");
                smartLabel.className = "queue-section-label smart-label";
                smartLabel.textContent = "SMART SHUFFLE";
                queueList.appendChild(smartLabel);
                smartHeadingShown = true;
            }
            const item = document.createElement("div");
            item.className = "queue-item";
            item.innerHTML = `
                <img src="${s.image}" alt="${s.title}" onerror="this.src='https://via.placeholder.com/58x58/333/fff?text=♪'">
                <div class="queue-item-info">
                    <div class="queue-item-title">${s.title}</div>
                    <div class="queue-item-artist">${s.artist}</div>
                </div>
                <button class="queue-remove-btn" title="Remove"><i class="fa-solid fa-xmark"></i></button>
            `;
            item.querySelector(".queue-remove-btn").onclick = e => { e.stopPropagation(); removeSong(idx); };
            item.onclick = () => selectSong(idx);
            queueList.appendChild(item);
            count++;
        }
    }
}

function removeSong(index) {
    if (!Number.isInteger(index) || index < 0 || index >= songs.length) {
        return;
    }

    const removedCurrent = index === current;
    songs.splice(index, 1);

    if (songs.length === 0) {
        current = 0;
        currentLyrics = [];
        currentLyricIndex = -1;
        stopLyricLoop();
        lyricInterval = null;
        stopProgressPoll();

        titleEl.textContent = "No song selected";
        artistEl.textContent = "Search for a song to begin";
        cover.removeAttribute("src");
        icon.classList.remove("fa-pause");
        icon.classList.add("fa-play");
        isPlaying = false;

        updateCarousel();
        renderQueue();
        return;
    }

    // Keep the same track selected when removing a track before it.
    if (index < current) {
        current -= 1;
    } else if (removedCurrent) {
        // Select the item that moved into this index, or the new last item.
        current = Math.min(index, songs.length - 1);
    }

    updateCarousel();
    renderQueue();

    // If the active track was removed, switch playback to the replacement.
    if (removedCurrent) {
        loadSong();
    }
}

function selectSong(index) {
    if (index < 0 || index >= songs.length) return;
    current = index;
    updateCarousel();
    loadSong();
    renderQueue();
}


// COLOR EXTRACTION & VISUALS

function extractColors(img) {

    try {

        const palette =
            colorThief.getPalette(img, 2);

        if (
            palette &&
            palette.length >= 2
        ) {

            dynamicColors.dominant =
                palette[0];

            dynamicColors.secondary =
                palette[1];

            const [r, g, b] =
                palette[0];

            
            document.documentElement.style.setProperty(
                "--lyric-glow",
                `${r}, ${g}, ${b}`
            );

            
            const brightR =
                Math.min(r + 80, 255);

            const brightG =
                Math.min(g + 80, 255);

            const brightB =
                Math.min(b + 80, 255);

            document.documentElement.style.setProperty(
                "--lyric-color",
                `rgb(${brightR}, ${brightG}, ${brightB})`
            );

            applyDynamicColors();
        }

    } catch (e) {

        console.warn(
            "Color Thief error:",
            e
        );

    }
}

function applyDynamicColors() {
    if (!dynamicColors.dominant || !dynamicColors.secondary) return;
    const [r1, g1, b1] = dynamicColors.dominant;
    const [r2, g2, b2] = dynamicColors.secondary;

    const bgOverlay = `radial-gradient(circle at 50% 40%, 
        rgba(${r1},${g1},${b1},0.18) 0%,
        rgba(${r2},${g2},${b2},0.12) 30%,
        rgba(${Math.floor(r1 * 0.4)},${Math.floor(g1 * 0.4)},${Math.floor(b1 * 0.4)},0.8) 60%,
        rgba(0,0,0,0.6) 100%)`;

    bgElement.style.transition = "background 2s ease";
    bgElement.style.backgroundImage = `${bgOverlay}, url(${bgElement.imageUrl || ""})`;
    bgElement.style.backgroundSize = "100% 100%, cover";
    bgElement.style.backgroundPosition = "center, center";
    bgElement.style.filter = "blur(18px)";

    if (cardElements[1]) {
        cardElements[1].style.transition = "box-shadow 1.5s ease";
        cardElements[1].style.boxShadow = `
            0 50px 100px rgba(0,0,0,0.55),
            0 0 80px rgba(${r1},${g1},${b1},0.3),
            0 0 120px rgba(${r2},${g2},${b2},0.15),
            inset 0 1px 3px rgba(255,255,255,0.5),
            inset 0 -2px 5px rgba(0,0,0,0.2)`;
        const ci = cardElements[1].querySelector("img");
        if (ci) ci.style.filter = `drop-shadow(0 0 50px rgba(${r1},${g1},${b1},0.35)) drop-shadow(0 0 80px rgba(${r2},${g2},${b2},0.15))`;
    }

    const aq = document.querySelector(".queue-item.active");
    if (aq) {
        aq.style.transition = "all 1.5s ease";
        aq.style.boxShadow = `
            0 12px 28px rgba(0,0,0,.2),
            0 0 25px rgba(${r1},${g1},${b1},.3),
            inset 0 1px 2px rgba(255,255,255,.4),
            inset 0 -1px 2px rgba(0,0,0,.1)`;
        const ai = aq.querySelector("img");
        if (ai) ai.style.filter = `drop-shadow(0 0 12px rgba(${r1},${g1},${b1},.4))`;
    }
}

function setBackground(img) {
    bgElement.style.transition = "background 2s ease, filter 2s ease";
    bgElement.imageUrl = img.src;
    bgElement.style.backgroundImage = `url(${img.src})`;
    bgElement.style.backgroundSize = "cover";
    bgElement.style.backgroundPosition = "center";
    bgElement.style.filter = "blur(18px)";
}



// LYRICS SYSTEM


function parseLRC(lrcText) {
    const lines = [];
    const lineStamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const wordStamp = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

    const toSeconds = (m, s, f = "0") =>
        Number(m) * 60 + Number(s) + Number(`0.${f}`);

    for (const raw of lrcText.split(/\r?\n/)) {
        const lineMatches = [...raw.matchAll(lineStamp)];
        if (!lineMatches.length) continue;
        const lineTime = toSeconds(lineMatches[0][1], lineMatches[0][2], lineMatches[0][3] || "0");
        const body = raw.replace(lineStamp, "").trim();
        if (!body) continue;

        // Enhanced LRC (ELRC): word timestamps appear inline as <mm:ss.xx>.
        const tokens = [];
        let lastTime = lineTime;
        const matches = [...body.matchAll(wordStamp)];
        if (matches.length) {
            let cursor = 0;
            for (const match of matches) {
                const before = body.slice(cursor, match.index).trim();
                const stamp = toSeconds(match[1], match[2], match[3] || "0");
                if (before) tokens.push({ text: before, time: lastTime, end: stamp });
                lastTime = stamp;
                cursor = match.index + match[0].length;
            }
            const tail = body.slice(cursor).trim();
            if (tail) tokens.push({ text: tail, time: lastTime, end: null });
        } else {
            // Plain LRC fallback: word timing is estimated from the line window.
            const words = body.split(/\s+/).filter(Boolean);
            if (words.length) words.forEach((text, i) => tokens.push({
                text, time: lineTime, end: null, estimatedIndex: i, estimatedCount: words.length
            }));
        }

        for (const stamp of lineMatches) {
            lines.push({
                time: toSeconds(stamp[1], stamp[2], stamp[3] || "0"),
                text: body.replace(wordStamp, "").trim(),
                words: tokens.map(w => ({ ...w }))
            });
        }
    }

    lines.sort((a, b) => a.time - b.time);
    // Complete missing word ends using the next word timestamp, then next line.
    lines.forEach((line, i) => {
        const nextLineTime = lines[i + 1]?.time ?? (currentDuration ? currentDuration / 1000 : line.time + 5);
        if (line.words.some(w => w.estimatedCount)) {
            const count = line.words.length;
            const span = Math.max(0.1, nextLineTime - line.time);
            const weights = line.words.map(w => [...w.text].length + 1);
            const total = weights.reduce((a, b) => a + b, 0);
            let acc = 0;
            line.words.forEach((w, wi) => {
                w.time = line.time + span * acc / total;
                acc += weights[wi];
                w.end = line.time + span * acc / total;
            });
        } else {
            line.words.forEach((w, wi) => {
                w.end = w.end ?? line.words[wi + 1]?.time ?? nextLineTime;
            });
        }
    });
    return lines;
}

// Poll samples only correct the clock when it has really drifted, so small
// SDK jitter doesn't make lyrics jump back and forth.
function samplePosition(pos, stamp) {
    if (isPlaying) {
        const predicted = currentPosition + (stamp - positionStamp);
        if (Math.abs(pos - predicted) < 120) return;
    }
    currentPosition = pos;
    positionStamp = stamp;
}

// Lyrics are shown slightly early to cancel SDK + render latency. Tune live with [ and ].
let lyricOffsetMs = Number(localStorage.getItem("lyricOffsetMs") ?? 250);

function getLivePosition() {
    if (!isPlaying) return currentPosition + lyricOffsetMs;
    const live = currentPosition + (performance.now() - positionStamp) + lyricOffsetMs;
    return currentDuration ? Math.min(live, currentDuration) : live;
}

function updateCurrentLyric() {
    if (!currentLyrics.length) return;
    const now = getLivePosition() / 1000;
    let activeIndex = -1;
    for (let i = 0; i < currentLyrics.length; i++) {
        if (currentLyrics[i].time <= now) activeIndex = i;
        else break;
    }

    const el = document.getElementById("current-lyric");
    if (!el) return;
    if (activeIndex < 0) {
        currentLyricIndex = -1;
        el.textContent = "";
        el.classList.remove("show");
        return;
    }

    currentLyricIndex = activeIndex;
    const line = currentLyrics[activeIndex];
    if (el.dataset.lineIndex !== String(activeIndex)) {
        el.dataset.lineIndex = String(activeIndex);
        el.innerHTML = line.words.map(word => {
            const safe = escapeLyricHTML(word.text);
            const duration = Math.max(60, (word.end - word.time) * 1000);
            return `<span class="lyric-word" data-start="${word.time}" data-end="${word.end}">${[...safe].map((ch, i) =>
                `<span class="lyric-letter" style="--letter-duration:${Math.max(45, duration / Math.max(1, [...safe].length))}ms;--letter-delay:${i * duration / Math.max(1, [...safe].length)}ms">${ch === " " ? "&nbsp;" : ch}</span>`
            ).join("")}</span> `;
        }).join("");
        el.classList.add("show");
    }

    // Drive reveal from the playback clock. No old full-line gradient sweep.
    el.querySelectorAll(".lyric-word").forEach(wordEl => {
        const st = Number(wordEl.dataset.start);
        const en = Number(wordEl.dataset.end);
        const progress = Math.max(0, Math.min(1, (now - st) / Math.max(0.05, en - st)));
        wordEl.style.setProperty("--word-progress", `${progress * 100}%`);
        wordEl.classList.toggle("word-current", now >= st && now < en);
        wordEl.querySelectorAll(".lyric-letter").forEach((letter, i, all) => {
            const local = Math.max(0, Math.min(1, progress * all.length - i));
            letter.style.opacity = String(0.34 + local * 0.66);
            letter.style.transform = `translateY(${-2 * local}px)`;
        });
    });
}

function escapeLyricHTML(value) {
    // Lyrics providers sometimes return text that is already HTML-encoded
    // (occasionally double-encoded, e.g. &amp;#39;). Decode entities as text
    // before escaping once for safe insertion into the lyric markup.
    const decoder = document.createElement("textarea");
    let decoded = String(value ?? "");
    for (let i = 0; i < 2; i++) {
        decoder.innerHTML = decoded;
        const next = decoder.value;
        if (next === decoded) break;
        decoded = next;
    }
    return decoded.replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
}

function stopLyricLoop() {
    if (lyricRaf) cancelAnimationFrame(lyricRaf);
    lyricRaf = null;
    clearInterval(lyricInterval);
    lyricInterval = null;
}

function syncLyrics(lyrics) {
    stopLyricLoop();
    currentLyrics = lyrics;
    const tick = () => {
        updateCurrentLyric();
        lyricRaf = requestAnimationFrame(tick);
    };
    lyricRaf = requestAnimationFrame(tick);
}

function showLyric(element, text) {

    element.classList.remove("show");

    setTimeout(() => {

        element.textContent = text;

        element.classList.remove("hide");
        element.classList.add("show");

    }, 200);
}

// LYRIC OFFSET HOTKEYS: "]" shows lyrics earlier, "[" shows them later.
document.addEventListener("keydown", e => {
    if (e.target.matches?.("input, textarea")) return;
    if (e.key !== "[" && e.key !== "]") return;
    lyricOffsetMs += e.key === "]" ? 50 : -50;
    localStorage.setItem("lyricOffsetMs", String(lyricOffsetMs));
    let t = document.getElementById("lyric-offset-toast");
    if (!t) {
        t = document.createElement("div");
        t.id = "lyric-offset-toast";
        t.style.cssText = "position:fixed;left:1.5cm;bottom:24px;z-index:1000;color:#fff;font:14px sans-serif;background:rgba(0,0,0,.55);padding:6px 12px;border-radius:999px;pointer-events:none;transition:opacity .3s";
        document.body.appendChild(t);
    }
    t.textContent = `Lyric offset: ${lyricOffsetMs > 0 ? "+" : ""}${lyricOffsetMs} ms`;
    t.style.opacity = "1";
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.style.opacity = "0"), 1200);
});

// BOOT

initAuth();
