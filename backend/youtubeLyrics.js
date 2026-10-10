'use strict';

// Lyrics metadata resolver for external YouTube songs. Never downloads audio.
// Provider requests are serialized and the caller persists positive/negative
// results; the temporary Googlevideo addresses are not involved.

const MAX_LYRICS_BYTES = 160 * 1024;
const LOOKUP_RETRY_MS = 90 * 60_000;
const NEGATIVE_CACHE_MS = 7 * 24 * 60 * 60_000;
const USER_AGENT = 'FARREO/1.0 (https://farreo.vercel.app; lyrics metadata lookup)';

function cleanText(value, max = 180) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function removeVideoQualifiers(value) {
  return cleanText(value)
    .replace(/[\[(](?:official\s*)?(?:music\s*)?(?:video|audio|lyric\s*video|lyrics|visuali[sz]er|mv|mv\s*video|4k|hd|remastered\s*\d{4}|topic)[^\])]*[\])]/gi, '')
    .replace(/\s*[|•]\s*(?:official.*|lyrics.*|audio.*|video.*)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMatch(value) {
  return removeVideoQualifiers(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function identifySong(info) {
  const originalTitle = cleanText(info.title);
  let artist = cleanText(info.artist || info.creator);
  let track = cleanText(info.track);
  const split = removeVideoQualifiers(originalTitle).match(/^(.{2,90}?)\s+[\-–—]\s+(.{2,170})$/);
  if (split && !/^\d{1,2}:\d\d/.test(split[1])) {
    if (!artist) artist = cleanText(split[1]);
    if (!track) track = cleanText(split[2]);
  }
  if (!artist && / - Topic$/i.test(info.uploader || '')) {
    artist = cleanText(String(info.uploader).replace(/ - Topic$/i, ''));
  }
  if (!track) track = originalTitle;
  track = removeVideoQualifiers(track);
  artist = removeVideoQualifiers(artist);
  if (/^(?:various artists|unknown|n\/a|youtube|topic)$/i.test(artist)) artist = '';
  if (artist && track && normalizeMatch(track).startsWith(normalizeMatch(artist) + ' ')) {
    const splitTrack = track.match(/^.{2,90}?\s+[\-–—]\s+(.+)$/);
    if (splitTrack) track = removeVideoQualifiers(splitTrack[1]);
  }
  return {
    artist: artist.slice(0, 160),
    track: track.slice(0, 180),
    album: cleanText(info.album, 160),
  };
}

function formatSrtTime(total) {
  const milli = Math.max(0, Math.round(total * 1000));
  const hours = Math.floor(milli / 3_600_000);
  const minutes = Math.floor(milli / 60_000) % 60;
  const seconds = Math.floor(milli / 1000) % 60;
  const ms = milli % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function lrcToSrt(lrc, duration) {
  if (typeof lrc !== 'string' || Buffer.byteLength(lrc) > MAX_LYRICS_BYTES) return null;
  const lines = [];
  let offsetMs = 0;
  for (const raw of lrc.split(/\r?\n/)) {
    const offset = raw.match(/^\[offset:([+-]?\d+)\]/i);
    if (offset) { offsetMs = Math.max(-30000, Math.min(30000, Number(offset[1]))); continue; }
    const matches = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!matches.length) continue;
    const text = raw.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
      .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    for (const match of matches) {
      const fraction = match[3] ? Number('0.' + match[3]) : 0;
      const start = Number(match[1]) * 60 + Number(match[2]) + fraction + offsetMs / 1000;
      if (Number.isFinite(start) && start >= 0 && start < 43_200) lines.push({ start, text });
    }
  }
  lines.sort((a, b) => a.start - b.start);
  const distinct = lines.filter((cue, i) => i === 0 || Math.abs(cue.start - lines[i - 1].start) > 0.02);
  if (!distinct.length) return null;
  return distinct.map((cue, i) => {
    const next = distinct[i + 1];
    const naturalEnd = next ? next.start - 0.04 : cue.start + 7;
    const boundedEnd = duration > cue.start ? Math.min(naturalEnd, duration) : naturalEnd;
    const end = Math.max(cue.start + 0.15, boundedEnd);
    return `${i + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(end)}\n${cue.text}`;
  }).join('\n\n') + '\n';
}

function safeLyrics(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_LYRICS_BYTES) return null;
  const text = value.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  return text.length >= 12 ? text : null;
}

function matchesRecord(record, meta, duration) {
  if (!record || record.instrumental || !record.trackName || !record.artistName) return false;
  const title = normalizeMatch(record.trackName);
  const artist = normalizeMatch(record.artistName);
  const expectedTitle = normalizeMatch(meta.track);
  const expectedArtist = normalizeMatch(meta.artist);
  if (!title || !artist || !expectedTitle || !expectedArtist) return false;
  if (title !== expectedTitle && !(title.length > 12 && expectedTitle.length > 12 &&
    (title.includes(expectedTitle) || expectedTitle.includes(title)))) return false;
  if (artist !== expectedArtist && !(artist.length > 5 && expectedArtist.length > 5 &&
    (artist.includes(expectedArtist) || expectedArtist.includes(artist)))) return false;
  const foundDuration = Number(record.duration);
  if (Number.isFinite(duration) && duration > 0 && Number.isFinite(foundDuration) && foundDuration > 0) {
    const maxDiff = Math.max(9, Math.min(22, duration * 0.07));
    if (Math.abs(duration - foundDuration) > maxDiff) return false;
  }
  return true;
}

function parseRetryAfter(value) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return Math.min(3_600_000, Math.max(1000, num * 1000));
  const date = Date.parse(value || '');
  return Number.isFinite(date) ? Math.min(3_600_000, Math.max(1000, date - Date.now())) : 60_000;
}

function createYouTubeLyricsResolver({ fetchImpl = (...args) => fetch(...args), delayMs = 380, timeoutMs = 4500 } = {}) {
  let lastLrclibRequest = 0;
  let lrclibBlockedUntil = 0;
  let ovhBlockedUntil = 0;
  let queue = Promise.resolve();
  const pause = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

  function serialize(job) {
    const result = queue.then(job, job);
    queue = result.catch(() => undefined);
    return result;
  }

  async function requestJson(url, provider) {
    const blockedUntil = provider === 'lrclib' ? lrclibBlockedUntil : ovhBlockedUntil;
    if (Date.now() < blockedUntil) return { blocked: true };
    if (provider === 'lrclib') {
      await pause(Math.max(0, lastLrclibRequest + delayMs - Date.now()));
      if (Date.now() < lrclibBlockedUntil) return { blocked: true };
      lastLrclibRequest = Date.now();
    }
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429) {
        const until = Date.now() + parseRetryAfter(response.headers.get('retry-after'));
        if (provider === 'lrclib') lrclibBlockedUntil = until;
        else ovhBlockedUntil = until;
        return { blocked: true };
      }
      if (response.status === 404) return { missing: true };
      if (!response.ok) return { failed: true };
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_LYRICS_BYTES * 2) return { failed: true };
      const data = await response.json();
      return { data };
    } catch { return { failed: true }; }
  }

  async function resolve(meta, duration) {
    const identified = identifySong(meta);
    const checkedAt = new Date().toISOString();
    const result = {
      ...identified,
      lyricsSrt: null,
      staticLyrics: null,
      source: null,
      status: 'none',
      checkedAt,
      retryAt: Date.now() + NEGATIVE_CACHE_MS,
    };
    if (!identified.artist || !identified.track) {
      result.status = 'unidentified';
      return result;
    }
    return serialize(async () => {
      let anyProviderProblem = false;
      const base = new URLSearchParams({ track_name: identified.track, artist_name: identified.artist });
      if (identified.album) base.set('album_name', identified.album);
      if (Number.isFinite(duration) && duration >= 1 && duration <= 3600) base.set('duration', String(Math.round(duration)));
      const got = await requestJson(`https://lrclib.net/api/get?${base}`, 'lrclib');
      let candidates = [];
      if (got.data) candidates.push(got.data);
      if (got.failed || got.blocked) anyProviderProblem = true;
      // /get uses a tight ±2s duration condition; search allows e.g. a few
      // seconds of video intro/outro without mistaking an unrelated song.
      if (!candidates.some(r => matchesRecord(r, identified, duration) && safeLyrics(r.syncedLyrics))) {
        const params = new URLSearchParams({ track_name: identified.track, artist_name: identified.artist });
        const search = await requestJson(`https://lrclib.net/api/search?${params}`, 'lrclib');
        if (Array.isArray(search.data)) candidates.push(...search.data.slice(0, 20));
        if (search.failed || search.blocked) anyProviderProblem = true;
      }
      candidates = candidates.filter(record => matchesRecord(record, identified, duration));
      const synced = candidates.find(record => safeLyrics(record.syncedLyrics) && lrcToSrt(record.syncedLyrics, duration));
      if (synced) {
        result.lyricsSrt = lrcToSrt(synced.syncedLyrics, duration);
        result.staticLyrics = safeLyrics(synced.plainLyrics);
        result.source = 'lrclib';
        result.status = 'synced';
        result.retryAt = null;
        return result;
      }
      const plain = candidates.find(record => safeLyrics(record.plainLyrics));
      if (plain) {
        result.staticLyrics = safeLyrics(plain.plainLyrics);
        result.source = 'lrclib';
        result.status = 'static';
        result.retryAt = null;
        return result;
      }
      // lyrics.ovh is static-only. Never substitute a vague title-only match.
      const ovh = await requestJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(identified.artist)}/${encodeURIComponent(identified.track)}`, 'ovh');
      if (ovh.data && typeof ovh.data === 'object') {
        const found = safeLyrics(ovh.data.lyrics);
        if (found) {
          result.staticLyrics = found;
          result.source = 'lyrics.ovh';
          result.status = 'static';
          result.retryAt = null;
          return result;
        }
      }
      if (ovh.failed || ovh.blocked) anyProviderProblem = true;
      if (anyProviderProblem) {
        result.status = 'retry';
        result.retryAt = Math.max(Date.now() + LOOKUP_RETRY_MS, lrclibBlockedUntil, ovhBlockedUntil);
      }
      return result;
    });
  }

  return { resolve };
}

module.exports = { createYouTubeLyricsResolver, identifySong, lrcToSrt, normalizeMatch };
