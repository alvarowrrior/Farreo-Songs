'use strict';

// A lightweight, file-backed catalogue of YouTube tracks. No audio file or
// short-lived Googlevideo URL is written to disk.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const execFileAsync = promisify(execFile);
const { createYouTubeLyricsResolver, identifySong } = require('./youtubeLyrics');

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const AUDIO_FORMAT = 'bestaudio[protocol^=http][ext=m4a]/bestaudio[protocol^=http]/bestaudio';
// A resolved googlevideo URL is ephemeral, but 3 minutes forces frequent
// unnecessary yt-dlp startups. Reuse it for up to 12 minutes, never past its
// own signed expiration (with a safety margin). 401/403/410 still force refresh.
const RESOLVE_TTL_MS = 12 * 60_000;
const URL_EXPIRY_MARGIN_MS = 90_000;
const PREFETCH_MAX_QUEUED = 4;
const PREFETCH_COOLDOWN_MS = 30_000;
const MAX_CAPTIONS = 128 * 1024;
const MEDIA_HEADER_NAMES = ['user-agent', 'referer', 'origin', 'accept', 'accept-language', 'cookie'];
const MEDIA_RESPONSE_HEADERS = ['content-range', 'content-length', 'accept-ranges', 'content-type', 'etag', 'last-modified'];
const MEDIA_REQUEST_TIMEOUT_MS = 65_000;

function parseYouTubeVideoId(input) {
  try {
    const value = String(input || '').trim();
    if (VIDEO_ID.test(value)) return value;
    if (value.length > 2048) return null;
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let candidate = '';
    if (host === 'youtu.be') {
      candidate = parsed.pathname.split('/')[1] || '';
    } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (parsed.pathname === '/watch') candidate = parsed.searchParams.get('v') || '';
      else if (['shorts', 'embed', 'live'].includes(segments[0])) candidate = segments[1] || '';
    }
    return VIDEO_ID.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function safeRead(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[youtube-tracks] invalid catalogue:', error.message);
    return {};
  }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function stripVttMarkup(vtt) {
  return vtt
    .replace(/^WEBVTT[^\n]*\n?/i, '')
    .replace(/<\/?(?:c|v|lang)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

async function tryCaptions(info) {
  // Subtitles are optional. They are not guaranteed to be lyrics; prefer the
  // creator's manually provided timings to automatic speech recognition.
  const sources = [info.subtitles, info.automatic_captions];
  for (const entries of sources) {
    if (!entries || typeof entries !== 'object') continue;
    const languages = Object.keys(entries);
    const preferred = ['es', 'es-ES', 'es-orig', 'en', 'en-US', 'en-orig'];
    const candidates = [
      ...preferred.filter(language => languages.includes(language)),
      ...languages.filter(language => /^es[-_]|^en[-_]/i.test(language)),
    ];
    for (const language of [...new Set(candidates)].slice(0, 2)) {
      const formats = Array.isArray(entries[language]) ? entries[language] : [];
      const captions = formats.find(item => item.ext === 'vtt' && /^https:\/\//i.test(item.url || ''));
      if (!captions) continue;
      try {
        const response = await fetch(captions.url, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength === 0 || buffer.byteLength > MAX_CAPTIONS) continue;
        const text = stripVttMarkup(new TextDecoder().decode(buffer));
        if (text.includes('-->') && text.length < MAX_CAPTIONS) return text;
      } catch {
        // Captions can be region-locked, unavailable or time-expired.
      }
    }
  }
  return null;
}

function createYouTubeSongCatalog(baseDir) {
  const cataloguePath = path.join(baseDir, 'youtube-tracks.json');
  const backgroundsPath = path.join(baseDir, 'youtube-backgrounds.json');
  const cachedStreams = new Map();
  const pendingImports = new Map();
  const pendingResolves = new Map();
  const pendingLyrics = new Map();
  // Prefetch URL metadata only, never media bytes. Bounded background work
  // prevents opening a playlist from launching many yt-dlp processes.
  const pendingPrewarms = [];
  const recentPrewarms = new Map();
  let prewarmWorkerActive = false;
  const lyricsResolver = createYouTubeLyricsResolver();
  let onSongMetadataUpdate = null;

  const store = () => safeRead(cataloguePath);
  const getEntry = (videoId) => store()[videoId] || null;
  const canonicalUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
  const ytDlp = String(process.env.YT_DLP_BIN || 'yt-dlp').trim() || 'yt-dlp';

  function rememberAudioStream(videoId, info) {
    const url = typeof info.url === 'string' ? info.url : '';
    if (!/^https:\/\//i.test(url)) return null;
    const stream = {
      url,
      httpHeaders: info.http_headers && typeof info.http_headers === 'object' ? info.http_headers : {},
      ext: String(info.ext || 'm4a'),
    };
    // Prefer the signature's actual expiry where the provider exposes one.
    let expiresAt = Date.now() + RESOLVE_TTL_MS;
    try {
      const signedExpiry = Number(new URL(url).searchParams.get('expire'));
      if (Number.isFinite(signedExpiry) && signedExpiry > 1_000_000_000) {
        expiresAt = Math.min(expiresAt, signedExpiry * 1000 - URL_EXPIRY_MARGIN_MS);
      }
    } catch { /* Keep the conservative TTL. */ }
    // Never persisted; old signatures are transparently refreshed on 403.
    cachedStreams.set(videoId, { stream, expiresAt });
    if (cachedStreams.size > 100) cachedStreams.delete(cachedStreams.keys().next().value);
    return stream;
  }

  async function extract(videoId) {
    const args = [
      '--no-playlist', '--no-warnings', '--no-progress',
      '--dump-single-json', '--format', AUDIO_FORMAT, canonicalUrl(videoId),
    ];
    let stdout;
    try {
      ({ stdout } = await execFileAsync(ytDlp, args, {
        timeout: 45_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      }));
    } catch (error) {
      const absent = error.code === 'ENOENT';
      const detail = absent ? 'yt-dlp no esta instalado en el servidor.' : 'YouTube no permite resolver este video ahora mismo.';
      const failure = new Error(detail);
      failure.statusCode = absent ? 503 : 502;
      console.warn('[youtube-tracks] yt-dlp:', String(error.stderr || error.message).slice(0, 600));
      throw failure;
    }
    let parsed;
    try { parsed = JSON.parse(String(stdout || '')); }
    catch { throw Object.assign(new Error('Respuesta invalida de yt-dlp.'), { statusCode: 502 }); }
    if (parsed.id !== videoId) throw Object.assign(new Error('El video resuelto no coincide con el solicitado.'), { statusCode: 502 });
    return parsed;
  }

  function toSong(entry) {
    return {
      id: `youtube:${entry.videoId}`,
      name: entry.title,
      url: `/youtube-tracks/${entry.videoId}/audio`,
      provider: 'youtube',
      youtubeUrl: canonicalUrl(entry.videoId),
      variantes: [],
      iconUrl: `https://i.ytimg.com/vi/${entry.videoId}/hqdefault.jpg`,
      advancedCoverUrl: null,
      advancedCoverType: null,
      duration: entry.duration,
      lyricsSrt: entry.lyricsSrt || null,
      staticLyrics: entry.staticLyrics || null,
      lyricsUrl: null,
      lyricsSource: entry.lyricsSource || (entry.lyricsSrt ? 'youtube-captions' : null),
      lyricsStatus: entry.lyricsSrt ? 'synced' : entry.staticLyrics ? 'static' : (entry.lyricsLookup?.status || 'pending'),
      lyricArtist: entry.artist || '',
      lyricTrack: entry.track || '',
      createdAt: { seconds: Math.floor(new Date(entry.createdAt).getTime() / 1000) || 0, nanoseconds: 0 },
    };
  }

  function ensureVideoBackground(videoId) {
    const songId = `youtube:${videoId}`;
    const stored = safeRead(backgroundsPath);
    if (stored[songId]?.youtubeUrl === canonicalUrl(videoId)) return;
    if (stored[songId]?.youtubeUrl) return; // Respect any explicit association.
    stored[songId] = { youtubeUrl: canonicalUrl(videoId), updatedAt: new Date().toISOString() };
    atomicWrite(backgroundsPath, stored);
  }

  function isLyricsLookupDue(entry) {
    if (!entry || !Number(entry.duration)) return false;
    const lookup = entry.lyricsLookup;
    if (!lookup) return true; // Existing imports made before this feature.
    if (lookup.status === 'synced' || lookup.status === 'static') return false;
    return Date.now() >= (Number(lookup.retryAt) || 0);
  }

  async function refreshLyrics(videoId, { force = false, metadata = null } = {}) {
    if (!VIDEO_ID.test(videoId)) return null;
    const pending = pendingLyrics.get(videoId);
    if (pending) return pending;
    const entry = getEntry(videoId);
    if (!entry) return null;
    if (!force && !isLyricsLookupDue(entry)) return toSong(entry);
    const initialTitle = entry.title;
    const initialArtist = entry.artist;
    const initialTrack = entry.track;
    const meta = {
      ...(metadata || {}),
      title: entry.title,
      artist: entry.artist || metadata?.artist || '',
      track: entry.track || metadata?.track || '',
      album: entry.album || metadata?.album || '',
      uploader: metadata?.uploader || '',
    };
    const promise = (async () => {
      try {
        const lyrics = await lyricsResolver.resolve(meta, Number(entry.duration));
        const nextEntries = store();
        const current = nextEntries[videoId];
        if (!current) return null; // Deleted while the external request was pending.
        if (current.title !== initialTitle || current.artist !== initialArtist || current.track !== initialTrack) {
          return toSong(current); // An admin edited the metadata mid-request.
        }
        current.artist = current.artist || lyrics.artist || '';
        current.track = current.track || lyrics.track || '';
        current.album = current.album || lyrics.album || '';
        if (lyrics.lyricsSrt) {
          current.lyricsSrt = lyrics.lyricsSrt; // Prefer verified timed song lyrics to captions.
          current.lyricsSource = lyrics.source;
        }
        if (lyrics.staticLyrics) {
          current.staticLyrics = lyrics.staticLyrics;
          if (!current.lyricsSrt) current.lyricsSource = lyrics.source;
        }
        current.lyricsLookup = {
          status: lyrics.status,
          source: lyrics.source,
          checkedAt: lyrics.checkedAt,
          retryAt: lyrics.retryAt,
        };
        atomicWrite(cataloguePath, nextEntries);
        const song = toSong(current);
        if (typeof onSongMetadataUpdate === 'function') onSongMetadataUpdate(song);
        return song;
      } catch (error) {
        console.warn('[youtube-tracks] lyrics lookup:', error.message || error);
        // A provider failure must never stop song imports or playback.
        const nextEntries = store();
        if (nextEntries[videoId]) {
          nextEntries[videoId].lyricsLookup = {
            status: 'retry', source: null, checkedAt: new Date().toISOString(),
            retryAt: Date.now() + 90 * 60_000,
          };
          atomicWrite(cataloguePath, nextEntries);
        }
        return getEntry(videoId) ? toSong(getEntry(videoId)) : null;
      }
    })().finally(() => pendingLyrics.delete(videoId));
    pendingLyrics.set(videoId, promise);
    return promise;
  }

  function scheduleLyricsEnrichment(songIds) {
    // Non-blocking backfill for already imported tracks. Never make a playlist
    // or radio request wait for a third-party lyrics provider.
    let queued = 0;
    for (const id of songIds) {
      if (queued >= 4) break;
      const videoId = String(id).replace(/^youtube:/, '');
      if (!VIDEO_ID.test(videoId) || pendingLyrics.has(videoId)) continue;
      const entry = getEntry(videoId);
      if (entry && isLyricsLookupDue(entry)) {
        queued += 1;
        void refreshLyrics(videoId);
      }
    }
  }

  async function importUrl(input) {
    const videoId = parseYouTubeVideoId(input);
    if (!videoId) throw Object.assign(new Error('Pega una URL valida de YouTube.'), { statusCode: 400 });
    const previous = getEntry(videoId);
    if (previous?.duration > 0) {
      ensureVideoBackground(videoId);
      // Re-pasting an old link also completes its previously missing lyrics.
      const song = await refreshLyrics(videoId) || toSong(previous);
      return { song, imported: false };
    }
    if (pendingImports.has(videoId)) return pendingImports.get(videoId);
    const promise = (async () => {
      const info = await extract(videoId);
      const duration = Number(info.duration);
      if (!Number.isFinite(duration) || duration <= 0 || info.is_live) {
        throw Object.assign(new Error('No es una cancion o video de duracion conocida.'), { statusCode: 422 });
      }
      const identified = identifySong(info);
      const entry = {
        videoId,
        title: String(info.title || `YouTube ${videoId}`).trim().slice(0, 220),
        artist: identified.artist,
        track: identified.track,
        album: identified.album,
        duration,
        createdAt: new Date().toISOString(),
        lyricsSrt: await tryCaptions(info),
      };
      // Reuse this extract for immediate playback, without saving the expiring URL.
      rememberAudioStream(videoId, info);
      // Re-read after extraction so simultaneous imports of different videos
      // cannot overwrite each other with stale catalogue contents.
      const entries = store();
      if (!entries[videoId]) entries[videoId] = entry;
      atomicWrite(cataloguePath, entries);
      ensureVideoBackground(videoId);
      const song = await refreshLyrics(videoId, { metadata: info }) || toSong(entries[videoId]);
      return { song, imported: true };
    })().finally(() => pendingImports.delete(videoId));
    pendingImports.set(videoId, promise);
    return promise;
  }

  async function resolveAudio(videoId, force = false) {
    const cached = cachedStreams.get(videoId);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.stream;
    if (!force && pendingResolves.has(videoId)) return pendingResolves.get(videoId);
    const promise = (async () => {
      const info = await extract(videoId);
      const url = typeof info.url === 'string' ? info.url : '';
      if (!/^https:\/\//i.test(url)) {
        throw Object.assign(new Error('YouTube no ofrece una pista de audio HTTP reproducible.'), { statusCode: 502 });
      }
      // yt-dlp provides the CDN URL and any required origin headers.
      return rememberAudioStream(videoId, info);
    })().finally(() => pendingResolves.delete(videoId));
    if (!force) pendingResolves.set(videoId, promise);
    return promise;
  }

  // Bounded, coalesced prewarm: only resolve an audio URL in advance.
  // Playlist loads are never held up by yt-dlp, and no media is downloaded.
  function queueAudioPrewarm(songIds) {
    if (!Array.isArray(songIds)) return;
    for (const rawId of songIds.slice(0, PREFETCH_MAX_QUEUED)) {
      const videoId = String(rawId || '').replace(/^youtube:/, '');
      if (!VIDEO_ID.test(videoId) || !getEntry(videoId)) continue;
      if (cachedStreams.get(videoId)?.expiresAt > Date.now()) continue;
      if (pendingResolves.has(videoId) || pendingPrewarms.includes(videoId)) continue;
      if (Date.now() - (recentPrewarms.get(videoId) || 0) < PREFETCH_COOLDOWN_MS) continue;
      if (pendingPrewarms.length >= PREFETCH_MAX_QUEUED) break;
      pendingPrewarms.push(videoId);
      recentPrewarms.set(videoId, Date.now());
    }
    if (recentPrewarms.size > 150) {
      for (const [key, time] of recentPrewarms) {
        if (Date.now() - time > PREFETCH_COOLDOWN_MS) recentPrewarms.delete(key);
      }
    }
    if (prewarmWorkerActive || pendingPrewarms.length === 0) return;
    prewarmWorkerActive = true;
    setImmediate(async () => {
      try {
        while (pendingPrewarms.length) {
          const id = pendingPrewarms.shift();
          if (!getEntry(id) || cachedStreams.get(id)?.expiresAt > Date.now()) continue;
          try { await resolveAudio(id); }
          catch (error) {
            // Prefetch is best-effort; normal playback can retry immediately.
            console.warn('[youtube-tracks] prewarm skipped:', id, error.message);
          }
        }
      } finally {
        prewarmWorkerActive = false;
      }
    });
  }

  function mediaRequestHeaders(stream, range) {
    const headers = { 'Accept-Encoding': 'identity' };
    for (const [key, value] of Object.entries(stream.httpHeaders)) {
      if (MEDIA_HEADER_NAMES.includes(key.toLowerCase()) && typeof value === 'string' && !/[\r\n]/.test(value)) {
        headers[key] = value;
      }
    }
    if (range) headers.Range = range;
    return headers;
  }

  async function openAudioStream(videoId, range, signal, fresh = false) {
    // Media3 and browsers request different byte ranges as playback moves.
    // A range request must reach the origin unchanged to make seeking work.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resolveStart = performance.now();
      const stream = await resolveAudio(videoId, fresh || attempt > 0);
      const resolveMs = performance.now() - resolveStart;
      const originStart = performance.now();
      const upstream = await fetch(stream.url, {
        method: 'GET',
        headers: mediaRequestHeaders(stream, range),
        redirect: 'follow',
        signal,
      });
      if ([401, 403, 410].includes(upstream.status) && attempt === 0) {
        await upstream.body?.cancel().catch(() => undefined);
        cachedStreams.delete(videoId);
        continue; // Expired CDN signature: ask yt-dlp for a fresh URL.
      }
      return { upstream, ext: stream.ext, resolveMs, originMs: performance.now() - originStart };
    }
    throw Object.assign(new Error('No se pudo abrir el audio de YouTube.'), { statusCode: 502 });
  }

  function listEntries() {
    return Object.values(store())
      .filter(entry => entry && VIDEO_ID.test(entry.videoId) && Number(entry.duration) > 0)
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  }

  function getSongById(songId) {
    const videoId = String(songId || '').startsWith('youtube:')
      ? String(songId).slice('youtube:'.length)
      : null;
    if (!videoId || !VIDEO_ID.test(videoId)) return null;
    const entry = getEntry(videoId);
    if (entry) scheduleLyricsEnrichment([videoId]);
    if (entry && Number(entry.duration) > 0) queueAudioPrewarm([videoId]);
    return entry && Number(entry.duration) > 0 ? toSong(entry) : null;
  }

  function findSongsByIds(songIds) {
    if (!Array.isArray(songIds)) return [];
    const records = store();
    const seen = new Set();
    scheduleLyricsEnrichment(songIds);
    // The first tracks are most likely to be played. Begin resolving their
    // signed audio URLs immediately without delaying the lookup response.
    queueAudioPrewarm(songIds.filter(id => String(id).startsWith('youtube:')).slice(0, 2));
    return songIds.flatMap(input => {
      const id = String(input || '');
      if (!id.startsWith('youtube:')) return [];
      const videoId = id.slice('youtube:'.length);
      if (!VIDEO_ID.test(videoId) || seen.has(videoId)) return [];
      seen.add(videoId);
      const entry = records[videoId];
      return entry && Number(entry.duration) > 0 ? [toSong(entry)] : [];
    });
  }

  function registerRoutes(app, { requireAdmin, onDelete, onUpdate } = {}) {
    onSongMetadataUpdate = onUpdate;
    if (typeof requireAdmin !== 'function') {
      throw new Error('Los endpoints de administracion de YouTube requieren requireAdmin.');
    }
    // Only explicit song IDs can resolve private/external tracks; none of the
    // ordinary discovery/catalogue endpoints exposes YouTube songs.
    app.post('/youtube-tracks/lookup', (req, res) => {
      if (!Array.isArray(req.body?.songIds)) {
        return res.status(400).json({ error: 'Se requiere una lista de identificadores.' });
      }
      return res.json({ songs: findSongsByIds(req.body.songIds) });
    });

    app.get('/admin/youtube-tracks', requireAdmin, (req, res) => {
      res.set('Cache-Control', 'no-store');
      return res.json({ songs: listEntries().map(toSong) });
    });

    app.patch('/admin/youtube-tracks/:videoId', requireAdmin, (req, res) => {
      const { videoId } = req.params;
      if (!VIDEO_ID.test(videoId) || !getEntry(videoId)) {
        return res.status(404).json({ error: 'Cancion de YouTube no encontrada.' });
      }
      const title = String(req.body?.title || '').trim();
      const duration = Number(req.body?.duration);
      if (!title || title.length > 220 || !Number.isFinite(duration) || duration <= 0 || duration > 12 * 3600) {
        return res.status(400).json({ error: 'Introduce un titulo y una duracion validos.' });
      }
      const artist = String(req.body?.artist ?? '').trim();
      const track = String(req.body?.track ?? '').trim();
      if (artist.length > 160 || track.length > 180) {
        return res.status(400).json({ error: 'Artista o titulo musical demasiado largo.' });
      }
      const entries = store();
      const previous = entries[videoId];
      const updatedArtist = 'artist' in (req.body || {}) ? artist : (previous.artist || '');
      const updatedTrack = 'track' in (req.body || {}) ? track : (previous.track || '');
      const shouldRescan = previous.title !== title || previous.duration !== duration ||
        previous.artist !== updatedArtist || previous.track !== updatedTrack;
      entries[videoId] = { ...previous, title, duration, artist: updatedArtist, track: updatedTrack };
      if (shouldRescan) {
        delete entries[videoId].lyricsLookup; // New metadata can resolve different lyrics.
        if (previous.lyricsSource && previous.lyricsSource !== 'youtube-captions') {
          entries[videoId].lyricsSrt = null;
          entries[videoId].staticLyrics = null;
          entries[videoId].lyricsSource = null;
        }
      }
      atomicWrite(cataloguePath, entries);
      const song = toSong(entries[videoId]);
      if (onUpdate) onUpdate(song);
      if (shouldRescan) scheduleLyricsEnrichment([videoId]);
      return res.json({ song });
    });

    app.post('/admin/youtube-tracks/:videoId/lyrics/refresh', requireAdmin, async (req, res) => {
      const { videoId } = req.params;
      if (!VIDEO_ID.test(videoId) || !getEntry(videoId)) {
        return res.status(404).json({ error: 'Cancion de YouTube no encontrada.' });
      }
      const song = await refreshLyrics(videoId, { force: true });
      return res.json({ song });
    });

    app.delete('/admin/youtube-tracks/:videoId', requireAdmin, (req, res) => {
      const { videoId } = req.params;
      if (!VIDEO_ID.test(videoId) || !getEntry(videoId)) {
        return res.status(404).json({ error: 'Cancion de YouTube no encontrada.' });
      }
      const entries = store();
      delete entries[videoId];
      atomicWrite(cataloguePath, entries);
      cachedStreams.delete(videoId);
      const backgrounds = safeRead(backgroundsPath);
      const songId = `youtube:${videoId}`;
      if (backgrounds[songId]?.youtubeUrl === canonicalUrl(videoId)) {
        delete backgrounds[songId];
        atomicWrite(backgroundsPath, backgrounds);
      }
      if (onDelete) onDelete(songId);
      return res.json({ deleted: true, songId });
    });

    app.post('/youtube-tracks/import', async (req, res) => {
      try {
        const result = await importUrl(req.body?.url);
        res.status(result.imported ? 201 : 200).json(result);
      } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message || 'No se pudo importar el video.' });
      }
    });
    app.get('/youtube-tracks/:videoId/audio', async (req, res) => {
      const videoId = req.params.videoId;
      if (!VIDEO_ID.test(videoId) || !getEntry(videoId)) {
        return res.status(404).json({ error: 'Cancion de YouTube desconocida.' });
      }

      // A redirect to googlevideo.com bypasses the backend's CORS headers and
      // breaks Farreo's crossOrigin=anonymous audio element. Instead, proxy
      // bytes directly, with backpressure and no persistent media storage.
      const range = req.headers.range;
      if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
        return res.status(416).json({ error: 'Rango de audio no valido.' });
      }

      const controller = new AbortController();
      const onClose = () => controller.abort();
      res.once('close', onClose);
      let timedOut = false;
      let timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, MEDIA_REQUEST_TIMEOUT_MS);

      try {
        const { upstream, ext, resolveMs, originMs } = await openAudioStream(videoId, range, controller.signal, req.query.fresh === '1');
        clearTimeout(timeout); // The timeout applies to connection/headers only.
        timeout = null;
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel().catch(() => undefined);
          console.warn(`[youtube-tracks] upstream audio ${upstream.status} for ${videoId}`);
          return res.status(502).json({ error: 'La pista de YouTube no esta disponible para reproducirse.' });
        }

        res.status(upstream.status);
        res.set('Cache-Control', 'no-store, max-age=0');
        res.set('X-Farreo-Youtube-Proxy', '1');
        // Visible under DevTools > Network > Timing for diagnosing the rare
        // slow start. CDN first-byte transfer follows this initial header.
        res.set('Server-Timing', `youtube_resolve;dur=${resolveMs.toFixed(1)}, youtube_origin;dur=${originMs.toFixed(1)}`);
        res.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, X-Farreo-Youtube-Proxy, Server-Timing');
        for (const headerName of MEDIA_RESPONSE_HEADERS) {
          const value = upstream.headers.get(headerName);
          if (value) res.set(headerName, value);
        }
        if (!upstream.headers.has('content-type')) {
          res.type(ext === 'webm' ? 'audio/webm' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4');
        }
        // Node streams straight through to the client; it never downloads or
        // buffers the complete track in RAM or on the server's filesystem.
        await pipeline(Readable.fromWeb(upstream.body), res);
      } catch (error) {
        if (res.destroyed || error.code === 'ERR_STREAM_PREMATURE_CLOSE' || (controller.signal.aborted && !timedOut)) return;
        console.warn('[youtube-tracks] playback:', error.message || error);
        if (!res.headersSent) {
          res.status(timedOut ? 504 : (error.statusCode || 502)).json({ error: timedOut ? 'La conexion con YouTube ha tardado demasiado.' : 'No se pudo reproducir el audio de YouTube.' });
        } else {
          res.destroy(error);
        }
      } finally {
        if (timeout !== null) clearTimeout(timeout);
        res.off('close', onClose);
      }
    });
  }

  return {
    parseYouTubeVideoId,
    listSongs: () => listEntries().map(toSong),
    getSongById,
    findSongsByIds,
    registerRoutes,
    importUrl,
  };
}

module.exports = { createYouTubeSongCatalog, parseYouTubeVideoId };
