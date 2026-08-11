'use strict';

/**
 * Farreo backend safety/Firestore-cost layer.
 *
 * Loaded before server.js (see iniciar.sh/package.json) so it can:
 *  - attach Firebase identity to the legacy API without rewriting server.js;
 *  - block unauthenticated admin mutations;
 *  - enforce hard multipart upload limits;
 *  - move private-playlist artwork out of Firestore;
 *  - rate-limit/cache Firestore-heavy public endpoints;
 *  - replace the N+1 song->albums lookup with a persistent in-memory index.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PATCH_FLAG = Symbol.for('farreo.safety-preload.installed');
if (globalThis[PATCH_FLAG]) {
  module.exports = globalThis[PATCH_FLAG];
  return;
}

const originalExpress = require('express');
const originalMulter = require('multer');

const stats = {
  startedAt: new Date().toISOString(),
  blockedAdminRequests: 0,
  rateLimitedRequests: 0,
  albumDocsCacheHits: 0,
  albumDocsCacheMisses: 0,
  albumIndexCacheHits: 0,
  albumIndexCacheMisses: 0,
  hiddenSongsCacheHits: 0,
  hiddenSongsCacheMisses: 0,
  responseCacheHits: 0,
  responseCacheMisses: 0,
  migratedPrivateIcons: 0,
  rejectedUploads: 0,
};

const state = {
  albumDocs: { expiresAt: 0, pending: null, items: null },
  albumIndex: { expiresAt: 0, pending: null, bySongId: null },
  hiddenSongs: { expiresAt: 0, pending: null, ids: null },
  userFollows: new Map(),
  userFollowsPending: new Map(),
  progress: new Map(),
  responseCache: new Map(),
  tokenCache: new Map(),
  rateBuckets: new Map(),
  visitorSecret: null,
  adminEmails: { expiresAt: 0, values: null },
  localSongs: { expiresAt: 0, items: null },
};

function numberFromEnv(name, fallback, min = 1, max = 4096) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function mb(value) {
  return Math.floor(value * 1024 * 1024);
}

function fileLimitFor(fieldName) {
  if (fieldName === 'lyrics') return mb(numberFromEnv('LYRICS_MAX_MB', 2));
  if (fieldName === 'icon') return mb(numberFromEnv('SONG_ICON_MAX_MB', 8));
  if (fieldName === 'advancedCover') return mb(numberFromEnv('ADVANCED_COVER_MAX_MB', 64));
  if (fieldName === 'file') return mb(numberFromEnv('AUDIO_MAX_MB', 160));
  return mb(numberFromEnv('UPLOAD_MAX_FILE_MB', 160));
}

function cleanupUploadedFiles(files) {
  const all = [];
  if (Array.isArray(files)) all.push(...files);
  else if (files && typeof files === 'object') {
    Object.values(files).forEach((value) => {
      if (Array.isArray(value)) all.push(...value);
    });
  }
  all.forEach((file) => {
    try {
      if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch {
      // Best effort only; the request is rejected regardless.
    }
  });
}

function validateUploadedFiles(req) {
  const all = [];
  if (req.file) all.push(req.file);
  if (Array.isArray(req.files)) all.push(...req.files);
  else if (req.files && typeof req.files === 'object') {
    Object.values(req.files).forEach((value) => {
      if (Array.isArray(value)) all.push(...value);
    });
  }

  for (const file of all) {
    const limit = fileLimitFor(file.fieldname);
    if (Number(file.size) > limit) {
      const error = new Error(`El archivo ${file.originalname || file.fieldname} supera el limite permitido (${Math.round(limit / 1024 / 1024)} MB).`);
      error.statusCode = 413;
      error.code = 'FARREO_FILE_TOO_LARGE';
      return error;
    }
  }
  return null;
}

function decorateUploadMiddleware(middleware) {
  return (req, res, next) => middleware(req, res, (error) => {
    if (error) {
      if (error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_PART_COUNT') {
        error.statusCode = 413;
      }
      if (error.statusCode === 413) stats.rejectedUploads += 1;
      cleanupUploadedFiles(req.files || req.file);
      return next(error);
    }

    const validationError = validateUploadedFiles(req);
    if (validationError) {
      stats.rejectedUploads += 1;
      cleanupUploadedFiles(req.files || req.file);
      return next(validationError);
    }
    return next();
  });
}

function copyFunctionProperties(target, source) {
  for (const key of Reflect.ownKeys(source)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    try { Object.defineProperty(target, key, descriptor); } catch { /* ignore */ }
  }
  return target;
}

// Multer has one fileSize limit for every field. We add a safe global stream
// ceiling and then validate the actual field-specific size after Multer has
// produced the file object. Existing stricter limits (playlist/album icons)
// remain untouched.
function patchedMulter(options = {}) {
  const hardCeiling = mb(numberFromEnv('UPLOAD_MAX_FILE_MB', 160));
  const nextOptions = {
    ...options,
    limits: {
      ...(options.limits || {}),
      fileSize: options.limits?.fileSize || hardCeiling,
      files: options.limits?.files || 8,
    },
  };
  const instance = originalMulter(nextOptions);

  for (const method of ['single', 'array', 'fields', 'any']) {
    if (typeof instance[method] !== 'function') continue;
    const original = instance[method].bind(instance);
    instance[method] = (...args) => decorateUploadMiddleware(original(...args));
  }
  return instance;
}
copyFunctionProperties(patchedMulter, originalMulter);
require.cache[require.resolve('multer')].exports = patchedMulter;

async function getFirebaseAdmin() {
  const admin = require('firebase-admin');
  if (admin.apps.length) return admin;

  let credential = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    credential = admin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')));
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credential = admin.credential.applicationDefault();
  }

  if (!credential) {
    throw Object.assign(new Error('Firebase Admin no configurado para la capa de seguridad de Farreo.'), { statusCode: 503 });
  }
  admin.initializeApp({
    credential,
    projectId: process.env.FIREBASE_PROJECT_ID || undefined,
  });
  return admin;
}

async function getDb() {
  return (await getFirebaseAdmin()).firestore();
}

function bearer(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function optionalUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const cached = state.tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  try {
    const admin = await getFirebaseAdmin();
    const user = await admin.auth().verifyIdToken(token);
    const expMs = Number(user.exp) > 0 ? Number(user.exp) * 1000 : Date.now() + 5 * 60 * 1000;
    state.tokenCache.set(token, {
      user,
      expiresAt: Math.min(expMs, Date.now() + 5 * 60 * 1000),
    });
    if (state.tokenCache.size > 100) {
      const first = state.tokenCache.keys().next().value;
      if (first) state.tokenCache.delete(first);
    }
    return user;
  } catch {
    return null;
  }
}

function loadOrCreateVisitorSecret() {
  if (state.visitorSecret) return state.visitorSecret;
  const secretDir = path.join(__dirname, 'almacenamiento_compartido', 'albums');
  const secretPath = path.join(secretDir, 'visitor-secret');
  fs.mkdirSync(secretDir, { recursive: true });

  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 64) {
      state.visitorSecret = existing;
      return existing;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretPath, generated, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    state.visitorSecret = generated;
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    state.visitorSecret = fs.readFileSync(secretPath, 'utf8').trim();
    return state.visitorSecret;
  }
}

function verifyVisitor(token) {
  if (!token || !String(token).includes('.')) return null;
  const secret = loadOrCreateVisitorSecret();
  const [encoded, signature] = String(token).split('.', 2);
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const left = Buffer.from(signature || '');
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return typeof payload.id === 'string' && payload.id ? payload : null;
  } catch {
    return null;
  }
}

async function actor(req) {
  const user = await optionalUser(req);
  if (user) return { key: `user:${user.uid}`, user };
  const visitor = verifyVisitor(req.headers['x-farreo-visitor-token']);
  if (visitor) return { key: `visitor:${visitor.id}`, visitor };
  return null;
}

async function getAdminEmails() {
  if (state.adminEmails.values && state.adminEmails.expiresAt > Date.now()) {
    return state.adminEmails.values;
  }

  const local = new Set(
    `${process.env.FARREO_ADMIN_EMAILS || ''},${process.env.NEXT_PUBLIC_ADMIN_EMAILS || ''}`
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  const webUrl = String(process.env.FARREO_WEB_URL || 'https://farreo.vercel.app').replace(/\/+$/, '');
  try {
    const response = await fetch(`${webUrl}/api/admins`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) {
      const data = await response.json();
      (Array.isArray(data.emails) ? data.emails : []).forEach((value) => {
        const email = String(value).trim().toLowerCase();
        if (email) local.add(email);
      });
    }
  } catch {
    // Local configuration remains a valid fallback.
  }

  state.adminEmails = { values: local, expiresAt: Date.now() + 5 * 60 * 1000 };
  return local;
}

async function adminUser(req) {
  const user = await optionalUser(req);
  if (!user?.email) return null;
  const emails = await getAdminEmails();
  return emails.has(String(user.email).toLowerCase()) ? user : null;
}

function adminMutation(req) {
  if (req.method === 'OPTIONS' || req.method === 'GET' || req.method === 'HEAD') return false;
  const value = req.path || req.url.split('?')[0];
  if (value === '/upload') return true;
  if (value === '/playlist') return true;
  if (value.startsWith('/cancion/')) return true;
  if (value.startsWith('/playlist/')) return true;
  if (value.startsWith('/admin/')) return true;
  return false;
}

function remoteKey(req) {
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

function allowRate(req, bucket, max, windowMs) {
  const now = Date.now();
  const key = `${bucket}:${remoteKey(req)}`;
  let entry = state.rateBuckets.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    state.rateBuckets.set(key, entry);
  }
  entry.count += 1;
  if (entry.count <= max) return { ok: true, retryAfter: 0 };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
}

function ratePolicy(req) {
  const value = req.path || req.url.split('?')[0];
  if (value === '/album-session') return { bucket: 'session', max: 30, windowMs: 60_000 };
  if (req.method === 'POST' && value === '/recommendations') return { bucket: 'recommendations', max: 20, windowMs: 5 * 60_000 };
  if (value.startsWith('/recommendations/shared/')) return { bucket: 'shared-rec', max: 30, windowMs: 60_000 };
  if (/^\/songs\/[^/]+\/(albums|similar)$/.test(value)) return { bucket: 'song-discovery', max: 60, windowMs: 5 * 60_000 };
  if (req.method === 'GET' && (value === '/albums' || /^\/albums\/[^/]+$/.test(value))) return { bucket: 'albums', max: 30, windowMs: 5 * 60_000 };
  if (req.method === 'POST' && /^\/albums\/[^/]+\/tracks\/[^/]+\/(reveal|first-play)$/.test(value)) return { bucket: 'album-progress', max: 30, windowMs: 5 * 60_000 };
  if (value.includes('user-playlist-url')) return { bucket: 'user-playlist-url', max: 30, windowMs: 60_000 };
  return null;
}

function iso(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString();
  return null;
}

function albumCard(item) {
  const data = item.data || {};
  return {
    id: item.id,
    nombre: String(data.nombre || 'Album sin nombre'),
    iconUrl: typeof data.iconUrl === 'string' ? data.iconUrl : null,
    numCanciones: Number(data.trackCount) || 0,
    scheduledCount: Math.max(0, Number(data.scheduledCount) || 0),
    revelationEnabled: Boolean(data.revelationEnabled),
    revelationVersion: Math.max(1, Number(data.revelationVersion) || 1),
    followerCount: Math.max(0, Number(data.followerCount) || 0),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  };
}

function invalidateAlbumCaches() {
  state.albumDocs.expiresAt = 0;
  state.albumDocs.items = null;
  state.albumIndex.expiresAt = 0;
  state.albumIndex.bySongId = null;
}

function invalidateUserCaches() {
  state.userFollows.clear();
  state.userFollowsPending.clear();
  state.progress.clear();
}

async function loadAlbumDocs() {
  if (state.albumDocs.items && state.albumDocs.expiresAt > Date.now()) {
    stats.albumDocsCacheHits += 1;
    return state.albumDocs.items;
  }
  if (state.albumDocs.pending) {
    stats.albumDocsCacheHits += 1;
    return state.albumDocs.pending;
  }

  stats.albumDocsCacheMisses += 1;
  const request = (async () => {
    const db = await getDb();
    const snap = await db.collection('albums').get();
    const items = snap.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }));
    state.albumDocs.items = items;
    state.albumDocs.expiresAt = Date.now() + 60_000;
    return items;
  })().finally(() => { state.albumDocs.pending = null; });
  state.albumDocs.pending = request;
  return request;
}

async function loadAlbumSongIndex() {
  if (state.albumIndex.bySongId && state.albumIndex.expiresAt > Date.now()) {
    stats.albumIndexCacheHits += 1;
    return state.albumIndex.bySongId;
  }
  if (state.albumIndex.pending) {
    stats.albumIndexCacheHits += 1;
    return state.albumIndex.pending;
  }

  stats.albumIndexCacheMisses += 1;
  const request = (async () => {
    const db = await getDb();
    const albums = await loadAlbumDocs();
    const albumsById = new Map(albums.map((album) => [album.id, album]));
    const bySongId = new Map();

    // One collection-group scan replaces one tracks query per album. Firestore
    // still bills the track documents that actually exist, but we avoid the
    // extra query/minimum-read overhead of N separate album subcollections.
    const tracks = await db.collectionGroup('tracks').get();
    tracks.docs.forEach((doc) => {
      const albumId = doc.ref.parent.parent?.id;
      const album = albumId ? albumsById.get(albumId) : null;
      if (!album) return;
      const track = { id: doc.id, ...doc.data() };
      const songId = String(track.songId || '');
      if (!songId) return;
      const list = bySongId.get(songId) || [];
      list.push({ album, track });
      bySongId.set(songId, list);
    });
    state.albumIndex.bySongId = bySongId;
    // Album-track membership changes only through admin endpoints, which
    // invalidate this cache immediately. A long TTL avoids recurring N+1 reads.
    state.albumIndex.expiresAt = Date.now() + 30 * 60_000;
    return bySongId;
  })().finally(() => { state.albumIndex.pending = null; });
  state.albumIndex.pending = request;
  return request;
}

async function hiddenSongIds() {
  if (state.hiddenSongs.ids && state.hiddenSongs.expiresAt > Date.now()) {
    stats.hiddenSongsCacheHits += 1;
    return state.hiddenSongs.ids;
  }
  if (state.hiddenSongs.pending) {
    stats.hiddenSongsCacheHits += 1;
    return state.hiddenSongs.pending;
  }

  stats.hiddenSongsCacheMisses += 1;
  const request = (async () => {
    const db = await getDb();
    const snap = await db.collection('hiddenSongs').get();
    const ids = new Set();
    snap.docs.forEach((doc) => {
      ids.add(doc.id);
      const songId = doc.data()?.songId;
      if (songId) ids.add(String(songId));
    });
    state.hiddenSongs.ids = ids;
    state.hiddenSongs.expiresAt = Date.now() + 15_000;
    return ids;
  })().finally(() => { state.hiddenSongs.pending = null; });
  state.hiddenSongs.pending = request;
  return request;
}

async function userAlbumFollows(uid) {
  const cached = state.userFollows.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached.values;
  const pending = state.userFollowsPending.get(uid);
  if (pending) return pending;

  const request = (async () => {
    const db = await getDb();
    const snap = await db.collection('albumFollows').where('userId', '==', uid).get();
    const values = new Map(snap.docs.map((doc) => [String(doc.data().albumId), doc.data()]));
    state.userFollows.set(uid, { expiresAt: Date.now() + 60_000, values });
    return values;
  })().finally(() => state.userFollowsPending.delete(uid));
  state.userFollowsPending.set(uid, request);
  return request;
}

function progressId(actorKey, albumId, version) {
  return crypto.createHash('sha256').update(`${actorKey}\u0000${albumId}\u0000${version}`).digest('hex');
}

async function revealedEntries(actorKey, albumId, version) {
  if (!actorKey) return new Set();
  const key = `${actorKey}:${albumId}:${version}`;
  const cached = state.progress.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.revealed;
  const db = await getDb();
  const snap = await db.collection('albumRevealProgress').doc(progressId(actorKey, albumId, version)).get();
  const data = snap.exists ? snap.data() || {} : {};
  const revealed = new Set(Array.isArray(data.revealedEntryIds) ? data.revealedEntryIds.map(String) : []);
  state.progress.set(key, { expiresAt: Date.now() + 15_000, revealed });
  return revealed;
}

function responseCachePolicy(req) {
  if (req.method !== 'GET') return null;
  const value = req.path || req.url.split('?')[0];
  if (/^\/songs\/[^/]+\/similar$/.test(value)) return 30_000;
  if (value.startsWith('/recommendations/shared/')) return 60_000;
  return null;
}

function responseCacheKey(req) {
  return `${req.method}:${req.originalUrl || req.url}`;
}

function managedPrivateIconPath(iconUrl, directory) {
  if (typeof iconUrl !== 'string' || !iconUrl.startsWith('/private-playlist-icons/')) return null;
  try {
    const fileName = path.basename(new URL(iconUrl, 'https://farreo.invalid').pathname);
    const resolved = path.resolve(directory, fileName);
    return resolved.startsWith(path.resolve(directory) + path.sep) ? resolved : null;
  } catch {
    return null;
  }
}


function getBaseName(fileName) {
  return path.parse(fileName).name;
}

function readLocalLyrics(baseDir, metadata) {
  if (!metadata?.lyricsFile) return null;
  try {
    const filePath = path.resolve(path.join(baseDir, 'lyrics'), String(metadata.lyricsFile));
    const root = path.resolve(path.join(baseDir, 'lyrics'));
    if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readLocalSongMetadata(baseDir, audioFile) {
  const metadataPath = path.join(baseDir, 'canciones', `${getBaseName(audioFile)}.json`);
  const fallback = { nombre: audioFile.replace(/^\d+_/, ''), variantes: [], themeIds: [] };
  if (!fs.existsSync(metadataPath)) return fallback;
  try {
    const data = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return {
      ...fallback,
      ...data,
      nombre: data.nombre || fallback.nombre,
      variantes: Array.isArray(data.variantes) ? data.variantes : [],
      themeIds: Array.isArray(data.themeIds) ? data.themeIds.map(String) : [],
    };
  } catch {
    return fallback;
  }
}

async function localSongEntries() {
  if (state.localSongs.items && state.localSongs.expiresAt > Date.now()) return state.localSongs.items;
  const baseDir = path.join(__dirname, 'almacenamiento_compartido');
  const audiosDir = path.join(baseDir, 'audios');
  if (!fs.existsSync(audiosDir)) return [];

  const validThemeIds = new Set(readThemeCatalog().map((theme) => theme.id));
  const entries = fs.readdirSync(audiosDir)
    .filter((file) => /\.(mp3|mpeg|wav)$/i.test(file))
    .map((file) => {
      const metadata = readLocalSongMetadata(baseDir, file);
      metadata.themeIds = (metadata.themeIds || []).filter((id) => validThemeIds.has(id));
      let statsValue = null;
      try { statsValue = fs.statSync(path.join(audiosDir, file)); } catch { /* ignore */ }
      const iconFile = metadata.manualIconFile || metadata.embeddedIconFile || null;
      return {
        song: {
          id: file,
          name: metadata.nombre,
          variantes: metadata.variantes || [],
          url: `/audio/${file}`,
          iconUrl: iconFile ? `/song-icons/${iconFile}` : null,
          advancedCoverUrl: metadata.advancedCoverFile ? `/song-advanced-covers/${metadata.advancedCoverFile}` : null,
          advancedCoverType: metadata.advancedCoverMime || null,
          lyricsUrl: metadata.lyricsFile ? `/lyrics/${metadata.lyricsFile}` : null,
          lyricsFileName: metadata.lyricsOriginalName || null,
          lyricsSrt: readLocalLyrics(baseDir, metadata),
          staticLyrics: metadata.staticLyrics || null,
          duration: typeof metadata.duration === 'number' && Number.isFinite(metadata.duration) ? metadata.duration : null,
          createdAt: {
            seconds: Math.floor((statsValue?.birthtimeMs || statsValue?.mtimeMs || Date.now()) / 1000),
            nanoseconds: 0,
          },
        },
        themeIds: metadata.themeIds || [],
      };
    })
    .sort((a, b) => (b.song.createdAt?.seconds || 0) - (a.song.createdAt?.seconds || 0));

  state.localSongs.items = entries;
  state.localSongs.expiresAt = Date.now() + 30_000;
  return entries;
}

async function localPublicSongEntries() {
  const [entries, hidden] = await Promise.all([localSongEntries(), hiddenSongIds()]);
  return entries.filter((entry) => !hidden.has(entry.song.id));
}

function seededRandom(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  let randomState = digest.readUInt32LE(0) || 1;
  return () => {
    randomState += 0x6D2B79F5;
    let value = randomState;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function readThemeCatalog() {
  const filePath = path.join(__dirname, 'almacenamiento_compartido', 'song-themes.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const themes = Array.isArray(parsed) ? parsed : parsed.themes;
    return Array.isArray(themes)
      ? themes.filter((theme) => theme && typeof theme.id === 'string' && typeof theme.name === 'string')
        .map((theme) => ({ id: theme.id, name: theme.name.trim() }))
        .filter((theme) => theme.name)
      : [];
  } catch {
    return [];
  }
}

function buildTastePlaylist(entries, seed, index) {
  const random = seededRandom(`${seed}:taste:${index}`);
  const themes = readThemeCatalog().filter((theme) => entries.some((entry) => entry.themeIds.includes(theme.id)));
  if (themes.length === 0) {
    return {
      id: `weekly-${crypto.createHash('sha1').update(`${seed}:${index}`).digest('hex').slice(0, 12)}`,
      name: 'Seleccion semanal',
      songs: shuffled(entries.map((entry) => entry.song), random).slice(0, 16),
      themeNames: [],
    };
  }

  const shuffledThemes = shuffled(themes, random);
  const chosenCount = Math.min(shuffledThemes.length, 1 + Math.floor(random() * 3));
  const chosen = shuffledThemes.slice(0, chosenCount);
  const candidateCount = () => {
    const ids = new Set(chosen.map((theme) => theme.id));
    return entries.filter((entry) => entry.themeIds.some((id) => ids.has(id))).length;
  };
  while (chosen.length < shuffledThemes.length && candidateCount() < 8) {
    chosen.push(shuffledThemes[chosen.length]);
  }

  const chosenIds = new Set(chosen.map((theme) => theme.id));
  const scoredCandidates = entries
    .map((entry) => ({
      ...entry,
      score: entry.themeIds.filter((id) => chosenIds.has(id)).length,
      random: random(),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.random - right.random);
  const selectedIds = new Set(scoredCandidates.map((entry) => entry.song.id));
  const filler = shuffled(entries.filter((entry) => !selectedIds.has(entry.song.id)), random)
    .map((entry) => ({ ...entry, score: 0, random: random() }));
  const candidates = [...scoredCandidates, ...filler]
    .slice(0, Math.min(16, entries.length))
    .map((entry) => entry.song);
  const names = chosen.map((theme) => theme.name);
  const name = names.length === 1
    ? `Sobre ${names[0]}`
    : names.length === 2
      ? `Sobre ${names[0]} y ${names[1]}`
      : `Sobre ${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  return {
    id: `weekly-${crypto.createHash('sha1').update(`${seed}:${index}`).digest('hex').slice(0, 12)}`,
    name,
    songs: candidates,
    themeNames: names,
  };
}

function recommendationToken(clientSeed, weekKey, index) {
  return Buffer.from(JSON.stringify({ seed: clientSeed, week: weekKey, index }), 'utf8').toString('base64url');
}

function isoWeekKey(date = new Date()) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function installSafety(app) {
  if (app.__farreoSafetyInstalled) return;
  app.__farreoSafetyInstalled = true;

  const privateIconDir = path.join(__dirname, 'almacenamiento_compartido', 'private-playlist-icons');
  fs.mkdirSync(privateIconDir, { recursive: true });

  // CORS headers are emitted here because several safety routes run before the
  // cors() middleware declared later in server.js.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Farreo-Visitor-Token');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Very small response cache for routes that otherwise repeat the same
  // Firestore-backed computation. User-specific album routes are optimized
  // separately below and are not cached here.
  app.use((req, res, next) => {
    const ttl = responseCachePolicy(req);
    if (!ttl) return next();
    const key = responseCacheKey(req);
    const cached = state.responseCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      stats.responseCacheHits += 1;
      return res.status(cached.status).json(cached.body);
    }
    stats.responseCacheMisses += 1;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        state.responseCache.set(key, { expiresAt: Date.now() + ttl, status: res.statusCode, body });
        if (state.responseCache.size > 500) {
          const first = state.responseCache.keys().next().value;
          if (first) state.responseCache.delete(first);
        }
      }
      return originalJson(body);
    };
    return next();
  });

  app.use(async (req, res, next) => {
    const policy = ratePolicy(req);
    if (policy) {
      const rate = allowRate(req, policy.bucket, policy.max, policy.windowMs);
      if (!rate.ok) {
        stats.rateLimitedRequests += 1;
        res.setHeader('Retry-After', String(rate.retryAfter));
        return res.status(429).json({ error: 'Demasiadas peticiones. Reintenta en unos segundos.' });
      }
    }

    if (!adminMutation(req) || process.env.FARREO_DISABLE_ADMIN_GUARD === 'true') return next();
    try {
      const user = await adminUser(req);
      if (!user) {
        stats.blockedAdminRequests += 1;
        return res.status(bearer(req) ? 403 : 401).json({ error: bearer(req) ? 'Permisos de administrador requeridos.' : 'Autenticacion requerida.' });
      }
      req.farreoAdmin = user;
      return next();
    } catch (error) {
      return next(error);
    }
  });

  // Invalidate persistent caches immediately after successful mutations.
  // Reads stay cached; writes never do. Song metadata/themes are local files,
  // while album/follow state is Firestore-backed.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 400) return;
      const routePath = req.path || req.url.split('?')[0];

      if (routePath === '/upload' || routePath.startsWith('/cancion/')) {
        state.localSongs.expiresAt = 0;
        state.localSongs.items = null;
        state.responseCache.clear();
      }

      if (routePath.startsWith('/admin/song-themes')) {
        state.localSongs.expiresAt = 0;
        state.localSongs.items = null;
        state.responseCache.clear();
      }

      if (routePath.startsWith('/albums/')) {
        invalidateUserCaches();
        if (routePath.includes('/follow')) invalidateAlbumCaches();
      }

      if (routePath.startsWith('/admin/albums')) {
        invalidateAlbumCaches();
        invalidateUserCaches();
        state.responseCache.clear();
      }
    });
    next();
  });

  // Similar songs are computed entirely from the Linux song metadata. The only
  // Firebase input is the tiny cached hiddenSongs set, avoiding one full
  // hiddenSongs query for every track change.
  app.get('/songs/:songId/similar', async (req, res, next) => {
    try {
      const entries = await localPublicSongEntries();
      const source = entries.find((entry) => entry.song.id === String(req.params.songId || ''));
      if (!source || source.themeIds.length === 0) return res.json([]);

      const sourceThemes = new Set(source.themeIds);
      const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
      const results = entries
        .filter((entry) => entry.song.id !== source.song.id)
        .map((entry) => ({
          song: entry.song,
          sharedThemeCount: entry.themeIds.filter((id) => sourceThemes.has(id)).length,
          random: Math.random(),
        }))
        .filter((entry) => entry.sharedThemeCount > 0)
        .sort((left, right) => right.sharedThemeCount - left.sharedThemeCount || left.random - right.random)
        .slice(0, limit)
        .map((entry) => entry.song);
      return res.json(results);
    } catch (error) {
      return next(error);
    }
  });

  // Recommendations also use the local music/theme catalogue. Firestore album
  // cards and hidden IDs are read through the caches above, so repeated Home
  // renders/tabs do not fan out into fresh database scans.
  app.post('/recommendations', originalExpress.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      const clientSeed = String(req.body?.clientSeed || '').slice(0, 128) || crypto.randomUUID();
      const heardIds = new Set(Array.isArray(req.body?.heardSongIds)
        ? req.body.heardSongIds.slice(0, 10_000).map(String)
        : []);
      const now = new Date();
      const requestedDayKey = String(req.body?.dayKey || '');
      const requestedWeekKey = String(req.body?.weekKey || '');
      const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(requestedDayKey)
        ? requestedDayKey
        : now.toISOString().slice(0, 10);
      const weekKey = /^\d{4}-\d{2}-\d{2}$/.test(requestedWeekKey)
        ? requestedWeekKey
        : isoWeekKey(now);

      const entries = await localPublicSongEntries();
      const dailyPool = entries.filter((entry) => !heardIds.has(entry.song.id));
      const dailyCandidates = dailyPool.length > 0 ? dailyPool : entries;
      const dailyRandom = seededRandom(`${clientSeed}:${dayKey}:daily`);
      const dailySong = dailyCandidates.length > 0
        ? dailyCandidates[Math.floor(dailyRandom() * dailyCandidates.length)].song
        : null;

      let albums = [];
      try {
        const albumDocs = await loadAlbumDocs();
        albums = albumDocs.map((item) => ({
          id: item.id,
          nombre: String(item.data?.nombre || 'Album sin nombre'),
          iconUrl: typeof item.data?.iconUrl === 'string' ? item.data.iconUrl : null,
          numCanciones: Math.max(0, Number(item.data?.trackCount) || 0),
          revelationEnabled: Boolean(item.data?.revelationEnabled),
          followerCount: Math.max(0, Number(item.data?.followerCount) || 0),
        }));
      } catch (error) {
        console.warn('No se pudo elegir el album semanal:', error.message);
      }

      const weeklyCount = albums.length > 0 ? 2 : 3;
      const weeklyPlaylists = Array.from({ length: weeklyCount }, (_, index) => {
        const playlist = buildTastePlaylist(entries, `${clientSeed}:${weekKey}`, index);
        return { ...playlist, shareToken: recommendationToken(clientSeed, weekKey, index) };
      });
      const albumRandom = seededRandom(`${clientSeed}:${weekKey}:album`);
      const weeklyAlbum = albums.length > 0 ? albums[Math.floor(albumRandom() * albums.length)] : null;

      return res.json({
        dayKey,
        weekKey,
        dailySong,
        dailySongUnheard: dailyPool.length > 0,
        weeklyPlaylists,
        weeklyAlbum,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/recommendations/shared/:token', async (req, res, next) => {
    try {
      const payload = JSON.parse(Buffer.from(String(req.params.token || ''), 'base64url').toString('utf8'));
      if (!payload || typeof payload.seed !== 'string' || typeof payload.week !== 'string' || !Number.isInteger(payload.index)) {
        return res.status(400).json({ error: 'Recomendacion no valida.' });
      }
      const entries = await localPublicSongEntries();
      return res.json(buildTastePlaylist(entries, `${payload.seed}:${payload.week}`, payload.index));
    } catch (error) {
      if (error instanceof SyntaxError) return res.status(400).json({ error: 'Recomendacion no valida.' });
      return next(error);
    }
  });

  // Optimized album cards: one cached albums query plus one small follows query
  // per user, instead of re-reading the full collection every page load.
  app.get('/albums', async (req, res, next) => {
    try {
      const albums = await loadAlbumDocs();
      const user = await optionalUser(req);
      const follows = user ? await userAlbumFollows(user.uid) : new Map();
      const result = albums.map((item) => {
        const card = albumCard(item);
        const follow = follows.get(item.id);
        return {
          ...card,
          isFollowing: Boolean(follow),
          followedAt: follow ? iso(follow.createdAt) : null,
          lastOpenedAt: follow ? iso(follow.lastOpenedAt) : null,
        };
      }).sort((left, right) => {
        if (left.revelationEnabled !== right.revelationEnabled) return left.revelationEnabled ? -1 : 1;
        return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // Replaces the expensive N+1 implementation. The first discovery request
  // builds songId -> album/track in RAM. Every later song lookup uses that
  // index until an admin changes album membership.
  app.get('/songs/:songId/albums', async (req, res, next) => {
    try {
      const songId = String(req.params.songId || '');
      if (!songId) return res.json([]);
      if ((await hiddenSongIds()).has(songId)) return res.json([]);

      const bySongId = await loadAlbumSongIndex();
      const matches = bySongId.get(songId) || [];
      if (matches.length === 0) return res.json([]);

      const currentActor = await actor(req);
      const follows = currentActor?.user ? await userAlbumFollows(currentActor.user.uid) : new Map();
      const output = [];
      for (const { album, track } of matches) {
        const data = album.data || {};
        const releaseAt = iso(track.releaseAt);
        if (releaseAt && new Date(releaseAt).getTime() > Date.now()) continue;

        if (data.revelationEnabled) {
          const version = Math.max(1, Number(data.revelationVersion) || 1);
          const revealed = await revealedEntries(currentActor?.key || null, album.id, version);
          if (!revealed.has(track.id)) continue;
        }

        const follow = currentActor?.user ? follows.get(album.id) : null;
        output.push({
          ...albumCard(album),
          isFollowing: Boolean(follow),
          followedAt: follow ? iso(follow.createdAt) : null,
        });
      }
      output.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
      res.json(output);
    } catch (error) {
      next(error);
    }
  });

  // Private playlist artwork lives on the Linux machine, not inside a
  // Firestore document. The route also migrates existing Base64 icons when the
  // frontend encounters them.
  app.use('/private-playlist-icons', originalExpress.static(privateIconDir, {
    maxAge: '1y',
    immutable: true,
  }));

  const uploadPrivateIcon = originalMulter({
    storage: originalMulter.memoryStorage(),
    limits: { fileSize: mb(2), files: 1 },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype?.startsWith('image/')) return cb(new Error('El icono debe ser una imagen.'));
      cb(null, true);
    },
  });

  app.post('/private-playlists/:id/icon', decorateUploadMiddleware(uploadPrivateIcon.single('icon')), async (req, res, next) => {
    try {
      const user = await optionalUser(req);
      if (!user) return res.status(401).json({ error: 'Autenticacion requerida.' });
      if (!req.file?.buffer) return res.status(400).json({ error: 'Falta el icono.' });

      const db = await getDb();
      const ref = db.collection('privatePlaylists').doc(String(req.params.id || ''));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Playlist no encontrada.' });
      const data = snap.data() || {};
      if (String(data.ownerId || '') !== user.uid) return res.status(403).json({ error: 'No puedes editar esta playlist.' });

      const sharp = require('sharp');
      const fileName = `${crypto.createHash('sha1').update(ref.id).digest('hex')}.webp`;
      const output = path.join(privateIconDir, fileName);
      await sharp(req.file.buffer, { animated: false })
        .rotate()
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(output);

      const oldPath = managedPrivateIconPath(data.iconUrl, privateIconDir);
      if (oldPath && oldPath !== output && fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch { /* best effort */ }
      }

      const iconUrl = `/private-playlist-icons/${fileName}?v=${Date.now()}`;
      const admin = await getFirebaseAdmin();
      await ref.set({
        iconUrl,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      stats.migratedPrivateIcons += 1;
      res.json({ iconUrl });
    } catch (error) {
      if (error?.code === 'LIMIT_FILE_SIZE') error.statusCode = 413;
      next(error);
    }
  });

  app.delete('/private-playlists/:id/icon', async (req, res, next) => {
    try {
      const user = await optionalUser(req);
      if (!user) return res.status(401).json({ error: 'Autenticacion requerida.' });
      const db = await getDb();
      const ref = db.collection('privatePlaylists').doc(String(req.params.id || ''));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Playlist no encontrada.' });
      const data = snap.data() || {};
      if (String(data.ownerId || '') !== user.uid) return res.status(403).json({ error: 'No puedes editar esta playlist.' });

      const oldPath = managedPrivateIconPath(data.iconUrl, privateIconDir);
      if (oldPath && fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch { /* best effort */ }
      }
      // Also remove the deterministic file in case Firestore still contains an
      // older Base64 icon while a previous migration partially completed.
      const deterministic = path.join(privateIconDir, `${crypto.createHash('sha1').update(ref.id).digest('hex')}.webp`);
      if (fs.existsSync(deterministic)) {
        try { fs.unlinkSync(deterministic); } catch { /* best effort */ }
      }

      const admin = await getFirebaseAdmin();
      await ref.set({ iconUrl: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      res.json({ iconUrl: null });
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin/farreo-safety/stats', async (req, res, next) => {
    try {
      const user = await adminUser(req);
      if (!user) return res.status(403).json({ error: 'Permisos de administrador requeridos.' });
      res.json({
        ...stats,
        uptimeSeconds: Math.floor(process.uptime()),
        caches: {
          albumDocs: state.albumDocs.items?.length || 0,
          indexedSongs: state.albumIndex.bySongId?.size || 0,
          hiddenSongs: state.hiddenSongs.ids?.size || 0,
          responseEntries: state.responseCache.size,
          userFollowEntries: state.userFollows.size,
          progressEntries: state.progress.size,
        },
      });
    } catch (error) {
      next(error);
    }
  });
}

function patchedExpress(...args) {
  const app = originalExpress(...args);
  installSafety(app);
  return app;
}
copyFunctionProperties(patchedExpress, originalExpress);
require.cache[require.resolve('express')].exports = patchedExpress;

globalThis[PATCH_FLAG] = {
  stats,
  invalidateAlbumCaches,
  invalidateUserCaches,
};
module.exports = globalThis[PATCH_FLAG];
