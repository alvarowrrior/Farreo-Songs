const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_THEME_NAME_LENGTH = 48;
const HIDDEN_SONGS_COLLECTION = 'hiddenSongs';

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
                    songs: shuffled(entries.map(entry => entry.song), random).slice(0, 24),
                    themeNames: [],
                };
            }

            const chosenCount = Math.min(themes.length, 1 + Math.floor(random() * 3));
            const chosen = shuffled(themes, random).slice(0, chosenCount);
            const chosenIds = new Set(chosen.map(theme => theme.id));
            const candidates = entries
                .map(entry => ({
                    ...entry,
                    score: entry.themeIds.filter(id => chosenIds.has(id)).length,
                    random: random(),
                }))
                .filter(entry => entry.score > 0)
                .sort((left, right) => right.score - left.score || left.random - right.random)
                .slice(0, 30)
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
                const dayKey = now.toISOString().slice(0, 10);
                const weekKey = isoWeekKey(now);
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
                res.json({ dayKey, weekKey, dailySong, weeklyPlaylists, weeklyAlbum });
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
