const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALBUMS = 'albums';
const FOLLOWS = 'albumFollows';
const PROGRESS = 'albumRevealProgress';
const HIDDEN_SONGS = 'hiddenSongs';
const ADMIN_CACHE_MS = 5 * 60 * 1000;
const MAX_RELEASE_TIMER_MS = 2_147_000_000;
const FARREO_WEB_URL = String(process.env.FARREO_WEB_URL || 'https://farreo.vercel.app').replace(/\/+$/, '');

function loadOrCreateVisitorSecret() {
    const secretDir = path.join(__dirname, 'almacenamiento_compartido', 'albums');
    const secretPath = path.join(secretDir, 'visitor-secret');
    fs.mkdirSync(secretDir, { recursive: true });

    try {
        const existing = fs.readFileSync(secretPath, 'utf8').trim();
        if (existing.length >= 64) return existing;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const generated = crypto.randomBytes(32).toString('hex');
    try {
        fs.writeFileSync(secretPath, generated, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        return generated;
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = fs.readFileSync(secretPath, 'utf8').trim();
        if (existing.length < 64) throw new Error('El secreto de visitantes de albumes no es valido.');
        return existing;
    }
}

function registerAlbumRoutes({
    app,
    getDb,
    listAllSongs,
    uploadIcon,
    optimizeIcon,
    deleteIcon,
}) {
    const localAdminEmails = new Set(String(process.env.NEXT_PUBLIC_ADMIN_EMAILS || '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean));
    const visitorSecret = loadOrCreateVisitorSecret();
    let adminCache = { emails: new Set(), expiresAt: 0 };
    const releaseTimers = new Map();

    async function getGeneralAdminEmails() {
        const now = Date.now();
        if (adminCache.expiresAt > now && adminCache.emails.size > 0) return adminCache.emails;

        try {
            const response = await fetch(`${FARREO_WEB_URL}/api/admins`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(4000),
            });
            if (!response.ok) throw new Error(`Farreo respondio ${response.status}`);
            const data = await response.json();
            const emails = new Set((Array.isArray(data.emails) ? data.emails : [])
                .map(value => String(value).trim().toLowerCase())
                .filter(Boolean));
            if (emails.size === 0) throw new Error('Farreo no tiene administradores generales configurados.');
            adminCache = { emails, expiresAt: now + ADMIN_CACHE_MS };
            return emails;
        } catch (error) {
            if (adminCache.emails.size > 0) return adminCache.emails;
            if (localAdminEmails.size > 0) return localAdminEmails;
            const configError = new Error(`No se pudo obtener la lista general de administradores: ${error.message}`);
            configError.statusCode = 503;
            throw configError;
        }
    }

    const iso = value => {
        if (!value) return null;
        if (typeof value === 'string') return value;
        if (typeof value.toDate === 'function') return value.toDate().toISOString();
        if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString();
        return null;
    };

    const parseBoolean = value => value === true || value === 'true' || value === '1';
    const safeDate = value => {
        if (!value) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    };
    const bearer = req => {
        const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
        return match ? match[1] : null;
    };
    const base64url = value => Buffer.from(value).toString('base64url');
    const signVisitor = payload => {
        if (!visitorSecret) return null;
        const encoded = base64url(JSON.stringify(payload));
        const signature = crypto.createHmac('sha256', visitorSecret).update(encoded).digest('base64url');
        return `${encoded}.${signature}`;
    };
    const verifyVisitor = token => {
        if (!visitorSecret || !token || !token.includes('.')) return null;
        const [encoded, signature] = token.split('.', 2);
        const expected = crypto.createHmac('sha256', visitorSecret).update(encoded).digest('base64url');
        const left = Buffer.from(signature || '');
        const right = Buffer.from(expected);
        if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
        try {
            const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
            return typeof payload.id === 'string' && payload.id ? payload : null;
        } catch {
            return null;
        }
    };

    async function firebaseAdmin() {
        await getDb();
        return require('firebase-admin');
    }

    async function optionalUser(req) {
        const token = bearer(req);
        if (!token) return null;
        try {
            const admin = await firebaseAdmin();
            return await admin.auth().verifyIdToken(token);
        } catch {
            return null;
        }
    }

    async function actor(req, required = false) {
        const user = await optionalUser(req);
        if (user) return { key: `user:${user.uid}`, user };
        const visitor = verifyVisitor(req.headers['x-farreo-visitor-token']);
        if (visitor) return { key: `visitor:${visitor.id}`, visitor };
        if (required) {
            const error = new Error('Se necesita una sesion de album valida.');
            error.statusCode = 401;
            throw error;
        }
        return null;
    }

    async function requireAdmin(req, res, next) {
        try {
            const user = await optionalUser(req);
            const email = String(user && user.email || '').toLowerCase();
            if (!user) return res.status(401).json({ error: 'Autenticacion requerida.' });
            const adminEmails = await getGeneralAdminEmails();
            if (!adminEmails.has(email)) return res.status(403).json({ error: 'Permisos de administrador requeridos.' });
            req.albumAdmin = user;
            next();
        } catch (error) {
            next(error);
        }
    }

    const progressId = (actorKey, albumId, version) => crypto
        .createHash('sha256')
        .update(`${actorKey}\u0000${albumId}\u0000${version}`)
        .digest('hex');

    async function getProgress(db, currentActor, albumId, version) {
        if (!currentActor) return { revealed: new Set(), firstPlayed: new Set() };
        const snap = await db.collection(PROGRESS).doc(progressId(currentActor.key, albumId, version)).get();
        const data = snap.exists ? snap.data() || {} : {};
        return {
            revealed: new Set(Array.isArray(data.revealedEntryIds) ? data.revealedEntryIds.map(String) : []),
            firstPlayed: new Set(Array.isArray(data.firstPlayedEntryIds) ? data.firstPlayedEntryIds.map(String) : []),
        };
    }

    async function albumTracks(albumRef) {
        const snap = await albumRef.collection('tracks').orderBy('position', 'asc').get();
        return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    const releaseTimerKey = (albumId, entryId) => `${albumId}:${entryId}`;

    function cancelReleaseTimer(albumId, entryId) {
        const key = releaseTimerKey(albumId, entryId);
        const scheduled = releaseTimers.get(key);
        if (scheduled) clearTimeout(scheduled.timeout);
        releaseTimers.delete(key);
    }

    function cancelAlbumReleaseTimers(albumId) {
        const prefix = `${albumId}:`;
        for (const [key, scheduled] of releaseTimers) {
            if (!key.startsWith(prefix)) continue;
            clearTimeout(scheduled.timeout);
            releaseTimers.delete(key);
        }
    }

    function scheduleReleaseUnhide(albumId, entry) {
        const entryId = String(entry.id || '');
        const songId = String(entry.songId || '');
        const releaseAt = iso(entry.releaseAt);
        const releaseTime = releaseAt ? new Date(releaseAt).getTime() : NaN;
        cancelReleaseTimer(albumId, entryId);
        if (!entryId || !songId || !Number.isFinite(releaseTime)) return;

        const key = releaseTimerKey(albumId, entryId);
        const token = Symbol(key);
        const arm = () => {
            const remaining = releaseTime - Date.now();
            if (remaining > 0) {
                const timeout = setTimeout(arm, Math.min(remaining, MAX_RELEASE_TIMER_MS));
                timeout.unref?.();
                releaseTimers.set(key, { timeout, token });
                return;
            }

            const timeout = setTimeout(async () => {
                if (releaseTimers.get(key)?.token !== token) return;
                try {
                    const db = await getDb();
                    const albumRef = db.collection(ALBUMS).doc(albumId);
                    const trackRef = albumRef.collection('tracks').doc(entryId);
                    const result = await db.runTransaction(async transaction => {
                        const trackSnap = await transaction.get(trackRef);
                        if (!trackSnap.exists) return { state: 'missing' };
                        const trackData = trackSnap.data() || {};
                        const currentReleaseAt = iso(trackData.releaseAt);
                        const currentReleaseTime = currentReleaseAt ? new Date(currentReleaseAt).getTime() : NaN;
                        if (!Number.isFinite(currentReleaseTime)) return { state: 'unscheduled' };
                        if (currentReleaseTime > Date.now()) {
                            return { state: 'future', entry: { id: entryId, ...trackData } };
                        }

                        const currentSongId = String(trackData.songId || '');
                        if (!currentSongId) return { state: 'missing-song' };
                        const hiddenRef = db.collection(HIDDEN_SONGS).doc(currentSongId);
                        const hiddenSnap = await transaction.get(hiddenRef);
                        if (hiddenSnap.exists) transaction.delete(hiddenRef);
                        return { state: 'released', songId: currentSongId, wasHidden: hiddenSnap.exists };
                    });

                    if (releaseTimers.get(key)?.token !== token) return;
                    if (result.state === 'future') {
                        scheduleReleaseUnhide(albumId, result.entry);
                        return;
                    }

                    releaseTimers.delete(key);
                    if (result.state === 'released') {
                        await updateAlbumCounts(albumRef);
                        if (result.wasHidden) {
                            console.log(`Cancion ${result.songId} desocultada automaticamente por estreno del album ${albumId}.`);
                        }
                    }
                } catch (error) {
                    if (releaseTimers.get(key)?.token !== token) return;
                    console.error(`No se pudo procesar el estreno ${albumId}/${entryId}:`, error);
                    const retry = setTimeout(arm, 60_000);
                    retry.unref?.();
                    releaseTimers.set(key, { timeout: retry, token });
                }
            }, 0);
            timeout.unref?.();
            releaseTimers.set(key, { timeout, token });
        };

        arm();
    }

    async function restoreReleaseSchedules() {
        const db = await getDb();
        const albums = await db.collection(ALBUMS).get();
        for (const album of albums.docs) {
            const entries = await albumTracks(album.ref);
            entries.forEach(entry => scheduleReleaseUnhide(album.id, entry));
        }
    }

    const albumCard = (doc, data) => ({
        id: doc.id,
        nombre: String(data.nombre || 'Album sin nombre'),
        iconUrl: typeof data.iconUrl === 'string' ? data.iconUrl : null,
        numCanciones: Number(data.trackCount) || 0,
        scheduledCount: Math.max(0, Number(data.scheduledCount) || 0),
        revelationEnabled: Boolean(data.revelationEnabled),
        revelationVersion: Math.max(1, Number(data.revelationVersion) || 1),
        followerCount: Math.max(0, Number(data.followerCount) || 0),
        createdAt: iso(data.createdAt),
        updatedAt: iso(data.updatedAt),
    });

    async function buildAlbumResponse(albumDoc, req, adminView = false) {
        const db = await getDb();
        const data = albumDoc.data() || {};
        const currentActor = adminView ? null : await actor(req, false);
        const version = Math.max(1, Number(data.revelationVersion) || 1);
        const progress = adminView
            ? { revealed: new Set(), firstPlayed: new Set() }
            : await getProgress(db, currentActor, albumDoc.id, version);
        const entries = await albumTracks(albumDoc.ref);
        const songs = await listAllSongs(true);
        const songsById = new Map(songs.map(song => [song.id, song]));
        const now = Date.now();

        const tracks = entries.map(entry => {
            const releaseAt = iso(entry.releaseAt);
            const releaseTime = releaseAt ? new Date(releaseAt).getTime() : 0;
            const scheduled = Number.isFinite(releaseTime) && releaseTime > now;
            const song = songsById.get(String(entry.songId || '')) || null;
            const base = {
                entryId: entry.id,
                position: Number(entry.position) || 0,
                addedAt: iso(entry.addedAt),
                releaseAt,
            };

            if (adminView) return { ...base, state: scheduled ? 'scheduled' : 'normal', song };
            if (scheduled) return { ...base, state: 'scheduled' };
            if (data.revelationEnabled && !progress.revealed.has(entry.id)) {
                return { ...base, state: 'mystery' };
            }
            return {
                ...base,
                state: data.revelationEnabled ? 'revealed' : 'normal',
                song: song ? {
                    ...song,
                    albumId: albumDoc.id,
                    albumEntryId: entry.id,
                    firstListenPending: Boolean(data.revelationEnabled && !progress.firstPlayed.has(entry.id)),
                } : null,
            };
        });

        const futureCount = tracks.filter(track => track.state === 'scheduled').length;
        return {
            ...albumCard(albumDoc, data),
            tracks,
            serverTime: now,
            futureCount,
            fullyPublished: !data.revelationEnabled && futureCount === 0,
            isFollowing: Boolean(currentActor && currentActor.user && await db.collection(FOLLOWS)
                .doc(`${currentActor.user.uid}_${albumDoc.id}`).get().then(snap => snap.exists)),
        };
    }

    async function getAlbum(albumId) {
        const db = await getDb();
        const snap = await db.collection(ALBUMS).doc(String(albumId || '')).get();
        return snap.exists ? snap : null;
    }

    async function updateAlbumCounts(albumRef) {
        const db = await getDb();
        const entries = await albumTracks(albumRef);
        const futureCount = entries.filter(entry => {
            const releaseAt = iso(entry.releaseAt);
            return releaseAt && new Date(releaseAt).getTime() > Date.now();
        }).length;
        const admin = await firebaseAdmin();
        await albumRef.set({
            trackCount: entries.length,
            scheduledCount: futureCount,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
    }

    app.post('/album-session', (req, res) => {
        const payload = { id: crypto.randomUUID(), issuedAt: Date.now() };
        res.json({ token: signVisitor(payload) });
    });

    app.get('/albums', async (req, res, next) => {
        try {
            const db = await getDb();
            const snap = await db.collection(ALBUMS).get();
            let followed = new Map();
            const currentActor = await actor(req, false);
            if (currentActor && currentActor.user) {
                const follows = await db.collection(FOLLOWS).where('userId', '==', currentActor.user.uid).get();
                followed = new Map(follows.docs.map(doc => [String(doc.data().albumId), doc.data()]));
            }
            const albums = snap.docs.map(doc => {
                const card = albumCard(doc, doc.data() || {});
                const follow = followed.get(doc.id);
                return {
                    ...card,
                    isFollowing: Boolean(follow),
                    followedAt: follow ? iso(follow.createdAt) : null,
                    lastOpenedAt: follow ? iso(follow.lastOpenedAt) : null,
                };
            }).sort((a, b) => {
                if (a.revelationEnabled !== b.revelationEnabled) return a.revelationEnabled ? -1 : 1;
                return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
            });
            res.json(albums);
        } catch (error) { next(error); }
    });

    app.get('/songs/:songId/albums', async (req, res, next) => {
        try {
            const db = await getDb();
            const songId = String(req.params.songId || '');
            if (!songId) return res.json([]);
            const hidden = await db.collection(HIDDEN_SONGS).doc(songId).get();
            if (hidden.exists) return res.json([]);

            const currentActor = await actor(req, false);
            const albums = await db.collection(ALBUMS).get();
            const matches = [];
            for (const albumDoc of albums.docs) {
                const data = albumDoc.data() || {};
                const tracks = await albumTracks(albumDoc.ref);
                const matchingTrack = tracks.find(track => String(track.songId || '') === songId);
                if (!matchingTrack) continue;
                const releaseAt = iso(matchingTrack.releaseAt);
                if (releaseAt && new Date(releaseAt).getTime() > Date.now()) continue;

                if (data.revelationEnabled) {
                    const progress = await getProgress(db, currentActor, albumDoc.id, Math.max(1, Number(data.revelationVersion) || 1));
                    if (!progress.revealed.has(matchingTrack.id)) continue;
                }

                let follow = null;
                if (currentActor && currentActor.user) {
                    follow = await db.collection(FOLLOWS).doc(`${currentActor.user.uid}_${albumDoc.id}`).get();
                }
                matches.push({
                    ...albumCard(albumDoc, data),
                    isFollowing: Boolean(follow && follow.exists),
                    followedAt: follow && follow.exists ? iso(follow.data().createdAt) : null,
                });
            }
            res.json(matches.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()));
        } catch (error) { next(error); }
    });

    app.get('/albums/:id', async (req, res, next) => {
        try {
            const album = await getAlbum(req.params.id);
            if (!album) return res.status(404).json({ error: 'Album no encontrado.' });
            res.json(await buildAlbumResponse(album, req, false));
        } catch (error) { next(error); }
    });

    app.get('/admin/albums/:id', requireAdmin, async (req, res, next) => {
        try {
            const album = await getAlbum(req.params.id);
            if (!album) return res.status(404).json({ error: 'Album no encontrado.' });
            res.json(await buildAlbumResponse(album, req, true));
        } catch (error) { next(error); }
    });

    app.post('/albums/:id/tracks/:entryId/reveal', async (req, res, next) => {
        try {
            const currentActor = await actor(req, true);
            const db = await getDb();
            const albumRef = db.collection(ALBUMS).doc(req.params.id);
            const trackRef = albumRef.collection('tracks').doc(req.params.entryId);
            const [albumSnap, trackSnap] = await Promise.all([albumRef.get(), trackRef.get()]);
            if (!albumSnap.exists || !trackSnap.exists) return res.status(404).json({ error: 'Pista de album no encontrada.' });
            const albumData = albumSnap.data() || {};
            if (!albumData.revelationEnabled) {
                return res.status(409).json({ error: 'Este album ya no esta en modo Revelacion.' });
            }
            const releaseAt = iso(trackSnap.data().releaseAt);
            if (releaseAt && new Date(releaseAt).getTime() > Date.now()) {
                return res.status(423).json({ error: 'Esta pista aun no se ha estrenado.', releaseAt });
            }
            const version = Math.max(1, Number(albumData.revelationVersion) || 1);
            const ref = db.collection(PROGRESS).doc(progressId(currentActor.key, req.params.id, version));
            const songs = await listAllSongs(true);
            const song = songs.find(item => item.id === String(trackSnap.data().songId || ''));
            if (!song) return res.status(404).json({ error: 'La cancion asociada ya no existe.' });
            const admin = await firebaseAdmin();
            await ref.set({
                actorKey: currentActor.key,
                userId: currentActor.user ? currentActor.user.uid : null,
                albumId: req.params.id,
                revelationVersion: version,
                revealedEntryIds: admin.firestore.FieldValue.arrayUnion(req.params.entryId),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            res.json({
                entryId: req.params.entryId,
                variant: Math.floor(Math.random() * 3),
                song: { ...song, albumId: req.params.id, albumEntryId: req.params.entryId, firstListenPending: Boolean(albumData.revelationEnabled) },
            });
        } catch (error) { next(error); }
    });

    app.post('/albums/:id/tracks/:entryId/first-play', async (req, res, next) => {
        try {
            const currentActor = await actor(req, true);
            const db = await getDb();
            const albumRef = db.collection(ALBUMS).doc(req.params.id);
            const trackRef = albumRef.collection('tracks').doc(req.params.entryId);
            const [albumSnap, trackSnap] = await Promise.all([albumRef.get(), trackRef.get()]);
            if (!albumSnap.exists || !trackSnap.exists) return res.status(404).json({ error: 'Pista de album no encontrada.' });
            const albumData = albumSnap.data() || {};
            if (!albumData.revelationEnabled) return res.json({ forcePitch: false, firstPlay: false });
            const releaseAt = iso(trackSnap.data().releaseAt);
            if (releaseAt && new Date(releaseAt).getTime() > Date.now()) return res.status(423).json({ error: 'Esta pista aun no se ha estrenado.' });
            const version = Math.max(1, Number(albumData.revelationVersion) || 1);
            const ref = db.collection(PROGRESS).doc(progressId(currentActor.key, req.params.id, version));
            const firstPlay = await db.runTransaction(async transaction => {
                const snap = await transaction.get(ref);
                const progressData = snap.exists ? snap.data() || {} : {};
                const revealed = Array.isArray(progressData.revealedEntryIds) ? progressData.revealedEntryIds.map(String) : [];
                if (!revealed.includes(req.params.entryId)) {
                    throw Object.assign(new Error('Primero debes revelar esta pista.'), { statusCode: 409 });
                }
                const values = Array.isArray(progressData.firstPlayedEntryIds) ? progressData.firstPlayedEntryIds.map(String) : [];
                if (values.includes(req.params.entryId)) return false;
                const admin = await firebaseAdmin();
                transaction.set(ref, {
                    actorKey: currentActor.key,
                    userId: currentActor.user ? currentActor.user.uid : null,
                    albumId: req.params.id,
                    revelationVersion: version,
                    firstPlayedEntryIds: [...values, req.params.entryId],
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }, { merge: true });
                return true;
            });
            res.json({ forcePitch: firstPlay, firstPlay });
        } catch (error) { next(error); }
    });

    app.post('/albums/:id/follow', async (req, res, next) => {
        try {
            const currentActor = await actor(req, true);
            if (!currentActor.user) return res.status(401).json({ error: 'Inicia sesion para seguir albumes.' });
            const db = await getDb();
            const albumRef = db.collection(ALBUMS).doc(req.params.id);
            const followRef = db.collection(FOLLOWS).doc(`${currentActor.user.uid}_${req.params.id}`);
            const admin = await firebaseAdmin();
            await db.runTransaction(async transaction => {
                const [albumSnap, followSnap] = await Promise.all([transaction.get(albumRef), transaction.get(followRef)]);
                if (!albumSnap.exists) throw Object.assign(new Error('Album no encontrado.'), { statusCode: 404 });
                transaction.set(followRef, {
                    userId: currentActor.user.uid,
                    userEmail: currentActor.user.email || null,
                    albumId: req.params.id,
                    createdAt: followSnap.exists ? followSnap.data().createdAt : admin.firestore.FieldValue.serverTimestamp(),
                    lastOpenedAt: admin.firestore.FieldValue.serverTimestamp(),
                }, { merge: true });
                if (!followSnap.exists) transaction.update(albumRef, { followerCount: admin.firestore.FieldValue.increment(1) });
            });
            res.json({ success: true });
        } catch (error) { next(error); }
    });

    app.delete('/albums/:id/follow', async (req, res, next) => {
        try {
            const currentActor = await actor(req, true);
            if (!currentActor.user) return res.status(401).json({ error: 'Inicia sesion para dejar de seguir albumes.' });
            const db = await getDb();
            const albumRef = db.collection(ALBUMS).doc(req.params.id);
            const followRef = db.collection(FOLLOWS).doc(`${currentActor.user.uid}_${req.params.id}`);
            await db.runTransaction(async transaction => {
                const [followSnap, albumSnap] = await Promise.all([transaction.get(followRef), transaction.get(albumRef)]);
                if (!followSnap.exists) return;
                transaction.delete(followRef);
                const currentCount = albumSnap.exists ? Math.max(0, Number(albumSnap.data().followerCount) || 0) : 0;
                transaction.set(albumRef, { followerCount: Math.max(0, currentCount - 1) }, { merge: true });
            });
            res.json({ success: true });
        } catch (error) { next(error); }
    });

    app.post('/albums/:id/touch', async (req, res, next) => {
        try {
            const currentActor = await actor(req, true);
            if (!currentActor.user) return res.json({ success: true });
            const db = await getDb();
            const admin = await firebaseAdmin();
            await db.collection(FOLLOWS).doc(`${currentActor.user.uid}_${req.params.id}`).set({
                lastOpenedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            res.json({ success: true });
        } catch (error) { next(error); }
    });

    app.post('/admin/albums', requireAdmin, uploadIcon.single('icon'), async (req, res, next) => {
        try {
            const nombre = String(req.body.nombre || '').trim();
            if (!nombre) return res.status(400).json({ error: 'Nombre de album requerido.' });
            const db = await getDb();
            const admin = await firebaseAdmin();
            let iconUrl = null;
            if (req.file) {
                const result = await optimizeIcon(req.file.filename);
                iconUrl = result.fileName ? `/album-icons/${result.fileName}` : null;
            }
            const ref = db.collection(ALBUMS).doc();
            await ref.set({
                nombre,
                iconUrl,
                revelationEnabled: parseBoolean(req.body.revelationEnabled),
                revelationVersion: 1,
                trackCount: 0,
                scheduledCount: 0,
                followerCount: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            res.json({ success: true, id: ref.id });
        } catch (error) { next(error); }
    });

    app.patch('/admin/albums/:id', requireAdmin, uploadIcon.single('icon'), async (req, res, next) => {
        try {
            const album = await getAlbum(req.params.id);
            if (!album) return res.status(404).json({ error: 'Album no encontrado.' });
            const current = album.data() || {};
            const update = {};
            const admin = await firebaseAdmin();
            if (req.body.nombre !== undefined) {
                const nombre = String(req.body.nombre || '').trim();
                if (!nombre) return res.status(400).json({ error: 'Nombre de album requerido.' });
                update.nombre = nombre;
            }
            if (req.body.revelationEnabled !== undefined) {
                const enabled = parseBoolean(req.body.revelationEnabled);
                if (!enabled && current.revelationEnabled) {
                    const entries = await albumTracks(album.ref);
                    const future = entries.filter(entry => {
                        const date = iso(entry.releaseAt);
                        return date && new Date(date).getTime() > Date.now();
                    });
                    if (future.length > 0) return res.status(409).json({ error: 'No puedes cerrar Revelacion mientras queden estrenos futuros.', futureCount: future.length });
                }
                update.revelationEnabled = enabled;
                if (enabled && !current.revelationEnabled) update.revelationVersion = Math.max(1, Number(current.revelationVersion) || 1) + 1;
            }
            if (req.file) {
                if (current.iconUrl) deleteIcon(current.iconUrl);
                const result = await optimizeIcon(req.file.filename);
                update.iconUrl = result.fileName ? `/album-icons/${result.fileName}` : null;
            }
            update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            await album.ref.set(update, { merge: true });
            res.json({ success: true });
        } catch (error) { next(error); }
    });

    app.delete('/admin/albums/:id', requireAdmin, async (req, res, next) => {
        try {
            const album = await getAlbum(req.params.id);
            if (!album) return res.status(404).json({ error: 'Album no encontrado.' });
            cancelAlbumReleaseTimers(req.params.id);
            const db = await getDb();
            const data = album.data() || {};
            const [tracks, follows, progress] = await Promise.all([
                album.ref.collection('tracks').get(),
                db.collection(FOLLOWS).where('albumId', '==', req.params.id).get(),
                db.collection(PROGRESS).where('albumId', '==', req.params.id).get(),
            ]);
            const docs = [...tracks.docs, ...follows.docs, ...progress.docs, album];
            for (let index = 0; index < docs.length; index += 400) {
                const batch = db.batch();
                docs.slice(index, index + 400).forEach(doc => batch.delete(doc.ref));
                await batch.commit();
            }
            if (data.iconUrl) deleteIcon(data.iconUrl);
            res.json({ success: true });
        } catch (error) { next(error); }
    });

    app.post('/admin/albums/:id/tracks', requireAdmin, async (req, res, next) => {
        try {
            const album = await getAlbum(req.params.id);
            if (!album) return res.status(404).json({ error: 'Album no encontrado.' });
            const songId = String(req.body.songId || '').trim();
            const songs = await listAllSongs(false);
            if (!songs.some(song => song.id === songId)) return res.status(404).json({ error: 'Cancion no encontrada.' });
            const entries = await albumTracks(album.ref);
            if (entries.some(entry => String(entry.songId) === songId)) return res.status(409).json({ error: 'La cancion ya esta en el album.' });
            const releaseAt = req.body.releaseAt ? safeDate(req.body.releaseAt) : null;
            if (req.body.releaseAt && !releaseAt) return res.status(400).json({ error: 'Fecha de estreno no valida.' });
            const admin = await firebaseAdmin();
            const trackRef = album.ref.collection('tracks').doc();
            const trackData = {
                songId,
                position: entries.length,
                releaseAt: releaseAt ? admin.firestore.Timestamp.fromDate(releaseAt) : null,
                addedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            await trackRef.set(trackData);
            await updateAlbumCounts(album.ref);
            scheduleReleaseUnhide(album.id, { id: trackRef.id, ...trackData });
            res.json({ success: true });
        } catch (error) { next(error); }
    });

    app.patch('/admin/albums/:id/tracks/:entryId', requireAdmin, async (req, res, next) => {
        try {
            const album = await getAlbum(req.params.id);
            if (!album) return res.status(404).json({ error: 'Album no encontrado.' });
            const trackRef = album.ref.collection('tracks').doc(req.params.entryId);
            const track = await trackRef.get();
            if (!track.exists) return res.status(404).json({ error: 'Pista de album no encontrada.' });
            const releaseAt = req.body.releaseAt ? safeDate(req.body.releaseAt) : null;
            if (req.body.releaseAt && !releaseAt) return res.status(400).json({ error: 'Fecha de estreno no valida.' });
            const admin = await firebaseAdmin();
            await trackRef.set({
                releaseAt: releaseAt ? admin.firestore.Timestamp.fromDate(releaseAt) : null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            await updateAlbumCounts(album.ref);
            scheduleReleaseUnhide(album.id, {
                id: track.id,
                ...track.data(),
                releaseAt: releaseAt ? admin.firestore.Timestamp.fromDate(releaseAt) : null,
            });
            res.json({ success: true });
        } catch (error) { next(error); }
    });

    app.delete('/admin/albums/:id/tracks/:entryId', requireAdmin, async (req, res, next) => {
        try {
            const album = await getAlbum(req.params.id);
            if (!album) return res.status(404).json({ error: 'Album no encontrado.' });
            cancelReleaseTimer(album.id, req.params.entryId);
            await album.ref.collection('tracks').doc(req.params.entryId).delete();
            const entries = await albumTracks(album.ref);
            const db = await getDb();
            const batch = db.batch();
            entries.forEach((entry, index) => batch.set(album.ref.collection('tracks').doc(entry.id), { position: index }, { merge: true }));
            await batch.commit();
            await updateAlbumCounts(album.ref);
            res.json({ success: true });
        } catch (error) { next(error); }
    });

    app.post('/admin/albums/:id/reorder', requireAdmin, async (req, res, next) => {
        try {
            const album = await getAlbum(req.params.id);
            if (!album) return res.status(404).json({ error: 'Album no encontrado.' });
            const requested = Array.isArray(req.body.entryIds) ? req.body.entryIds.map(String) : [];
            const entries = await albumTracks(album.ref);
            const current = entries.map(entry => entry.id);
            if (requested.length !== current.length || requested.some(id => !current.includes(id))) {
                return res.status(400).json({ error: 'La reordenacion debe contener todas las pistas actuales.' });
            }
            const db = await getDb();
            const batch = db.batch();
            requested.forEach((entryId, index) => batch.set(album.ref.collection('tracks').doc(entryId), { position: index }, { merge: true }));
            await batch.commit();
            await updateAlbumCounts(album.ref);
            res.json({ success: true });
        } catch (error) { next(error); }
    });

    async function getPublishedAlbumSongs(albumId, req, requestedEntryIds = []) {
        const album = await getAlbum(albumId);
        if (!album) throw Object.assign(new Error('Album no encontrado.'), { statusCode: 404 });
        const data = album.data() || {};
        const db = await getDb();
        const entries = await albumTracks(album.ref);
        const currentActor = await actor(req, false);
        const version = Math.max(1, Number(data.revelationVersion) || 1);
        const progress = await getProgress(db, currentActor, album.id, version);
        const requested = new Set(Array.isArray(requestedEntryIds) ? requestedEntryIds.map(String) : []);
        const availableEntries = entries.filter(entry => {
            const date = iso(entry.releaseAt);
            if (date && new Date(date).getTime() > Date.now()) return false;
            if (data.revelationEnabled && !progress.revealed.has(entry.id)) return false;
            return requested.size === 0 || requested.has(entry.id);
        });
        if (availableEntries.length === 0) {
            throw Object.assign(new Error('Este album no tiene canciones estrenadas y reveladas disponibles.'), { statusCode: 409 });
        }
        const songs = await listAllSongs(true);
        const byId = new Map(songs.map(song => [song.id, song]));
        return {
            album: { id: album.id, nombre: String(data.nombre || 'Album') },
            songs: availableEntries.map(entry => byId.get(String(entry.songId || ''))).filter(Boolean),
        };
    }

    void restoreReleaseSchedules().catch(error => {
        console.error('No se pudieron restaurar los estrenos programados de albumes:', error);
    });

    return { getPublishedAlbumSongs, requireAdmin };
}

module.exports = { registerAlbumRoutes };
