'use strict';

/**
 * Persistent daily + weekly recommendation snapshots.
 *
 * This preload is intentionally installed before farreoSafetyPreload/server.js.
 * It leaves the existing recommendation algorithm untouched, but freezes the
 * first successful daily and weekly selections for a signed-in account.
 *
 * Daily key:  uid + day + visibility scope
 * Weekly key: uid + week + visibility scope
 *
 * This guarantees that the same account sees the same daily song and weekly
 * selections on every device even when the catalogue changes afterwards.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PATCH_FLAG = Symbol.for('farreo.recommendation-snapshots-preload.installed');

if (globalThis[PATCH_FLAG]) {
  module.exports = globalThis[PATCH_FLAG];
  return;
}

const express = require('express');
const originalPost = express.application.post;

const WEEKLY_SNAPSHOT_VERSION = 2;
const DAILY_SNAPSHOT_VERSION = 1;

const WEEKLY_SNAPSHOT_DIR = path.join(
  __dirname,
  'almacenamiento_compartido',
  'recommendation-weekly-snapshots',
);
const DAILY_SNAPSHOT_DIR = path.join(
  __dirname,
  'almacenamiento_compartido',
  'recommendation-daily-snapshots',
);
const MAX_TOKEN_CACHE = 100;
const tokenCache = new Map();
let adminEmailsCache = { expiresAt: 0, values: null };

fs.mkdirSync(WEEKLY_SNAPSHOT_DIR, { recursive: true });
fs.mkdirSync(DAILY_SNAPSHOT_DIR, { recursive: true });

function bearer(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

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
    throw Object.assign(
      new Error('Firebase Admin no configurado para snapshots de recomendaciones.'),
      { statusCode: 503 },
    );
  }

  admin.initializeApp({
    credential,
    projectId: process.env.FIREBASE_PROJECT_ID || undefined,
  });
  return admin;
}

async function authenticatedUser(req) {
  const token = bearer(req);
  if (!token) return null;

  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  try {
    const admin = await getFirebaseAdmin();
    const user = await admin.auth().verifyIdToken(token);
    const expMs = Number(user.exp) > 0
      ? Number(user.exp) * 1000
      : Date.now() + 5 * 60 * 1000;

    tokenCache.set(token, {
      user,
      expiresAt: Math.min(expMs, Date.now() + 5 * 60 * 1000),
    });
    while (tokenCache.size > MAX_TOKEN_CACHE) {
      const first = tokenCache.keys().next().value;
      if (!first) break;
      tokenCache.delete(first);
    }
    return user;
  } catch {
    return null;
  }
}

async function getAdminEmails() {
  if (adminEmailsCache.values && adminEmailsCache.expiresAt > Date.now()) {
    return adminEmailsCache.values;
  }

  const values = new Set(
    `${process.env.FARREO_ADMIN_EMAILS || ''},${process.env.NEXT_PUBLIC_ADMIN_EMAILS || ''}`
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  const webUrl = String(
    process.env.FARREO_WEB_URL || 'https://farreo.vercel.app',
  ).replace(/\/+$/, '');

  try {
    const response = await fetch(`${webUrl}/api/admins`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) {
      const data = await response.json();
      (Array.isArray(data.emails) ? data.emails : []).forEach((value) => {
        const email = String(value || '').trim().toLowerCase();
        if (email) values.add(email);
      });
    }
  } catch {
    // Local env configuration remains a valid fallback.
  }

  adminEmailsCache = {
    values,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  return values;
}

async function recommendationIdentity(req) {
  const user = await authenticatedUser(req);
  if (!user?.uid) return null;

  const adminEmails = await getAdminEmails();
  const isAdmin = Boolean(
    user.email
    && adminEmails.has(String(user.email).trim().toLowerCase()),
  );

  return {
    uid: String(user.uid),
    scope: isAdmin ? 'admin' : 'public',
  };
}

function validDayKey(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function validWeekKey(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) || /^\d{4}-W\d{2}$/.test(text)
    ? text
    : null;
}

function normalizeThemeName(value) {
  return String(value || '').trim().toLocaleLowerCase('es-ES');
}

function readThemeCatalog() {
  const file = path.join(
    __dirname,
    'almacenamiento_compartido',
    'song-themes.json',
  );

  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const themes = Array.isArray(parsed) ? parsed : parsed?.themes;
    if (!Array.isArray(themes)) return [];

    return themes
      .filter((theme) => theme && typeof theme.id === 'string' && typeof theme.name === 'string')
      .map((theme) => ({
        id: String(theme.id),
        name: String(theme.name).trim(),
      }))
      .filter((theme) => theme.id && theme.name);
  } catch {
    return [];
  }
}

function songThemeIds(songId, cache) {
  const id = String(songId || '');
  if (!id) return [];
  if (cache.has(id)) return cache.get(id);

  const file = path.join(
    __dirname,
    'almacenamiento_compartido',
    'canciones',
    `${path.parse(id).name}.json`,
  );

  let ids = [];
  try {
    if (fs.existsSync(file)) {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      ids = Array.isArray(metadata?.themeIds)
        ? metadata.themeIds.map(String).filter(Boolean)
        : [];
    }
  } catch {
    ids = [];
  }

  cache.set(id, ids);
  return ids;
}

/**
 * Weekly playlists are theme playlists, not generic discovery buckets.
 * Every returned song must share at least one of the themes that appear in
 * that playlist's title/themeNames. If there are fewer than 16 matches, the
 * playlist stays shorter instead of being padded with unrelated songs.
 */
function enforceStrictWeeklyThemes(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.weeklyPlaylists)) {
    return body;
  }

  const catalog = readThemeCatalog();
  const idsByName = new Map();
  catalog.forEach((theme) => {
    const key = normalizeThemeName(theme.name);
    if (!key) return;
    if (!idsByName.has(key)) idsByName.set(key, new Set());
    idsByName.get(key).add(theme.id);
  });

  const themeCache = new Map();
  const weeklyPlaylists = body.weeklyPlaylists.map((playlist) => {
    if (!playlist || typeof playlist !== 'object') return playlist;

    const themeNames = Array.isArray(playlist.themeNames)
      ? playlist.themeNames.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const allowedThemeIds = new Set();

    themeNames.forEach((name) => {
      const ids = idsByName.get(normalizeThemeName(name));
      if (!ids) return;
      ids.forEach((id) => allowedThemeIds.add(id));
    });

    const songs = (Array.isArray(playlist.songs) ? playlist.songs : [])
      .filter((song) => {
        if (!song || typeof song !== 'object' || allowedThemeIds.size === 0) return false;
        return songThemeIds(song.id, themeCache)
          .some((themeId) => allowedThemeIds.has(themeId));
      })
      .slice(0, 16);

    return {
      ...playlist,
      songs,
    };
  });

  return {
    ...body,
    weeklyPlaylists,
  };
}

function weeklySnapshotFile(identity, weekKey) {
  const digest = crypto
    .createHash('sha256')
    .update(`${WEEKLY_SNAPSHOT_VERSION}\0${identity.uid}\0${weekKey}\0${identity.scope}`)
    .digest('hex');
  return path.join(WEEKLY_SNAPSHOT_DIR, `${digest}.json`);
}

function normalizeWeeklySnapshot(value, identity, weekKey) {
  if (!value || typeof value !== 'object') return null;
  if (Number(value.version) !== WEEKLY_SNAPSHOT_VERSION) return null;
  if (String(value.uid || '') !== identity.uid) return null;
  if (String(value.weekKey || '') !== weekKey) return null;
  if (String(value.scope || '') !== identity.scope) return null;
  if (!Array.isArray(value.weeklyPlaylists)) return null;

  return {
    version: WEEKLY_SNAPSHOT_VERSION,
    uid: identity.uid,
    scope: identity.scope,
    weekKey,
    createdAt: String(value.createdAt || ''),
    weeklyPlaylists: value.weeklyPlaylists,
    weeklyAlbum: value.weeklyAlbum || null,
  };
}

function readWeeklySnapshot(identity, weekKey) {
  const file = weeklySnapshotFile(identity, weekKey);
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const normalized = normalizeWeeklySnapshot(parsed, identity, weekKey);
    if (normalized) return normalized;

    try { fs.unlinkSync(file); } catch { /* best effort */ }
    return null;
  } catch {
    return null;
  }
}

function pruneOldSnapshots(directory, maxAgeDays) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  try {
    fs.readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .forEach((name) => {
        const file = path.join(directory, name);
        try {
          const stat = fs.statSync(file);
          if (stat.mtimeMs < cutoff) fs.unlinkSync(file);
        } catch {
          // Best effort only.
        }
      });
  } catch {
    // Snapshot creation remains usable even if pruning fails.
  }
}

function establishWeeklySnapshot(identity, weekKey, generated) {
  const normalizedGenerated = normalizeWeeklySnapshot({
    version: WEEKLY_SNAPSHOT_VERSION,
    uid: identity.uid,
    scope: identity.scope,
    weekKey,
    createdAt: new Date().toISOString(),
    weeklyPlaylists: Array.isArray(generated.weeklyPlaylists)
      ? generated.weeklyPlaylists
      : [],
    weeklyAlbum: generated.weeklyAlbum || null,
  }, identity, weekKey);

  if (!normalizedGenerated) return null;

  const file = weeklySnapshotFile(identity, weekKey);
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(normalizedGenerated, null, 2),
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      },
    );
    pruneOldSnapshots(WEEKLY_SNAPSHOT_DIR, 120);
    return normalizedGenerated;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return readWeeklySnapshot(identity, weekKey) || normalizedGenerated;
    }
    throw error;
  }
}


function dailySnapshotFile(identity, dayKey) {
  const digest = crypto
    .createHash('sha256')
    .update(`${DAILY_SNAPSHOT_VERSION}\0${identity.uid}\0${dayKey}\0${identity.scope}`)
    .digest('hex');
  return path.join(DAILY_SNAPSHOT_DIR, `${digest}.json`);
}

function normalizeDailySnapshot(value, identity, dayKey) {
  if (!value || typeof value !== 'object') return null;
  if (Number(value.version) !== DAILY_SNAPSHOT_VERSION) return null;
  if (String(value.uid || '') !== identity.uid) return null;
  if (String(value.dayKey || '') !== dayKey) return null;
  if (String(value.scope || '') !== identity.scope) return null;
  if (!Object.prototype.hasOwnProperty.call(value, 'dailySong')) return null;

  return {
    version: DAILY_SNAPSHOT_VERSION,
    uid: identity.uid,
    scope: identity.scope,
    dayKey,
    createdAt: String(value.createdAt || ''),
    dailySong: value.dailySong || null,
  };
}

function readDailySnapshot(identity, dayKey) {
  const file = dailySnapshotFile(identity, dayKey);
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const normalized = normalizeDailySnapshot(parsed, identity, dayKey);
    if (normalized) return normalized;

    try { fs.unlinkSync(file); } catch { /* best effort */ }
    return null;
  } catch {
    return null;
  }
}

function establishDailySnapshot(identity, dayKey, generated) {
  const normalizedGenerated = normalizeDailySnapshot({
    version: DAILY_SNAPSHOT_VERSION,
    uid: identity.uid,
    scope: identity.scope,
    dayKey,
    createdAt: new Date().toISOString(),
    dailySong: generated.dailySong || null,
  }, identity, dayKey);

  if (!normalizedGenerated) return null;

  const file = dailySnapshotFile(identity, dayKey);
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(normalizedGenerated, null, 2),
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      },
    );
    pruneOldSnapshots(DAILY_SNAPSHOT_DIR, 45);
    return normalizedGenerated;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return readDailySnapshot(identity, dayKey) || normalizedGenerated;
    }
    throw error;
  }
}

function wrapRecommendationsHandler(handler) {
  return async function recommendationSnapshotHandler(req, res, next) {
    let identity = null;
    let dayKey = null;
    let weekKey = null;
    let existingDaily = null;
    let existingWeekly = null;

    try {
      identity = await recommendationIdentity(req);
      dayKey = identity ? validDayKey(req.body?.dayKey) : null;
      weekKey = identity ? validWeekKey(req.body?.weekKey) : null;
      existingDaily = identity && dayKey
        ? readDailySnapshot(identity, dayKey)
        : null;
      existingWeekly = identity && weekKey
        ? readWeeklySnapshot(identity, weekKey)
        : null;
    } catch (error) {
      // Snapshot persistence is an enhancement, never a reason to break Home.
      console.warn('No se pudieron preparar las snapshots de recomendaciones:', error.message);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      body = enforceStrictWeeklyThemes(body);

      if (
        identity
        && dayKey
        && body
        && typeof body === 'object'
        && Object.prototype.hasOwnProperty.call(body, 'dailySong')
      ) {
        try {
          const snapshot = existingDaily || establishDailySnapshot(identity, dayKey, body);
          if (snapshot) {
            body = {
              ...body,
              dailySong: snapshot.dailySong,
              dailySnapshot: {
                persisted: true,
                createdAt: snapshot.createdAt,
                scope: snapshot.scope,
              },
            };
          }
        } catch (error) {
          console.warn('No se pudo guardar la snapshot diaria:', error.message);
        }
      }

      if (
        identity
        && weekKey
        && body
        && typeof body === 'object'
        && Array.isArray(body.weeklyPlaylists)
      ) {
        try {
          const snapshot = existingWeekly || establishWeeklySnapshot(identity, weekKey, body);
          if (snapshot) {
            body = {
              ...body,
              weeklyPlaylists: snapshot.weeklyPlaylists,
              weeklyAlbum: snapshot.weeklyAlbum,
              weeklySnapshot: {
                persisted: true,
                createdAt: snapshot.createdAt,
                scope: snapshot.scope,
              },
            };
          }
        } catch (error) {
          console.warn('No se pudo guardar la snapshot semanal:', error.message);
        }
      }
      return originalJson(body);
    };

    return handler(req, res, next);
  };
}

express.application.post = function patchedPost(routePath, ...handlers) {
  if (routePath !== '/recommendations') {
    return originalPost.call(this, routePath, ...handlers);
  }

  const wrapped = [...handlers];
  for (let index = wrapped.length - 1; index >= 0; index -= 1) {
    if (typeof wrapped[index] !== 'function') continue;
    wrapped[index] = wrapRecommendationsHandler(wrapped[index]);
    break;
  }

  return originalPost.call(this, routePath, ...wrapped);
};

const originalGet = express.application.get;

function wrapSharedRecommendationHandler(handler) {
  return async function strictSharedRecommendationHandler(req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && Array.isArray(body.songs)) {
        const wrapped = enforceStrictWeeklyThemes({ weeklyPlaylists: [body] });
        body = wrapped.weeklyPlaylists[0] || body;
      }
      return originalJson(body);
    };
    return handler(req, res, next);
  };
}

express.application.get = function patchedGet(routePath, ...handlers) {
  if (routePath !== '/recommendations/shared/:token') {
    return originalGet.call(this, routePath, ...handlers);
  }

  const wrapped = [...handlers];
  for (let index = wrapped.length - 1; index >= 0; index -= 1) {
    if (typeof wrapped[index] !== 'function') continue;
    wrapped[index] = wrapSharedRecommendationHandler(wrapped[index]);
    break;
  }

  return originalGet.call(this, routePath, ...wrapped);
};

globalThis[PATCH_FLAG] = {
  weeklySnapshotDir: WEEKLY_SNAPSHOT_DIR,
  weeklyVersion: WEEKLY_SNAPSHOT_VERSION,
  dailySnapshotDir: DAILY_SNAPSHOT_DIR,
  dailyVersion: DAILY_SNAPSHOT_VERSION,
};
module.exports = globalThis[PATCH_FLAG];
