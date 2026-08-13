const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const MAX_THEME_NAME_LENGTH = 48;
const HIDDEN_SONGS_COLLECTION = 'hiddenSongs';
const ADMIN_SHORTS_CONFIG_VERSION = 1;
const DEFAULT_ADMIN_SHORTS_ROUND = 1;
const ADMIN_SHORTS_CLAIMS_VERSION = 1;
const ADMIN_SHORTS_CLAIM_TTL_MS = 2 * 60 * 1000;
const MAX_ADMIN_SHORTS_SESSION_ID = 128;
const ADMIN_SHORTS_LYRICS_MAX_BYTES = 2 * 1024 * 1024;
const ADMIN_SHORTS_EMBEDDED_LYRICS_VERSION = 1;

function normalizeThemeName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function seededRandom(seed) {
    const digest = crypto.createHash('sha256').update(String(seed)).digest();
    let state = digest.readUInt32LE(0) || 1;
    return () => {
        state += 0x6D2B79F5;
        let value = state;
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

function isoWeekKey(date = new Date()) {
    const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function createSongThemeStore({ storage, songsDirectory }) {
    const filePath = path.join(storage, 'song-themes.json');
    const adminShortsPath = path.join(storage, 'admin-shorts.json');
    const adminShortsClaimsPath = path.join(storage, 'admin-shorts-claims.json');
    const lyricsDirectory = path.join(storage, 'lyrics');
    fs.mkdirSync(lyricsDirectory, { recursive: true });

    const adminShortLyricsUpload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: ADMIN_SHORTS_LYRICS_MAX_BYTES, files: 1 },
        fileFilter: (req, file, cb) => {
            const ext = path.extname(String(file.originalname || '')).toLowerCase();
            if (!['.srt', '.vtt'].includes(ext)) {
                return cb(new Error('Las lyrics dinamicas deben ser un archivo .srt o .vtt.'));
            }
            cb(null, true);
        },
    });

    let catalogCache = [];
    let catalogMtimeMs = -1;

    function readCatalog() {
        if (!fs.existsSync(filePath)) {
            catalogCache = [];
            catalogMtimeMs = -1;
            return catalogCache;
        }

        try {
            const mtimeMs = fs.statSync(filePath).mtimeMs;
            if (mtimeMs === catalogMtimeMs) return catalogCache;
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const themes = Array.isArray(parsed) ? parsed : parsed.themes;
            if (!Array.isArray(themes)) {
                catalogCache = [];
                catalogMtimeMs = mtimeMs;
                return catalogCache;
            }

            catalogCache = themes
                .filter(theme => theme && typeof theme.id === 'string' && typeof theme.name === 'string')
                .map(theme => ({
                    id: theme.id,
                    name: theme.name.trim(),
                    createdAt: theme.createdAt || null,
                }))
                .filter(theme => theme.name);
            catalogMtimeMs = mtimeMs;
            return catalogCache;
        } catch (error) {
            console.error('Error leyendo song-themes.json:', error.message);
            catalogCache = [];
            catalogMtimeMs = -1;
            return catalogCache;
        }
    }

    function writeCatalog(themes) {
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify({
            version: 1,
            themes,
        }, null, 4), 'utf8');
        fs.renameSync(temporaryPath, filePath);
        catalogCache = themes;
        catalogMtimeMs = fs.statSync(filePath).mtimeMs;
    }

    function listThemes() {
        return [...readCatalog()].sort((left, right) => left.name.localeCompare(right.name, 'es', {
            sensitivity: 'base',
        }));
    }

    function sanitizeThemeIds(values) {
        if (!Array.isArray(values)) return [];
        const validIds = new Set(readCatalog().map(theme => theme.id));
        return [...new Set(values.map(String).filter(id => validIds.has(id)))];
    }

    function removeThemeFromSongs(themeId) {
        if (!songsDirectory || !fs.existsSync(songsDirectory)) return 0;
        let affectedSongs = 0;

        for (const fileName of fs.readdirSync(songsDirectory).filter(name => name.endsWith('.json'))) {
            const songPath = path.join(songsDirectory, fileName);
            try {
                const metadata = JSON.parse(fs.readFileSync(songPath, 'utf8'));
                const currentIds = Array.isArray(metadata.themeIds) ? metadata.themeIds.map(String) : [];
                if (!currentIds.includes(themeId)) continue;
                metadata.themeIds = currentIds.filter(id => id !== themeId);
                const temporaryPath = `${songPath}.${process.pid}.${Date.now()}.tmp`;
                fs.writeFileSync(temporaryPath, JSON.stringify(metadata, null, 4), 'utf8');
                fs.renameSync(temporaryPath, songPath);
                affectedSongs += 1;
            } catch (error) {
                console.error(`No se pudo quitar el tema de ${fileName}:`, error.message);
            }
        }

        return affectedSongs;
    }

    function sanitizeAdminShortRound(value, fallback = DEFAULT_ADMIN_SHORTS_ROUND) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(1, Math.min(1000000, Math.floor(parsed)));
    }

    function readAdminShortsConfig() {
        if (!fs.existsSync(adminShortsPath)) {
            const initial = {
                version: ADMIN_SHORTS_CONFIG_VERSION,
                version_global: DEFAULT_ADMIN_SHORTS_ROUND,
                updatedAt: new Date().toISOString(),
            };
            writeAdminShortsConfig(initial);
            return initial;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(adminShortsPath, 'utf8'));
            return {
                version: ADMIN_SHORTS_CONFIG_VERSION,
                version_global: sanitizeAdminShortRound(parsed.version_global),
                updatedAt: parsed.updatedAt || null,
            };
        } catch (error) {
            console.error('Error leyendo admin-shorts.json:', error.message);
            return {
                version: ADMIN_SHORTS_CONFIG_VERSION,
                version_global: DEFAULT_ADMIN_SHORTS_ROUND,
                updatedAt: null,
            };
        }
    }

    function writeAdminShortsConfig(config) {
        const normalized = {
            version: ADMIN_SHORTS_CONFIG_VERSION,
            version_global: sanitizeAdminShortRound(config.version_global),
            updatedAt: new Date().toISOString(),
        };
        const temporaryPath = `${adminShortsPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(normalized, null, 4), 'utf8');
        fs.renameSync(temporaryPath, adminShortsPath);
        return normalized;
    }

    function songMetadataPath(songId) {
        const safeId = path.basename(String(songId || ''));
        const baseName = path.parse(safeId).name;
        const resolved = path.resolve(songsDirectory, `${baseName}.json`);
        const root = path.resolve(songsDirectory);
        if (!safeId || !resolved.startsWith(root + path.sep)) return null;
        return resolved;
    }

    function writeSongMetadata(songId, metadata) {
        const targetPath = songMetadataPath(songId);
        if (!targetPath || !fs.existsSync(targetPath)) return false;
        const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(metadata, null, 4), 'utf8');
        fs.renameSync(temporaryPath, targetPath);
        return true;
    }

    function ensureAdminShortPass(songId, metadata) {
        const parsed = Number(metadata.pasada_admin_short);
        if (Number.isFinite(parsed) && parsed >= 0) {
            const normalized = Math.floor(parsed);
            if (normalized !== metadata.pasada_admin_short) {
                metadata.pasada_admin_short = normalized;
                writeSongMetadata(songId, metadata);
            }
            return normalized;
        }

        metadata.pasada_admin_short = 0;
        writeSongMetadata(songId, metadata);
        return 0;
    }


    function sanitizeAdminShortSessionId(value, required = true) {
        const sessionId = String(value || '').trim();
        if (!sessionId) {
            if (!required) return null;
            const error = new Error('Falta la sesion de Admin Shorts.');
            error.statusCode = 400;
            throw error;
        }
        if (sessionId.length > MAX_ADMIN_SHORTS_SESSION_ID || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
            const error = new Error('Sesion de Admin Shorts no valida.');
            error.statusCode = 400;
            throw error;
        }
        return sessionId;
    }

    function adminShortActor(req) {
        const user = req.albumAdmin || {};
        return {
            uid: String(user.uid || ''),
            email: String(user.email || '').trim().toLowerCase(),
        };
    }

    function sameAdminShortClaim(claim, sessionId, actor) {
        return Boolean(
            claim
            && claim.sessionId === sessionId
            && claim.uid === actor.uid
        );
    }

    function writeAdminShortClaims(claims) {
        const normalized = {
            version: ADMIN_SHORTS_CLAIMS_VERSION,
            claims,
            updatedAt: new Date().toISOString(),
        };
        const temporaryPath = `${adminShortsClaimsPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(normalized, null, 4), 'utf8');
        fs.renameSync(temporaryPath, adminShortsClaimsPath);
    }

    function readAdminShortClaims() {
        let claims = {};
        if (fs.existsSync(adminShortsClaimsPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(adminShortsClaimsPath, 'utf8'));
                claims = parsed && parsed.claims && typeof parsed.claims === 'object' && !Array.isArray(parsed.claims)
                    ? parsed.claims
                    : {};
            } catch (error) {
                console.error('Error leyendo admin-shorts-claims.json:', error.message);
            }
        }

        const now = Date.now();
        let changed = false;
        const live = {};
        for (const [songId, claim] of Object.entries(claims)) {
            if (!claim || typeof claim !== 'object' || Number(claim.expiresAt) <= now) {
                changed = true;
                continue;
            }
            live[songId] = claim;
        }
        if (changed) writeAdminShortClaims(live);
        return live;
    }

    function releaseAdminShortClaimsForSession(claims, sessionId, actor, keepSongIds = new Set()) {
        let released = 0;
        for (const [songId, claim] of Object.entries(claims)) {
            if (!sameAdminShortClaim(claim, sessionId, actor) || keepSongIds.has(songId)) continue;
            delete claims[songId];
            released += 1;
        }
        return released;
    }

    function safeLyricsPath(fileName) {
        const safeName = path.basename(String(fileName || ''));
        if (!safeName) return null;
        const resolved = path.resolve(lyricsDirectory, safeName);
        const root = path.resolve(lyricsDirectory);
        return resolved.startsWith(root + path.sep) ? resolved : null;
    }

    function deleteAdminShortLyricsFile(metadata) {
        const target = safeLyricsPath(metadata && metadata.lyricsFile);
        if (!target) return;
        try {
            if (fs.existsSync(target)) fs.unlinkSync(target);
        } catch (error) {
            console.error('No se pudieron borrar lyrics antiguas:', error.message);
        }
    }

    async function buildAdminShortSong(songId, listAllSongs, readSongMetadata) {
        const songs = await listAllSongs(true);
        const song = songs.find(item => item.id === songId);
        if (!song) return null;
        const metadata = readSongMetadata(songId);
        return {
            ...song,
            themeIds: Array.isArray(metadata.themeIds) ? metadata.themeIds.map(String) : [],
            pasada_admin_short: ensureAdminShortPass(songId, metadata),
        };
    }

    function registerRoutes({ app, requireAdmin, listAllSongs, readSongMetadata, getDb }) {
        app.get('/admin/song-themes', requireAdmin, (req, res) => {
            res.json(listThemes());
        });

        app.post('/admin/song-themes', requireAdmin, (req, res) => {
            const name = String(req.body && req.body.name || '').trim().replace(/\s+/g, ' ');
            if (!name) return res.status(400).json({ error: 'El nombre del tema es obligatorio.' });
            if (name.length > MAX_THEME_NAME_LENGTH) {
                return res.status(400).json({ error: `El tema no puede superar ${MAX_THEME_NAME_LENGTH} caracteres.` });
            }

            const themes = readCatalog();
            const normalized = normalizeThemeName(name);
            const existing = themes.find(theme => normalizeThemeName(theme.name) === normalized);
            if (existing) return res.json({ theme: existing, created: false });

            const theme = {
                id: crypto.randomUUID(),
                name,
                createdAt: new Date().toISOString(),
            };
            themes.push(theme);
            writeCatalog(themes);
            res.status(201).json({ theme, created: true });
        });

        app.delete('/admin/song-themes/:id', requireAdmin, (req, res) => {
            const themeId = String(req.params.id || '');
            const themes = readCatalog();
            const theme = themes.find(item => item.id === themeId);
            if (!theme) return res.status(404).json({ error: 'Tema no encontrado.' });

            const affectedSongs = removeThemeFromSongs(themeId);
            writeCatalog(themes.filter(item => item.id !== themeId));
            res.json({ success: true, affectedSongs });
        });

        // Admin Shorts lives entirely on the Linux media server. Songs are
        // persistent by round (pasada_admin_short) and temporarily leased to a
        // browser session while an admin is reviewing them. This keeps two
        // admins from ever receiving the same pending song at the same time.
        app.get('/admin/shorts', requireAdmin, async (req, res, next) => {
            try {
                const sessionId = sanitizeAdminShortSessionId(req.query && req.query.sessionId, false);
                const actor = adminShortActor(req);
                const config = readAdminShortsConfig();
                const claims = readAdminShortClaims();
                const songs = await listAllSongs(true);
                const eligible = songs
                    .map(song => {
                        const metadata = readSongMetadata(song.id);
                        const pass = ensureAdminShortPass(song.id, metadata);
                        return {
                            ...song,
                            themeIds: Array.isArray(metadata.themeIds) ? metadata.themeIds.map(String) : [],
                            pasada_admin_short: pass,
                        };
                    })
                    .filter(song => song.pasada_admin_short < config.version_global);

                let lockedCount = 0;
                const available = eligible.filter(song => {
                    const claim = claims[song.id];
                    if (!claim) return true;
                    if (sessionId && sameAdminShortClaim(claim, sessionId, actor)) return true;
                    lockedCount += 1;
                    return false;
                });

                res.json({
                    versionGlobal: config.version_global,
                    updatedAt: config.updatedAt,
                    totalEligible: eligible.length,
                    lockedCount,
                    songs: available,
                });
            } catch (error) {
                next(error);
            }
        });

        app.get('/admin/shorts/:songId', requireAdmin, async (req, res, next) => {
            try {
                const song = await buildAdminShortSong(String(req.params.songId || ''), listAllSongs, readSongMetadata);
                if (!song) return res.status(404).json({ error: 'Cancion no encontrada.' });
                res.json(song);
            } catch (error) {
                next(error);
            }
        });

        app.post('/admin/shorts/:songId/claim', requireAdmin, (req, res, next) => {
            try {
                const songId = String(req.params.songId || '');
                const sessionId = sanitizeAdminShortSessionId(req.body && req.body.sessionId);
                const actor = adminShortActor(req);
                const targetPath = songMetadataPath(songId);
                if (!targetPath || !fs.existsSync(targetPath)) {
                    return res.status(404).json({ error: 'Cancion no encontrada.' });
                }

                const metadata = readSongMetadata(songId);
                const config = readAdminShortsConfig();
                const pass = ensureAdminShortPass(songId, metadata);
                if (pass >= config.version_global) {
                    return res.status(409).json({
                        error: 'La cancion ya ha sido revisada en esta ronda.',
                        code: 'already-passed',
                    });
                }

                const claims = readAdminShortClaims();
                const existing = claims[songId];
                if (existing && !sameAdminShortClaim(existing, sessionId, actor)) {
                    return res.status(409).json({
                        error: 'Otro administrador esta revisando esta cancion.',
                        code: 'claimed',
                    });
                }

                const now = Date.now();
                const round = existing && sameAdminShortClaim(existing, sessionId, actor)
                    ? sanitizeAdminShortRound(existing.round, config.version_global)
                    : config.version_global;
                claims[songId] = {
                    sessionId,
                    uid: actor.uid,
                    email: actor.email,
                    round,
                    claimedAt: existing && existing.claimedAt ? existing.claimedAt : new Date(now).toISOString(),
                    heartbeatAt: new Date(now).toISOString(),
                    expiresAt: now + ADMIN_SHORTS_CLAIM_TTL_MS,
                };
                writeAdminShortClaims(claims);

                res.json({
                    success: true,
                    songId,
                    round,
                    expiresAt: claims[songId].expiresAt,
                });
            } catch (error) {
                next(error);
            }
        });

        app.post('/admin/shorts/:songId/heartbeat', requireAdmin, (req, res, next) => {
            try {
                const songId = String(req.params.songId || '');
                const sessionId = sanitizeAdminShortSessionId(req.body && req.body.sessionId);
                const actor = adminShortActor(req);
                const claims = readAdminShortClaims();
                const claim = claims[songId];
                if (!sameAdminShortClaim(claim, sessionId, actor)) {
                    return res.status(409).json({
                        error: 'La reserva de esta cancion ya no pertenece a esta sesion.',
                        code: 'claimed',
                    });
                }

                const now = Date.now();
                claim.heartbeatAt = new Date(now).toISOString();
                claim.expiresAt = now + ADMIN_SHORTS_CLAIM_TTL_MS;
                writeAdminShortClaims(claims);
                res.json({ success: true, songId, expiresAt: claim.expiresAt });
            } catch (error) {
                next(error);
            }
        });

        app.delete('/admin/shorts/:songId/claim', requireAdmin, (req, res, next) => {
            try {
                const songId = String(req.params.songId || '');
                const sessionId = sanitizeAdminShortSessionId(req.body && req.body.sessionId);
                const actor = adminShortActor(req);
                const claims = readAdminShortClaims();
                const claim = claims[songId];
                if (claim && !sameAdminShortClaim(claim, sessionId, actor)) {
                    return res.status(409).json({
                        error: 'La reserva pertenece a otra sesion.',
                        code: 'claimed',
                    });
                }
                if (claim) {
                    delete claims[songId];
                    writeAdminShortClaims(claims);
                }
                res.json({ success: true });
            } catch (error) {
                next(error);
            }
        });

        app.delete('/admin/shorts/claims', requireAdmin, (req, res, next) => {
            try {
                const sessionId = sanitizeAdminShortSessionId(req.body && req.body.sessionId);
                const actor = adminShortActor(req);
                const claims = readAdminShortClaims();
                const released = releaseAdminShortClaimsForSession(claims, sessionId, actor);
                if (released > 0) writeAdminShortClaims(claims);
                res.json({ success: true, released });
            } catch (error) {
                next(error);
            }
        });

        app.patch('/admin/shorts/version', requireAdmin, (req, res, next) => {
            try {
                const requested = req.body && (req.body.versionGlobal ?? req.body.version_global);
                const parsed = Number(requested);
                if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000000) {
                    return res.status(400).json({ error: 'La ronda global debe ser un entero entre 1 y 1000000.' });
                }

                const config = writeAdminShortsConfig({ version_global: parsed });
                res.json({
                    success: true,
                    versionGlobal: config.version_global,
                    updatedAt: config.updatedAt,
                });
            } catch (error) {
                next(error);
            }
        });

        app.put(
            '/admin/shorts/:songId/lyrics',
            requireAdmin,
            adminShortLyricsUpload.single('lyrics'),
            async (req, res, next) => {
                try {
                    const songId = String(req.params.songId || '');
                    const targetPath = songMetadataPath(songId);
                    if (!targetPath || !fs.existsSync(targetPath)) {
                        return res.status(404).json({ error: 'Cancion no encontrada.' });
                    }

                    const mode = String(req.body && req.body.mode || '').toLowerCase();
                    if (!['none', 'static', 'dynamic'].includes(mode)) {
                        return res.status(400).json({ error: 'Modo de lyrics no valido.' });
                    }

                    const metadata = readSongMetadata(songId);

                    if (mode === 'none') {
                        deleteAdminShortLyricsFile(metadata);
                        delete metadata.lyricsFile;
                        delete metadata.lyricsOriginalName;
                        delete metadata.staticLyrics;
                        delete metadata.staticLyricsSource;
                        metadata.embeddedLyricsVersion = ADMIN_SHORTS_EMBEDDED_LYRICS_VERSION;
                        metadata.embeddedLyricsCheckedAt = new Date().toISOString();
                    } else if (mode === 'static') {
                        const text = String(req.body && req.body.staticLyrics || '').replace(/\r/g, '').trim();
                        if (!text) return res.status(400).json({ error: 'Escribe las lyrics estaticas antes de aplicar.' });
                        deleteAdminShortLyricsFile(metadata);
                        delete metadata.lyricsFile;
                        delete metadata.lyricsOriginalName;
                        metadata.staticLyrics = text;
                        metadata.staticLyricsSource = 'admin-shorts';
                        metadata.embeddedLyricsVersion = ADMIN_SHORTS_EMBEDDED_LYRICS_VERSION;
                        metadata.embeddedLyricsCheckedAt = new Date().toISOString();
                    } else {
                        if (req.file) {
                            const ext = path.extname(String(req.file.originalname || '')).toLowerCase();
                            const fileName = `${Date.now()}_${crypto.randomUUID()}${ext}`;
                            const destination = safeLyricsPath(fileName);
                            if (!destination) return res.status(400).json({ error: 'Nombre de archivo de lyrics no valido.' });
                            deleteAdminShortLyricsFile(metadata);
                            fs.writeFileSync(destination, req.file.buffer);
                            metadata.lyricsFile = fileName;
                            metadata.lyricsOriginalName = req.file.originalname;
                        } else if (!metadata.lyricsFile) {
                            return res.status(400).json({
                                error: 'Sube un SRT/VTT o crea las lyrics en el editor antes de aplicar el modo dinamico.',
                            });
                        }
                        delete metadata.staticLyrics;
                        delete metadata.staticLyricsSource;
                        metadata.embeddedLyricsVersion = ADMIN_SHORTS_EMBEDDED_LYRICS_VERSION;
                        metadata.embeddedLyricsCheckedAt = new Date().toISOString();
                    }

                    if (!writeSongMetadata(songId, metadata)) {
                        return res.status(404).json({ error: 'Metadatos de cancion no encontrados.' });
                    }

                    const song = await buildAdminShortSong(songId, listAllSongs, readSongMetadata);
                    res.json({ success: true, song });
                } catch (error) {
                    next(error);
                }
            },
        );

        app.post('/admin/shorts/:songId/pass', requireAdmin, (req, res, next) => {
            try {
                const songId = String(req.params.songId || '');
                const sessionId = sanitizeAdminShortSessionId(req.body && req.body.sessionId);
                const actor = adminShortActor(req);
                const targetPath = songMetadataPath(songId);
                if (!targetPath || !fs.existsSync(targetPath)) {
                    return res.status(404).json({ error: 'Cancion no encontrada.' });
                }

                const metadata = readSongMetadata(songId);
                const config = readAdminShortsConfig();
                const currentPass = ensureAdminShortPass(songId, metadata);
                const claims = readAdminShortClaims();
                const claim = claims[songId];

                if (!claim) {
                    if (currentPass >= config.version_global) {
                        return res.json({
                            success: true,
                            songId,
                            pasada_admin_short: currentPass,
                            passedRound: currentPass,
                            versionGlobal: config.version_global,
                        });
                    }
                    return res.status(409).json({
                        error: 'La cancion ya no esta reservada para esta sesion.',
                        code: 'claim-required',
                    });
                }
                if (!sameAdminShortClaim(claim, sessionId, actor)) {
                    return res.status(409).json({
                        error: 'Otro administrador esta revisando esta cancion.',
                        code: 'claimed',
                    });
                }

                const passedRound = sanitizeAdminShortRound(claim.round, config.version_global);
                metadata.pasada_admin_short = Math.max(currentPass, passedRound);
                if (!writeSongMetadata(songId, metadata)) {
                    return res.status(404).json({ error: 'Metadatos de cancion no encontrados.' });
                }

                delete claims[songId];
                writeAdminShortClaims(claims);

                res.json({
                    success: true,
                    songId,
                    pasada_admin_short: metadata.pasada_admin_short,
                    passedRound,
                    versionGlobal: config.version_global,
                });
            } catch (error) {
                next(error);
            }
        });

        async function publicSongData() {
            const songs = await listAllSongs(true);
            const hidden = await (await getDb()).collection(HIDDEN_SONGS_COLLECTION).get();
            const hiddenIds = new Set(hidden.docs.flatMap(doc => {
                const songId = doc.data() && doc.data().songId;
                return [doc.id, songId].filter(Boolean).map(String);
            }));

            return songs
                .filter(song => !hiddenIds.has(song.id))
                .map(song => ({
                    song,
                    themeIds: readSongMetadata(song.id).themeIds,
                }));
        }

        function buildTastePlaylist(entries, seed, index) {
            const random = seededRandom(`${seed}:taste:${index}`);
            const themes = listThemes().filter(theme => entries.some(entry => entry.themeIds.includes(theme.id)));
            if (themes.length === 0) {
                return {
                    id: `weekly-${crypto.createHash('sha1').update(`${seed}:${index}`).digest('hex').slice(0, 12)}`,
                    name: 'Seleccion semanal',
                    songs: shuffled(entries.map(entry => entry.song), random).slice(0, 16),
                    themeNames: [],
                };
            }

            const shuffledThemes = shuffled(themes, random);
            const chosenCount = Math.min(shuffledThemes.length, 1 + Math.floor(random() * 3));
            const chosen = shuffledThemes.slice(0, chosenCount);
            const candidateCount = () => {
                const ids = new Set(chosen.map(theme => theme.id));
                return entries.filter(entry => entry.themeIds.some(id => ids.has(id))).length;
            };

            // La seleccion empieza con uno a tres gustos. Si no alcanzan para
            // formar una playlist util, incorpora temas adicionales antes de
            // recurrir a canciones de relleno.
            while (chosen.length < shuffledThemes.length && candidateCount() < 8) {
                chosen.push(shuffledThemes[chosen.length]);
            }

            const chosenIds = new Set(chosen.map(theme => theme.id));
            const scoredCandidates = entries
                .map(entry => ({
                    ...entry,
                    score: entry.themeIds.filter(id => chosenIds.has(id)).length,
                    random: random(),
                }))
                .filter(entry => entry.score > 0)
                .sort((left, right) => right.score - left.score || left.random - right.random);
            const selectedIds = new Set(scoredCandidates.map(entry => entry.song.id));
            const filler = shuffled(entries.filter(entry => !selectedIds.has(entry.song.id)), random)
                .map(entry => ({ ...entry, score: 0, random: random() }));
            const candidates = [...scoredCandidates, ...filler]
                .slice(0, Math.min(16, entries.length))
                .map(entry => entry.song);
            const names = chosen.map(theme => theme.name);
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

        app.get('/songs/:songId/similar', async (req, res, next) => {
            try {
                const entries = await publicSongData();
                const source = entries.find(entry => entry.song.id === req.params.songId);
                if (!source || source.themeIds.length === 0) return res.json([]);
                const sourceThemes = new Set(source.themeIds);
                const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
                const results = entries
                    .filter(entry => entry.song.id !== source.song.id)
                    .map(entry => ({
                        song: entry.song,
                        sharedThemeCount: entry.themeIds.filter(id => sourceThemes.has(id)).length,
                        random: Math.random(),
                    }))
                    .filter(entry => entry.sharedThemeCount > 0)
                    .sort((left, right) => right.sharedThemeCount - left.sharedThemeCount || left.random - right.random)
                    .slice(0, limit)
                    .map(entry => entry.song);
                res.json(results);
            } catch (error) { next(error); }
        });

        app.post('/recommendations', async (req, res, next) => {
            try {
                const clientSeed = String(req.body && req.body.clientSeed || '').slice(0, 128) || crypto.randomUUID();
                const heardIds = new Set(Array.isArray(req.body && req.body.heardSongIds)
                    ? req.body.heardSongIds.slice(0, 10000).map(String)
                    : []);
                const now = new Date();
                const requestedDayKey = String(req.body && req.body.dayKey || '');
                const requestedWeekKey = String(req.body && req.body.weekKey || '');
                const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(requestedDayKey)
                    ? requestedDayKey
                    : now.toISOString().slice(0, 10);
                const weekKey = /^\d{4}-\d{2}-\d{2}$/.test(requestedWeekKey)
                    ? requestedWeekKey
                    : isoWeekKey(now);
                const entries = await publicSongData();
                const dailyPool = entries.filter(entry => !heardIds.has(entry.song.id));
                const dailyCandidates = dailyPool.length > 0 ? dailyPool : entries;
                const dailyRandom = seededRandom(`${clientSeed}:${dayKey}:daily`);
                const dailySong = dailyCandidates.length > 0
                    ? dailyCandidates[Math.floor(dailyRandom() * dailyCandidates.length)].song
                    : null;

                let albums = [];
                try {
                    const albumDocs = await (await getDb()).collection('albums').get();
                    albums = albumDocs.docs.map(doc => {
                        const data = doc.data() || {};
                        return {
                            id: doc.id,
                            nombre: String(data.nombre || 'Album sin nombre'),
                            iconUrl: typeof data.iconUrl === 'string' ? data.iconUrl : null,
                            numCanciones: Math.max(0, Number(data.trackCount) || 0),
                            revelationEnabled: Boolean(data.revelationEnabled),
                            followerCount: Math.max(0, Number(data.followerCount) || 0),
                        };
                    });
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
                res.json({ dayKey, weekKey, dailySong, dailySongUnheard: dailyPool.length > 0, weeklyPlaylists, weeklyAlbum });
            } catch (error) { next(error); }
        });

        app.get('/recommendations/shared/:token', async (req, res, next) => {
            try {
                const payload = JSON.parse(Buffer.from(String(req.params.token || ''), 'base64url').toString('utf8'));
                if (!payload || typeof payload.seed !== 'string' || typeof payload.week !== 'string' || !Number.isInteger(payload.index)) {
                    return res.status(400).json({ error: 'Recomendacion no valida.' });
                }
                const entries = await publicSongData();
                const playlist = buildTastePlaylist(entries, `${payload.seed}:${payload.week}`, payload.index);
                res.json(playlist);
            } catch (error) {
                if (error instanceof SyntaxError) return res.status(400).json({ error: 'Recomendacion no valida.' });
                next(error);
            }
        });
    }

    return {
        listThemes,
        sanitizeThemeIds,
        registerRoutes,
    };
}

module.exports = { createSongThemeStore };
