const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const app = express();
app.use(express.json());
const PORT = Number(process.env.PORT) || 3001;
const ICON_MAX_DIMENSION = Math.max(64, Number(process.env.ICON_MAX_DIMENSION) || 512);
const ICON_WEBP_QUALITY = Math.min(100, Math.max(40, Number(process.env.ICON_WEBP_QUALITY) || 82));
const DURATION_METADATA_VERSION = 3;
const DURATION_SOURCE = 'music-metadata-full-scan';
const EMBEDDED_LYRICS_METADATA_VERSION = 1;

// ==========================================
// ESTRUCTURA DE CARPETAS
// ==========================================
const BASE_DIR = path.join(__dirname, 'almacenamiento_compartido');
const AUDIOS_DIR = path.join(BASE_DIR, 'audios');
const CANCIONES_DIR = path.join(BASE_DIR, 'canciones');
const LYRICS_DIR = path.join(BASE_DIR, 'lyrics');
const PLAYLISTS_DIR = path.join(BASE_DIR, 'playlists');
const PLAYLIST_ICONS_DIR = path.join(BASE_DIR, 'playlist-icons');
const ALBUM_ICONS_DIR = path.join(BASE_DIR, 'album-icons');
const SONG_ICONS_DIR = path.join(BASE_DIR, 'song-icons');
const SONG_ICON_VARIANTS_DIR = path.join(BASE_DIR, 'song-icon-variants');
const SONG_ADVANCED_COVERS_DIR = path.join(BASE_DIR, 'song-advanced-covers');
const PLAYLISTS_META_PATH = path.join(PLAYLISTS_DIR, 'playlists.json');
const RADIO_DIR = path.join(BASE_DIR, 'radio');
const RADIO_STATE_PATH = path.join(RADIO_DIR, 'radio-state.json');
const RADIO_START_GRACE_MS = 2200;
const { createSongThemeStore } = require('./songThemes');
const songThemeStore = createSongThemeStore({ storage: BASE_DIR, songsDirectory: CANCIONES_DIR });

// Crear carpetas si no existen
[BASE_DIR, AUDIOS_DIR, CANCIONES_DIR, LYRICS_DIR, PLAYLISTS_DIR, PLAYLIST_ICONS_DIR, ALBUM_ICONS_DIR, SONG_ICONS_DIR, SONG_ICON_VARIANTS_DIR, SONG_ADVANCED_COVERS_DIR, RADIO_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ==========================================
// MIGRACIÓN AUTOMÁTICA desde carpeta "audio/" antigua
// ==========================================
const OLD_AUDIO_DIR = path.join(__dirname, 'audio');
if (fs.existsSync(OLD_AUDIO_DIR)) {
    const oldFiles = fs.readdirSync(OLD_AUDIO_DIR);
    let migrated = 0;
    oldFiles.forEach(file => {
        const src = path.join(OLD_AUDIO_DIR, file);
        if (file.endsWith('.mp3') || file.endsWith('.mpeg') || file.endsWith('.wav')) {
            const dest = path.join(AUDIOS_DIR, file);
            if (!fs.existsSync(dest)) {
                fs.copyFileSync(src, dest);
                migrated++;
            }
        } else if (file.endsWith('.json')) {
            const dest = path.join(CANCIONES_DIR, file);
            if (!fs.existsSync(dest)) {
                fs.copyFileSync(src, dest);
                migrated++;
            }
        }
    });
    if (migrated > 0) {
        console.log(`📦 Migración automática: ${migrated} archivos movidos de audio/ a almacenamiento_compartido/`);
    }
}

// ==========================================
// CONFIGURACIÓN
// ==========================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
}));

// Servir audios estáticamente
app.use('/audio', express.static(AUDIOS_DIR));
app.use('/lyrics', express.static(LYRICS_DIR));
app.use('/playlist-icons', express.static(PLAYLIST_ICONS_DIR));
app.use('/album-icons', express.static(ALBUM_ICONS_DIR));
app.use('/song-icons', express.static(SONG_ICONS_DIR));
app.use('/song-advanced-covers', express.static(SONG_ADVANCED_COVERS_DIR));

// Configuración de almacenamiento Multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (file.fieldname === 'lyrics') return cb(null, LYRICS_DIR);
        if (file.fieldname === 'icon') return cb(null, SONG_ICONS_DIR);
        if (file.fieldname === 'advancedCover') return cb(null, SONG_ADVANCED_COVERS_DIR);
        cb(null, AUDIOS_DIR);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (file.fieldname === 'icon' || file.fieldname === 'advancedCover') {
            return cb(null, `${Date.now()}_${crypto.randomUUID()}${ext || '.png'}`);
        }
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-]/g, "_");
        cb(null, `${Date.now()}_${safeName}`);
    }
});
const upload = multer({
    storage: storage,
    fileFilter: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();

        if (file.fieldname === 'lyrics') {
            if (!['.srt', '.vtt'].includes(ext)) {
                return cb(new Error('Las lyrics deben ser un archivo .srt o .vtt'));
            }
            return cb(null, true);
        }

        if (file.fieldname === 'icon') {
            if (!file.mimetype || !file.mimetype.startsWith('image/')) {
                return cb(new Error('El icono de la cancion debe ser una imagen'));
            }
            return cb(null, true);
        }

        if (file.fieldname === 'advancedCover') {
            const allowedAdvanced = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.m4v'];
            const validMime = file.mimetype && (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/'));
            if (!validMime || !allowedAdvanced.includes(ext)) {
                return cb(new Error('La caratula avanzada debe ser una imagen, gif o video'));
            }
            return cb(null, true);
        }

        const allowedAudio = ['.mp3', '.mpeg', '.wav'];
        if (!allowedAudio.includes(ext)) {
            return cb(new Error('El archivo de audio no es valido'));
        }
        cb(null, true);
    }
});

const playlistIconStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, PLAYLIST_ICONS_DIR);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        cb(null, `${Date.now()}_${crypto.randomUUID()}${ext}`);
    }
});

const uploadPlaylistIcon = multer({
    storage: playlistIconStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        if (!file.mimetype || !file.mimetype.startsWith('image/')) {
            return cb(new Error('El icono debe ser una imagen'));
        }
        cb(null, true);
    }
});

const albumIconStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, ALBUM_ICONS_DIR);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        cb(null, `${Date.now()}_${crypto.randomUUID()}${ext}`);
    }
});

const uploadAlbumIcon = multer({
    storage: albumIconStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        if (!file.mimetype || !file.mimetype.startsWith('image/')) {
            return cb(new Error('El icono del album debe ser una imagen'));
        }
        cb(null, true);
    }
});

// HELPER: nombre base sin extensión
function getBaseName(fileName) {
    return path.parse(fileName).name;
}

function lyricsFilePath(fileName) {
    const resolved = path.resolve(LYRICS_DIR, fileName || '');
    const root = path.resolve(LYRICS_DIR);

    if (!resolved.startsWith(root + path.sep)) {
        throw new Error('Ruta de lyrics no valida');
    }

    return resolved;
}

function readLyricsSrt(metadata) {
    if (!metadata || !metadata.lyricsFile) {
        return null;
    }

    try {
        const filePath = lyricsFilePath(metadata.lyricsFile);
        if (!fs.existsSync(filePath)) {
            return null;
        }
        return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        console.error('Error leyendo lyrics:', err.message);
        return null;
    }
}

function deleteLyricsFile(metadata) {
    if (!metadata || !metadata.lyricsFile) {
        return;
    }

    try {
        const filePath = lyricsFilePath(metadata.lyricsFile);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error('Error borrando lyrics:', err.message);
    }
}

function songIconFilePath(fileName) {
    const resolved = path.resolve(SONG_ICONS_DIR, fileName || '');
    const root = path.resolve(SONG_ICONS_DIR);

    if (!resolved.startsWith(root + path.sep)) {
        throw new Error('Ruta de icono de cancion no valida');
    }

    return resolved;
}

function playlistIconFilePath(fileName) {
    const resolved = path.resolve(PLAYLIST_ICONS_DIR, fileName || '');
    const root = path.resolve(PLAYLIST_ICONS_DIR);

    if (!resolved.startsWith(root + path.sep)) {
        throw new Error('Ruta de icono de playlist no valida');
    }

    return resolved;
}

function songAdvancedCoverFilePath(fileName) {
    const resolved = path.resolve(SONG_ADVANCED_COVERS_DIR, fileName || '');
    const root = path.resolve(SONG_ADVANCED_COVERS_DIR);

    if (!resolved.startsWith(root + path.sep)) {
        throw new Error('Ruta de caratula avanzada no valida');
    }

    return resolved;
}

function deleteSongIconFile(fileName) {
    if (!fileName) return;

    try {
        const filePath = songIconFilePath(fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error('Error borrando icono de cancion:', err.message);
    }
}

function deleteSongAdvancedCoverFile(fileName) {
    if (!fileName) return;

    try {
        const filePath = songAdvancedCoverFilePath(fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error('Error borrando caratula avanzada:', err.message);
    }
}

function deletePlaylistIconFile(fileName) {
    if (!fileName) return;

    try {
        const filePath = playlistIconFilePath(fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error('Error borrando icono de playlist:', err.message);
    }
}

function playlistIconFileNameFromUrl(iconUrl) {
    if (!iconUrl || typeof iconUrl !== 'string') return null;
    const prefix = '/playlist-icons/';
    return iconUrl.startsWith(prefix) ? iconUrl.slice(prefix.length) : null;
}

function iconExtensionFromMime(mime) {
    if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
    if (mime === 'image/png') return '.png';
    if (mime === 'image/webp') return '.webp';
    if (mime === 'image/gif') return '.gif';
    return '.jpg';
}

let sharpModulePromise = null;

async function loadSharpModule() {
    if (!sharpModulePromise) {
        sharpModulePromise = Promise.resolve()
            .then(() => require('sharp'))
            .catch(err => {
                console.warn(`Optimizacion de iconos desactivada: instala "sharp" en el backend (${err.message}).`);
                return null;
            });
    }
    return sharpModulePromise;
}

// Iconos que ya son mas pequenos que el tamano pedido: no hay variante que
// cachear en disco, asi que recordamos aqui que van tal cual.
const songIconPassthrough = new Set();

app.get('/song-icon/:size/:fileName', async (req, res, next) => {
    try {
        const requestedSize = Number(req.params.size);
        const size = [64, 96, 128, 256, 512].includes(requestedSize) ? requestedSize : 128;
        const fileName = path.basename(String(req.params.fileName || ''));
        const sourcePath = path.resolve(SONG_ICONS_DIR, fileName);
        if (!fileName || !sourcePath.startsWith(path.resolve(SONG_ICONS_DIR) + path.sep) || !fs.existsSync(sourcePath)) {
            return res.status(404).end();
        }

        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

        // La clave de cache sale del stat, que es barato. Comprobamos el acierto
        // ANTES de tocar sharp: antes se decodificaba la cabecera de la imagen
        // en CADA peticion, y una lista de movil pide decenas de portadas a la
        // vez, asi que se iba toda la CPU en releer imagenes ya convertidas.
        const sourceStats = fs.statSync(sourcePath);
        const cacheKey = crypto.createHash('sha1')
            .update(`${fileName}:${sourceStats.mtimeMs}:${sourceStats.size}:${size}`)
            .digest('hex');
        const outputPath = path.join(SONG_ICON_VARIANTS_DIR, `${cacheKey}.webp`);
        if (fs.existsSync(outputPath)) return res.type('image/webp').sendFile(outputPath);
        // Los originales mas pequenos que el tamano pedido no generan variante,
        // asi que nunca acertarian en la cache de disco. Recordamos esa decision
        // en memoria para no medirlos una y otra vez.
        if (songIconPassthrough.has(cacheKey)) return res.sendFile(sourcePath);

        const sharp = await loadSharpModule();
        if (!sharp) return res.sendFile(sourcePath);

        const sourceMetadata = await sharp(sourcePath, { animated: false }).metadata();
        const width = Number(sourceMetadata.width) || 0;
        const height = Number(sourceMetadata.height) || 0;
        if ((width && width <= size) && (height && height <= size)) {
            songIconPassthrough.add(cacheKey);
            return res.sendFile(sourcePath);
        }

        const temporaryPath = `${outputPath}.${process.pid}.tmp`;
        await sharp(sourcePath, { animated: false })
            .rotate()
            .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: Math.min(82, ICON_WEBP_QUALITY) })
            .toFile(temporaryPath);
        fs.renameSync(temporaryPath, outputPath);
        return res.type('image/webp').sendFile(outputPath);
    } catch (error) {
        next(error);
    }
});

function buildIconOptimizationInfo(result) {
    return {
        maxDimension: ICON_MAX_DIMENSION,
        width: result.width || null,
        height: result.height || null,
        size: result.size || null,
        optimized: Boolean(result.optimized),
        checkedAt: new Date().toISOString()
    };
}

async function optimizeIconFile({ directory, fileName, maxDimension = ICON_MAX_DIMENSION, label = 'icono' }) {
    if (!fileName) {
        return { fileName: null, width: null, height: null, size: null, optimized: false };
    }

    const filePath = path.resolve(directory, fileName);
    const root = path.resolve(directory);

    if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath)) {
        return { fileName, width: null, height: null, size: null, optimized: false };
    }

    const sharp = await loadSharpModule();
    const currentStats = fs.statSync(filePath);

    if (!sharp) {
        return { fileName, width: null, height: null, size: currentStats.size, optimized: false };
    }

    try {
        const metadata = await sharp(filePath, { animated: false }).metadata();
        const width = Number(metadata.width) || null;
        const height = Number(metadata.height) || null;
        const shouldResize = width && height && (width > maxDimension || height > maxDimension);

        if (!shouldResize) {
            return { fileName, width, height, size: currentStats.size, optimized: false };
        }

        const outputName = `${Date.now()}_${crypto.randomUUID()}.webp`;
        const outputPath = path.join(directory, outputName);

        await sharp(filePath, { animated: false })
            .rotate()
            .resize({
                width: maxDimension,
                height: maxDimension,
                fit: 'inside',
                withoutEnlargement: true
            })
            .webp({ quality: ICON_WEBP_QUALITY })
            .toFile(outputPath);

        fs.unlinkSync(filePath);

        const outputMetadata = await sharp(outputPath).metadata();
        const outputStats = fs.statSync(outputPath);

        return {
            fileName: outputName,
            width: Number(outputMetadata.width) || maxDimension,
            height: Number(outputMetadata.height) || maxDimension,
            size: outputStats.size,
            optimized: true
        };
    } catch (err) {
        console.error(`No se pudo optimizar ${label} ${fileName}:`, err.message);
        return { fileName, width: null, height: null, size: currentStats.size, optimized: false };
    }
}

async function optimizeSongIconFile(fileName) {
    return optimizeIconFile({ directory: SONG_ICONS_DIR, fileName, label: 'icono de cancion' });
}

async function optimizePlaylistIconFile(fileName) {
    return optimizeIconFile({ directory: PLAYLIST_ICONS_DIR, fileName, label: 'icono de playlist' });
}

async function optimizeAlbumIconFile(fileName) {
    return optimizeIconFile({ directory: ALBUM_ICONS_DIR, fileName, label: 'icono de album' });
}

function deleteAlbumIconFile(iconUrl) {
    const fileName = path.basename(String(iconUrl || ''));
    if (!fileName) return;
    const filePath = path.resolve(ALBUM_ICONS_DIR, fileName);
    if (filePath.startsWith(path.resolve(ALBUM_ICONS_DIR) + path.sep) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

async function saveEmbeddedSongIcon(buffer, mime) {
    const ext = iconExtensionFromMime(mime);
    const fileName = `${Date.now()}_${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(songIconFilePath(fileName), buffer);
    return optimizeSongIconFile(fileName);
}

let musicMetadataModulePromise = null;

async function loadMusicMetadataModule() {
    if (!musicMetadataModulePromise) {
        musicMetadataModulePromise = import('music-metadata');
    }
    return musicMetadataModulePromise;
}

function songJsonPathForAudio(file) {
    return path.join(CANCIONES_DIR, `${getBaseName(file)}.json`);
}

function readSongMetadata(file) {
    const jsonPath = songJsonPathForAudio(file);
    const fallback = {
        nombre: file.replace(/^\d+_/, ''),
        archivo: file,
        variantes: [],
        themeIds: []
    };

    if (!fs.existsSync(jsonPath)) {
        return fallback;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        return {
            ...fallback,
            ...parsed,
            nombre: parsed.nombre || fallback.nombre,
            archivo: parsed.archivo || file,
            variantes: Array.isArray(parsed.variantes) ? parsed.variantes : [],
            themeIds: songThemeStore.sanitizeThemeIds(parsed.themeIds)
        };
    } catch (e) {
        console.error(`Error JSON ${file}:`, e.message);
        return fallback;
    }
}

function writeSongMetadata(file, metadata) {
    const jsonPath = songJsonPathForAudio(file);
    fs.writeFileSync(jsonPath, JSON.stringify({
        ...metadata,
        archivo: metadata.archivo || file,
        variantes: Array.isArray(metadata.variantes) ? metadata.variantes : [],
        themeIds: songThemeStore.sanitizeThemeIds(metadata.themeIds)
    }, null, 4), 'utf8');
}

function hasAccurateDuration(metadata) {
    return (
        typeof metadata.duration === 'number' &&
        Number.isFinite(metadata.duration) &&
        metadata.duration > 0 &&
        metadata.durationVersion === DURATION_METADATA_VERSION &&
        metadata.durationSource === DURATION_SOURCE
    );
}

function parseNativeDurationSeconds(value, tagId = '') {
    if (value === null || value === undefined) return null;

    if (Array.isArray(value)) {
        for (const item of value) {
            const parsed = parseNativeDurationSeconds(item, tagId);
            if (parsed) return parsed;
        }
        return null;
    }

    const raw = typeof value === 'object' && value.text !== undefined ? value.text : value;
    const numeric = Number(String(raw).replace(',', '.').trim());
    if (!Number.isFinite(numeric) || numeric <= 0) return null;

    // ID3 TLEN se expresa en milisegundos.
    if (tagId === 'TLEN') {
        return numeric / 1000;
    }

    // Otras etiquetas no estandarizadas pueden venir en segundos o milisegundos.
    return numeric > 24 * 60 * 60 ? numeric / 1000 : numeric;
}

function readNativeDurationSeconds(parsed) {
    if (!parsed || !parsed.native || typeof parsed.native !== 'object') return null;

    for (const tagList of Object.values(parsed.native)) {
        if (!Array.isArray(tagList)) continue;

        for (const tag of tagList) {
            const id = String(tag && tag.id ? tag.id : '').toUpperCase();
            if (id !== 'TLEN' && id !== 'DURATION') continue;

            const duration = parseNativeDurationSeconds(tag.value, id);
            if (duration && Number.isFinite(duration) && duration > 0) {
                return duration;
            }
        }
    }

    return null;
}

function normalizeEmbeddedLyricsText(value) {
    if (value === null || value === undefined) return '';

    if (Array.isArray(value)) {
        return value
            .map(normalizeEmbeddedLyricsText)
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'object') {
        if (Array.isArray(value.syncText)) {
            const synced = value.syncText
                .map(item => normalizeEmbeddedLyricsText(item && item.text !== undefined ? item.text : item))
                .filter(Boolean)
                .join('\n')
                .trim();
            if (synced) return synced;
        }

        for (const key of ['text', 'lyrics', 'value', 'description']) {
            if (value[key] !== undefined) {
                const nested = normalizeEmbeddedLyricsText(value[key]);
                if (nested) return nested;
            }
        }
    }

    return '';
}

function cleanEmbeddedLyricsText(value) {
    const text = normalizeEmbeddedLyricsText(value)
        .replace(/\r/g, '')
        .replace(/\u0000/g, '')
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();

    return text.length >= 8 ? text : '';
}

function readEmbeddedLyricsText(parsed) {
    const commonText = cleanEmbeddedLyricsText(parsed && parsed.common && parsed.common.lyrics);
    if (commonText) return commonText;

    if (!parsed || !parsed.native || typeof parsed.native !== 'object') return '';

    const lyricTagIds = new Set(['USLT', 'SYLT', 'LYRICS', 'UNSYNCEDLYRICS', '©LYR', 'WM/LYRICS']);
    for (const tagList of Object.values(parsed.native)) {
        if (!Array.isArray(tagList)) continue;

        for (const tag of tagList) {
            const id = String(tag && tag.id ? tag.id : '').toUpperCase();
            if (!lyricTagIds.has(id)) continue;

            const text = cleanEmbeddedLyricsText(tag.value);
            if (text) return text;
        }
    }

    return '';
}

async function ensureSongAudioMetadata(file, metadata, options = {}) {
    const needsDuration = !hasAccurateDuration(metadata);
    const needsEmbeddedIcon = !metadata.manualIconFile && !metadata.embeddedIconFile && !metadata.embeddedArtworkChecked;
    const needsEmbeddedLyrics = metadata.embeddedLyricsVersion !== EMBEDDED_LYRICS_METADATA_VERSION;
    const forceArtwork = Boolean(options.forceArtwork);

    if (!needsDuration && !needsEmbeddedIcon && !forceArtwork && !needsEmbeddedLyrics) {
        return metadata.duration || null;
    }

    try {
        const mm = await loadMusicMetadataModule();
        const shouldReadCover = (needsEmbeddedIcon || forceArtwork) && !metadata.manualIconFile;
        const parsed = await mm.parseFile(path.join(AUDIOS_DIR, file), {
            duration: true,
            skipCovers: !shouldReadCover
        });
        const formatDuration = parsed && parsed.format && Number(parsed.format.duration);
        const nativeDuration = readNativeDurationSeconds(parsed);
        const duration = Number.isFinite(formatDuration) && formatDuration > 0
            ? formatDuration
            : nativeDuration;

        if (needsDuration && Number.isFinite(duration) && duration > 0) {
            metadata.duration = duration;
            metadata.durationSource = DURATION_SOURCE;
            metadata.durationVersion = DURATION_METADATA_VERSION;
            metadata.durationCheckedAt = new Date().toISOString();
            metadata.durationContainer = parsed && parsed.format && parsed.format.container
                ? parsed.format.container
                : null;
        }

        if ((needsEmbeddedIcon || forceArtwork) && !metadata.manualIconFile) {
            const picture = parsed && parsed.common && Array.isArray(parsed.common.picture)
                ? parsed.common.picture[0]
                : null;

            if (picture && picture.data) {
                deleteSongIconFile(metadata.embeddedIconFile);
                const iconResult = await saveEmbeddedSongIcon(picture.data, picture.format);
                metadata.embeddedIconFile = iconResult.fileName;
                metadata.embeddedIconInfo = buildIconOptimizationInfo(iconResult);
                metadata.embeddedArtworkChecked = true;
            } else {
                metadata.embeddedArtworkChecked = true;
            }
        }

        if (needsEmbeddedLyrics) {
            const embeddedLyrics = readEmbeddedLyricsText(parsed);
            if (embeddedLyrics) {
                metadata.staticLyrics = embeddedLyrics;
                metadata.staticLyricsSource = 'embedded';
            } else {
                delete metadata.staticLyrics;
                delete metadata.staticLyricsSource;
            }
            metadata.embeddedLyricsVersion = EMBEDDED_LYRICS_METADATA_VERSION;
            metadata.embeddedLyricsCheckedAt = new Date().toISOString();
        }

        if (needsDuration || needsEmbeddedIcon || forceArtwork || needsEmbeddedLyrics) {
            writeSongMetadata(file, metadata);
        }
    } catch (err) {
        console.error(`No se pudieron leer metadatos de audio de ${file}:`, err.message);
        if (needsEmbeddedLyrics) {
            metadata.embeddedLyricsVersion = EMBEDDED_LYRICS_METADATA_VERSION;
            metadata.embeddedLyricsCheckedAt = new Date().toISOString();
        }
        if (needsEmbeddedIcon || forceArtwork) {
            metadata.embeddedArtworkChecked = true;
            writeSongMetadata(file, metadata);
        } else if (needsEmbeddedLyrics) {
            writeSongMetadata(file, metadata);
        }
    }

    return metadata.duration || null;
}

async function ensureCurrentSongIconOptimized(file, metadata) {
    const hasManualIcon = Boolean(metadata.manualIconFile);
    const fileName = hasManualIcon ? metadata.manualIconFile : metadata.embeddedIconFile;
    if (!fileName) return false;

    const infoKey = hasManualIcon ? 'manualIconInfo' : 'embeddedIconInfo';
    const currentInfo = metadata[infoKey];
    if (currentInfo && currentInfo.maxDimension === ICON_MAX_DIMENSION && currentInfo.checkedAt) {
        return false;
    }

    const iconResult = await optimizeSongIconFile(fileName);
    const nextFileName = iconResult.fileName || fileName;

    if (hasManualIcon) {
        metadata.manualIconFile = nextFileName;
    } else {
        metadata.embeddedIconFile = nextFileName;
    }

    metadata[infoKey] = buildIconOptimizationInfo(iconResult);
    writeSongMetadata(file, metadata);
    return true;
}

async function ensureSongDuration(file, metadata) {
    return ensureSongAudioMetadata(file, metadata);
}

async function buildSongResponse(file, ensureDuration = false) {
    const stats = fs.statSync(path.join(AUDIOS_DIR, file));
    const metadata = readSongMetadata(file);

    if (ensureDuration) {
        await ensureSongAudioMetadata(file, metadata);
        await ensureCurrentSongIconOptimized(file, metadata);
    }

    return songResponse(file, metadata, stats);
}

async function listAllSongs(ensureDuration = false) {
    const audioFiles = fs.readdirSync(AUDIOS_DIR)
        .filter(f => f.endsWith('.mp3') || f.endsWith('.mpeg') || f.endsWith('.wav'));

    const canciones = await Promise.all(audioFiles.map(file => buildSongResponse(file, ensureDuration)));
    canciones.sort((a, b) => b.createdAt.seconds - a.createdAt.seconds);
    return canciones;
}

async function refreshSongDurations() {
    const audioFiles = fs.readdirSync(AUDIOS_DIR)
        .filter(f => f.endsWith('.mp3') || f.endsWith('.mpeg') || f.endsWith('.wav'));

    for (const file of audioFiles) {
        const metadata = readSongMetadata(file);
        await ensureSongAudioMetadata(file, metadata);
    }
}

function readRequestMetadata(req) {
    if (req.body && req.body.metadata) {
        try {
            return JSON.parse(req.body.metadata);
        } catch (err) {
            console.error("Error parseando metadatos:", err.message);
            return {};
        }
    }

    return req.body || {};
}

function songResponse(file, metadata, stats) {
    const iconFile = metadata.manualIconFile || metadata.embeddedIconFile || null;
    return {
        id: file,
        name: metadata.nombre,
        variantes: metadata.variantes || [],
        url: `/audio/${file}`,
        iconUrl: iconFile ? `/song-icons/${iconFile}` : null,
        advancedCoverUrl: metadata.advancedCoverFile ? `/song-advanced-covers/${metadata.advancedCoverFile}` : null,
        advancedCoverType: metadata.advancedCoverMime || null,
        lyricsUrl: metadata.lyricsFile ? `/lyrics/${metadata.lyricsFile}` : null,
        lyricsFileName: metadata.lyricsOriginalName || null,
        lyricsSrt: readLyricsSrt(metadata),
        staticLyrics: metadata.staticLyrics || null,
        duration: typeof metadata.duration === 'number' && Number.isFinite(metadata.duration) ? metadata.duration : null,
        createdAt: { seconds: Math.floor(stats.birthtimeMs / 1000), nanoseconds: 0 }
    };
}

function slugify(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'playlist';
}

function safePlaylistFileName(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ _\-]/g, '')
        .replace(/\s+/g, ' ') || `playlist-${Date.now()}`;
}

function readPlaylistMetadata() {
    if (!fs.existsSync(PLAYLISTS_META_PATH)) {
        return [];
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(PLAYLISTS_META_PATH, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('Error leyendo playlists.json:', err.message);
        return [];
    }
}

function writePlaylistMetadata(playlists) {
    fs.writeFileSync(PLAYLISTS_META_PATH, JSON.stringify(playlists, null, 4), 'utf8');
}

async function ensurePlaylistIconOptimized(playlist) {
    const fileName = playlistIconFileNameFromUrl(playlist.iconUrl);
    if (!fileName) return false;

    if (playlist.iconInfo && playlist.iconInfo.maxDimension === ICON_MAX_DIMENSION && playlist.iconInfo.checkedAt) {
        return false;
    }

    const iconResult = await optimizePlaylistIconFile(fileName);
    playlist.iconUrl = iconResult.fileName ? `/playlist-icons/${iconResult.fileName}` : playlist.iconUrl;
    playlist.iconInfo = buildIconOptimizationInfo(iconResult);
    playlist.updatedAt = new Date().toISOString();
    return true;
}

async function ensurePlaylistIconsOptimized(playlists) {
    let changed = false;

    for (const playlist of playlists) {
        if (await ensurePlaylistIconOptimized(playlist)) {
            changed = true;
        }
    }

    if (changed) {
        writePlaylistMetadata(playlists);
    }
}

function playlistFilePath(playlist) {
    const resolved = path.resolve(PLAYLISTS_DIR, playlist.fileName);
    const root = path.resolve(PLAYLISTS_DIR);

    if (!resolved.startsWith(root + path.sep)) {
        throw new Error('Ruta de playlist no valida');
    }

    return resolved;
}

function uniquePlaylistId(base, playlists) {
    const existing = new Set(playlists.map(p => p.id));
    const slug = slugify(base);

    if (!existing.has(slug)) {
        return slug;
    }

    let index = 2;
    while (existing.has(`${slug}-${index}`)) {
        index++;
    }

    return `${slug}-${index}`;
}

function migratePlaylistMetadata() {
    const metadata = readPlaylistMetadata();
    const existingFiles = new Set(
        fs.readdirSync(PLAYLISTS_DIR).filter(f => f.endsWith('.txt'))
    );
    const validMetadata = metadata
        .filter(playlist => existingFiles.has(playlist.fileName))
        .map(playlist => ({
            ...playlist,
            songAddedAt: playlist.songAddedAt && typeof playlist.songAddedAt === 'object' && !Array.isArray(playlist.songAddedAt)
                ? playlist.songAddedAt
                : {}
        }));
    let changed = validMetadata.length !== metadata.length;

    existingFiles.forEach(file => {
        if (validMetadata.some(playlist => playlist.fileName === file)) {
            return;
        }

        const name = getBaseName(file);
        validMetadata.push({
            id: uniquePlaylistId(name, validMetadata),
            nombre: name,
            fileName: file,
            iconUrl: null,
            songAddedAt: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        changed = true;
    });

    if (changed || !fs.existsSync(PLAYLISTS_META_PATH)) {
        writePlaylistMetadata(validMetadata);
        console.log(`Migracion de playlists: ${validMetadata.length} playlists registradas en playlists.json`);
    }

    return validMetadata;
}

function getPlaylistByIdOrLegacy(identifier) {
    const playlists = migratePlaylistMetadata();
    const decoded = decodeURIComponent(identifier);
    const normalized = decoded.replace(/\.txt$/i, '');
    const playlist = playlists.find(p =>
        p.id === decoded ||
        p.nombre === decoded ||
        p.fileName === decoded ||
        getBaseName(p.fileName) === normalized
    );

    return { playlist, playlists };
}

function countPlaylistSongs(playlist) {
    const filePath = playlistFilePath(playlist);
    if (!fs.existsSync(filePath)) {
        return 0;
    }

    const content = fs.readFileSync(filePath, 'utf8').trim();
    return content ? content.split('\n').filter(l => l.trim()).length : 0;
}

async function getSongsForGlobalPlaylist(playlist) {
    const content = fs.readFileSync(playlistFilePath(playlist), 'utf8').trim();
    const nombresCanciones = content ? content.split('\n').filter(l => l.trim()) : [];
    const allSongs = await listAllSongs(true);

    return nombresCanciones
        .map(nombreOriginal => {
            const song = allSongs.find(song => song.name === nombreOriginal);
            if (!song) return null;
            return {
                ...song,
                addedAt: playlist.songAddedAt && typeof playlist.songAddedAt[song.id] === 'string'
                    ? playlist.songAddedAt[song.id]
                    : null
            };
        })
        .filter(Boolean);
}

function getDefaultRadioState() {
    const now = new Date().toISOString();
    return {
        status: 'paused',
        queue: [],
        shuffle: false,
        autoRandomPitch: false,
        version: 0,
        anchorPosition: 0,
        anchorUpdatedAt: Date.now(),
        createdAt: now,
        updatedAt: now
    };
}

function clampPitch(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(1.5, Math.max(0.5, parsed));
}

function randomRadioPitch() {
    return Math.round((0.8 + Math.random() * 0.4) * 100) / 100;
}

function normalizeLookup(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function sanitizeRadioSong(song) {
    return {
        id: song.id,
        name: song.name,
        url: song.url,
        iconUrl: song.iconUrl || null,
        advancedCoverUrl: song.advancedCoverUrl || null,
        advancedCoverType: song.advancedCoverType || null,
        variantes: song.variantes || [],
        lyricsUrl: song.lyricsUrl || null,
        lyricsFileName: song.lyricsFileName || null,
        lyricsSrt: song.lyricsSrt || null,
        staticLyrics: song.staticLyrics || null,
        duration: typeof song.duration === 'number' && Number.isFinite(song.duration) ? song.duration : null,
        createdAt: song.createdAt || null
    };
}

function normalizeRadioItem(item) {
    if (!item || !item.song) return null;
    return {
        itemId: item.itemId || crypto.randomUUID(),
        song: sanitizeRadioSong(item.song),
        source: item.source || { type: 'song', id: item.song.id, name: 'Cancion suelta' },
        pitch: clampPitch(item.pitch),
        addedAt: item.addedAt || new Date().toISOString(),
        addedBy: item.addedBy || 'web'
    };
}

function normalizeRadioStateShape(state) {
    const base = getDefaultRadioState();
    const queue = Array.isArray(state && state.queue)
        ? state.queue.map(normalizeRadioItem).filter(Boolean)
        : [];

    return {
        ...base,
        ...state,
        status: state && state.status === 'playing' ? 'playing' : 'paused',
        queue,
        shuffle: Boolean(state && state.shuffle),
        autoRandomPitch: false,
        version: Number.isFinite(Number(state && state.version)) ? Number(state.version) : 0,
        anchorPosition: Number.isFinite(Number(state && state.anchorPosition)) ? Math.max(0, Number(state.anchorPosition)) : 0,
        anchorUpdatedAt: Number.isFinite(Number(state && state.anchorUpdatedAt)) ? Number(state.anchorUpdatedAt) : Date.now(),
        updatedAt: state && state.updatedAt ? state.updatedAt : base.updatedAt
    };
}

function readRadioState() {
    if (!fs.existsSync(RADIO_STATE_PATH)) {
        return getDefaultRadioState();
    }

    try {
        return normalizeRadioStateShape(JSON.parse(fs.readFileSync(RADIO_STATE_PATH, 'utf8')));
    } catch (err) {
        console.error('Error leyendo radio-state.json:', err.message);
        return getDefaultRadioState();
    }
}

let radioState = readRadioState();
const radioClients = new Set();

function saveRadioState() {
    fs.writeFileSync(RADIO_STATE_PATH, JSON.stringify(radioState, null, 4), 'utf8');
}

function radioCurrentItem() {
    return radioState.queue[0] || null;
}

function radioCurrentDuration() {
    const duration = radioCurrentItem() && Number(radioCurrentItem().song.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function applyAutoRandomPitchToCurrent() {
    radioState.autoRandomPitch = false;
}

function scheduleRadioCurrentFromStart(now = Date.now()) {
    radioState.anchorPosition = 0;
    radioState.anchorUpdatedAt = now + RADIO_START_GRACE_MS;
}

function radioPositionAt(timeMs, clampToDuration = true) {
    const current = radioCurrentItem();
    if (!current) return 0;
    const duration = radioCurrentDuration();
    const anchor = Math.max(0, Number(radioState.anchorPosition) || 0);

    if (radioState.status !== 'playing') {
        return clampToDuration && duration > 0 ? Math.min(anchor, duration) : anchor;
    }

    const elapsed = Math.max(0, (timeMs - Number(radioState.anchorUpdatedAt || timeMs)) / 1000);
    const position = anchor + (elapsed * clampPitch(current.pitch));
    return clampToDuration && duration > 0 ? Math.min(position, duration) : position;
}

function buildRadioSnapshot() {
    const serverTime = Date.now();
    return {
        ...radioState,
        currentItem: radioCurrentItem(),
        position: radioPositionAt(serverTime),
        serverTime
    };
}

function sendRadioEvent(res, event, state) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(state)}\n\n`);
}

function broadcastRadioState(event = 'state') {
    const snapshot = buildRadioSnapshot();
    radioClients.forEach((res) => {
        try {
            sendRadioEvent(res, event, snapshot);
        } catch {
            radioClients.delete(res);
        }
    });
}

function commitRadioState(event = 'state') {
    radioState.version += 1;
    radioState.updatedAt = new Date().toISOString();
    saveRadioState();
    broadcastRadioState(event);
}

function syncRadioClock() {
    if (radioState.status !== 'playing') return false;

    const now = Date.now();
    let changed = false;
    let anchorAlreadySet = false;
    let position = radioPositionAt(now, false);

    while (radioState.status === 'playing' && radioState.queue.length > 0) {
        const current = radioCurrentItem();
        const duration = radioCurrentDuration();

        if (!current || duration <= 0) {
            radioState.status = 'paused';
            radioState.anchorPosition = 0;
            radioState.anchorUpdatedAt = now;
            changed = true;
            break;
        }

        if (position < duration) break;

        const overflowMediaSeconds = Math.max(0, position - duration);
        const overflowRealMs = (overflowMediaSeconds / clampPitch(current.pitch)) * 1000;
        radioState.queue.shift();
        changed = true;

        if (radioState.queue.length === 0) {
            radioState.status = 'paused';
            radioState.anchorPosition = 0;
            radioState.anchorUpdatedAt = now;
            break;
        }

        const next = radioCurrentItem();
        applyAutoRandomPitchToCurrent();
        const delayedOverflowMs = Math.max(0, overflowRealMs - RADIO_START_GRACE_MS);
        position = (delayedOverflowMs / 1000) * clampPitch(next.pitch);
        radioState.anchorPosition = position;
        radioState.anchorUpdatedAt = delayedOverflowMs > 0 ? now - delayedOverflowMs : now + (RADIO_START_GRACE_MS - overflowRealMs);
        anchorAlreadySet = true;
    }

    if (changed && !anchorAlreadySet && radioState.status === 'playing' && radioState.queue.length > 0) {
        radioState.anchorPosition = position;
        radioState.anchorUpdatedAt = now;
    }

    return changed;
}

function getSyncedRadioSnapshot() {
    if (syncRadioClock()) {
        commitRadioState('advance');
    }
    return buildRadioSnapshot();
}

function setRadioPaused() {
    const now = Date.now();
    radioState.anchorPosition = radioPositionAt(now);
    radioState.anchorUpdatedAt = now;
    radioState.status = 'paused';
}

function createRadioItems(songs, source, pitch, addedBy, randomPitch = false) {
    const safePitch = clampPitch(pitch);
    return songs.map(song => ({
        itemId: crypto.randomUUID(),
        song: sanitizeRadioSong(song),
        source,
        pitch: randomPitch ? randomRadioPitch() : safePitch,
        addedAt: new Date().toISOString(),
        addedBy: addedBy || 'web'
    }));
}

function maybeShuffleSongs(songs, shouldShuffle) {
    const next = [...songs];
    if (!shouldShuffle) return next;

    for (let i = next.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
    }

    return next;
}

function splitPlayableSongs(songs) {
    const playable = [];
    const omitted = [];

    songs.forEach(song => {
        if (song && song.url && typeof song.duration === 'number' && song.duration > 0) {
            playable.push(song);
        } else if (song) {
            omitted.push(song);
        }
    });

    return { playable, omitted };
}

function resolveInsertIndex(insertAt) {
    if (insertAt === 'first') return radioState.queue.length > 0 ? 1 : 0;
    if (insertAt === 'next') return radioState.queue.length > 0 ? 1 : 0;
    if (insertAt === 'last' || insertAt === undefined || insertAt === null || insertAt === '') return radioState.queue.length;

    const numeric = Number(insertAt);
    if (Number.isFinite(numeric)) {
        return Math.min(radioState.queue.length, Math.max(0, Math.floor(numeric)));
    }

    return radioState.queue.length;
}

function freezeCurrentRadioPosition(now = Date.now()) {
    if (radioState.status === 'playing' && radioCurrentItem()) {
        radioState.anchorPosition = radioPositionAt(now);
        radioState.anchorUpdatedAt = now;
    }
}

function enqueueRadioItems(items, insertAt) {
    const wasEmpty = radioState.queue.length === 0;
    const playNow = insertAt === 'now' || insertAt === 'play-now' || insertAt === 'current';
    const wasPlaying = radioState.status === 'playing';
    freezeCurrentRadioPosition();
    const index = playNow ? (radioState.queue.length > 0 ? 1 : 0) : resolveInsertIndex(insertAt);
    radioState.queue.splice(index, 0, ...items);
    if (playNow && !wasEmpty) {
        radioState.queue.shift();
        radioState.status = wasPlaying ? 'playing' : radioState.status;
        scheduleRadioCurrentFromStart();
    } else if (wasEmpty && radioState.queue.length > 0) {
        scheduleRadioCurrentFromStart();
    } else if (radioState.queue.length > 0 && radioState.anchorUpdatedAt === 0) {
        radioState.anchorUpdatedAt = Date.now();
    }
}

function shufflePendingRadioQueue() {
    if (radioState.queue.length <= 2) return;
    const current = radioState.queue[0];
    const pending = radioState.queue.slice(1);
    for (let i = pending.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [pending[i], pending[j]] = [pending[j], pending[i]];
    }
    radioState.queue = [current, ...pending];
}

async function findSongsByInputs(inputs) {
    const allSongs = await listAllSongs(true);
    const found = [];
    const missing = [];

    (inputs || []).forEach(input => {
        const raw = String(input || '').trim();
        if (!raw) return;
        const normalized = normalizeLookup(raw);
        const song = allSongs.find(item =>
            item.id === raw ||
            normalizeLookup(item.name) === normalized ||
            (item.variantes || []).some(variant => normalizeLookup(variant) === normalized)
        ) || allSongs.find(item =>
            normalizeLookup(item.name).includes(normalized) ||
            (item.variantes || []).some(variant => normalizeLookup(variant).includes(normalized))
        );

        if (song && !found.some(existing => existing.id === song.id)) {
            found.push(song);
        } else if (!song) {
            missing.push(raw);
        }
    });

    return { found, missing };
}

let firebaseAdminDbPromise = null;

async function getFirebaseAdminDb() {
    if (firebaseAdminDbPromise) return firebaseAdminDbPromise;

    firebaseAdminDbPromise = (async () => {
        const admin = require('firebase-admin');

        if (!admin.apps.length) {
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
                throw new Error('Firebase Admin no configurado. Define FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_PATH o GOOGLE_APPLICATION_CREDENTIALS.');
            }

            admin.initializeApp({
                credential,
                projectId: process.env.FIREBASE_PROJECT_ID || undefined
            });
        }

        return admin.firestore();
    })();

    return firebaseAdminDbPromise;
}

function extractUserPlaylistId(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    try {
        const parsed = new URL(raw);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const marker = parts.findIndex(part => part === 'user-playlist');
        if (marker >= 0 && parts[marker + 1]) {
            return decodeURIComponent(parts[marker + 1]);
        }
    } catch {
        const match = raw.match(/user-playlist\/([^/?#]+)/);
        if (match && match[1]) {
            return decodeURIComponent(match[1]);
        }
    }

    return raw;
}

async function getPublicUserPlaylistSongsFromUrl(value) {
    const playlistId = extractUserPlaylistId(value);
    if (!playlistId) {
        const err = new Error('URL de playlist propia no valida.');
        err.statusCode = 400;
        throw err;
    }

    const db = await getFirebaseAdminDb();
    const snap = await db.collection('privatePlaylists').doc(playlistId).get();

    if (!snap.exists) {
        const err = new Error('Playlist propia no encontrada.');
        err.statusCode = 404;
        throw err;
    }

    const data = snap.data() || {};
    const isPublicPlaylist = data.visibility === 'public' || data.isPublic === true || data.public === true;
    if (!isPublicPlaylist) {
        const err = new Error('La playlist propia no es publica.');
        err.statusCode = 403;
        throw err;
    }

    const songIds = Array.isArray(data.songEntries) && data.songEntries.length > 0
        ? data.songEntries.map(entry => String(entry.songId || '')).filter(Boolean)
        : Array.isArray(data.songIds) ? data.songIds.map(String) : [];
    const allSongs = await listAllSongs(true);
    const songs = songIds.map(id => allSongs.find(song => song.id === id)).filter(Boolean);

    return {
        playlist: {
            id: playlistId,
            nombre: data.nombre || 'Playlist propia',
            ownerId: data.ownerId || null
        },
        songs,
        missing: songIds.filter(id => !songs.some(song => song.id === id))
    };
}

try {
    migratePlaylistMetadata();
} catch (err) {
    console.error('No se pudo migrar playlists al arrancar:', err);
}

// ==========================================
// RUTAS DE CANCIONES
// ==========================================

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'farreo-music-backend',
        storage: BASE_DIR,
        time: new Date().toISOString()
    });
});

// Listar todas las canciones con sus metadatos
app.get('/canciones', async (req, res) => {
    try {
        const canciones = await listAllSongs(true);
        res.json(canciones);
    } catch (err) {
        console.error("Error leyendo canciones:", err);
        res.status(500).json({ error: "Error leyendo directorio" });
    }
});

// Obtener mapa de etiquetas { "variante": "nombre_cancion" }
app.get('/etiquetas', (req, res) => {
    try {
        const jsonFiles = fs.readdirSync(CANCIONES_DIR).filter(f => f.endsWith('.json'));
        const mapaEtiquetas = {};

        jsonFiles.forEach(jsonFile => {
            try {
                const parsed = JSON.parse(fs.readFileSync(path.join(CANCIONES_DIR, jsonFile), 'utf8'));
                const nombreCancion = parsed.nombre || jsonFile;
                if (Array.isArray(parsed.variantes)) {
                    parsed.variantes.forEach(v => {
                        mapaEtiquetas[v.toLowerCase()] = nombreCancion;
                    });
                }
            } catch (e) { /* ignorar jsons inválidos */ }
        });

        res.json(mapaEtiquetas);
    } catch (err) {
        res.status(500).json({ error: "Error leyendo etiquetas" });
    }
});

// Subir canción (mp3 → audios/, json → canciones/)
app.post('/upload', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'lyrics', maxCount: 1 }, { name: 'icon', maxCount: 1 }, { name: 'advancedCover', maxCount: 1 }]), async (req, res) => {
    const uploadedFile = req.files && req.files['file'] && req.files['file'][0];
    if (!uploadedFile) {
        return res.status(400).json({ error: "No se subió archivo" });
    }

    const savedFileName = uploadedFile.filename;
    const baseName = getBaseName(savedFileName);
    const jsonPath = path.join(CANCIONES_DIR, `${baseName}.json`);

    let metadatos = {
        nombre: uploadedFile.originalname,
        archivo: savedFileName,
        variantes: [],
        themeIds: []
    };

    const formMeta = readRequestMetadata(req);
    metadatos.nombre = formMeta.nombre || metadatos.nombre;
    metadatos.variantes = formMeta.variantes || [];
    metadatos.themeIds = songThemeStore.sanitizeThemeIds(formMeta.themeIds);

    const lyricsFile = req.files && req.files['lyrics'] && req.files['lyrics'][0];
    if (lyricsFile) {
        metadatos.lyricsFile = lyricsFile.filename;
        metadatos.lyricsOriginalName = lyricsFile.originalname;
    }

    const iconFile = req.files && req.files['icon'] && req.files['icon'][0];
    if (iconFile) {
        const iconResult = await optimizeSongIconFile(iconFile.filename);
        metadatos.manualIconFile = iconResult.fileName;
        metadatos.iconOriginalName = iconFile.originalname;
        metadatos.manualIconInfo = buildIconOptimizationInfo(iconResult);
    }

    const advancedCoverFile = req.files && req.files['advancedCover'] && req.files['advancedCover'][0];
    if (advancedCoverFile) {
        metadatos.advancedCoverFile = advancedCoverFile.filename;
        metadatos.advancedCoverOriginalName = advancedCoverFile.originalname;
        metadatos.advancedCoverMime = advancedCoverFile.mimetype || null;
    }

    await ensureSongAudioMetadata(savedFileName, metadatos, { forceArtwork: !metadatos.manualIconFile });
    fs.writeFileSync(jsonPath, JSON.stringify(metadatos, null, 4), 'utf8');
    res.json({ success: true, message: "Canción subida correctamente." });
});

// Borrar canción (mp3 de audios/ + json de canciones/ + limpiar de playlists)
app.delete('/cancion/:id', (req, res) => {
    const fileId = req.params.id;
    const audioPath = path.join(AUDIOS_DIR, fileId);

    if (!audioPath.startsWith(AUDIOS_DIR)) {
        return res.status(403).json({ error: "Acceso denegado" });
    }

    if (!fs.existsSync(audioPath)) {
        return res.status(404).json({ error: "Archivo no encontrado" });
    }

    // Averiguar el nombre de la canción antes de borrar (para limpiar playlists)
    const baseName = getBaseName(fileId);
    const jsonPath = path.join(CANCIONES_DIR, `${baseName}.json`);
    let nombreCancion = null;
    let metadata = null;
    if (fs.existsSync(jsonPath)) {
        try {
            metadata = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            nombreCancion = metadata.nombre;
        } catch (e) { /* ignorar */ }
    }

    // Borrar mp3
    fs.unlinkSync(audioPath);

    // Borrar json si existe
    if (fs.existsSync(jsonPath)) {
        fs.unlinkSync(jsonPath);
    }

    deleteLyricsFile(metadata);
    deleteSongIconFile(metadata && metadata.manualIconFile);
    deleteSongIconFile(metadata && metadata.embeddedIconFile);
    deleteSongAdvancedCoverFile(metadata && metadata.advancedCoverFile);

    // Limpiar esta canción de TODAS las playlists
    if (nombreCancion) {
        const playlistFiles = fs.readdirSync(PLAYLISTS_DIR).filter(f => f.endsWith('.txt'));
        playlistFiles.forEach(plFile => {
            const plPath = path.join(PLAYLISTS_DIR, plFile);
            const content = fs.readFileSync(plPath, 'utf8').trim();
            const lines = content ? content.split('\n').filter(l => l.trim()) : [];
            const filtered = lines.filter(l => l.trim() !== nombreCancion);
            if (filtered.length !== lines.length) {
                fs.writeFileSync(plPath, filtered.join('\n'), 'utf8');
            }
        });
    }

    const playlists = migratePlaylistMetadata();
    let metadataChanged = false;
    playlists.forEach(playlist => {
        if (playlist.songAddedAt && Object.prototype.hasOwnProperty.call(playlist.songAddedAt, fileId)) {
            delete playlist.songAddedAt[fileId];
            playlist.updatedAt = new Date().toISOString();
            metadataChanged = true;
        }
    });
    if (metadataChanged) {
        writePlaylistMetadata(playlists);
    }

    res.json({ success: true, message: "Canción eliminada de audios, metadatos y playlists." });
});

// Editar metadatos de una canción (nombre, variantes)
app.put('/cancion/:id', upload.fields([{ name: 'lyrics', maxCount: 1 }, { name: 'icon', maxCount: 1 }, { name: 'advancedCover', maxCount: 1 }]), async (req, res) => {
    const fileId = req.params.id;
    const baseName = getBaseName(fileId);
    const jsonPath = path.join(CANCIONES_DIR, `${baseName}.json`);

    if (!jsonPath.startsWith(CANCIONES_DIR)) {
        return res.status(403).json({ error: "Acceso denegado" });
    }

    if (!fs.existsSync(jsonPath)) {
        return res.status(404).json({ error: "Metadatos no encontrados" });
    }

    try {
        const existing = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const oldNombre = existing.nombre;
        const { nombre, variantes, themeIds, removeLyrics } = readRequestMetadata(req);

        if (nombre !== undefined) existing.nombre = nombre;
        if (variantes !== undefined) existing.variantes = variantes;
        if (themeIds !== undefined) existing.themeIds = songThemeStore.sanitizeThemeIds(themeIds);

        const lyricsFile = req.files && req.files['lyrics'] && req.files['lyrics'][0];
        if (lyricsFile) {
            deleteLyricsFile(existing);
            existing.lyricsFile = lyricsFile.filename;
            existing.lyricsOriginalName = lyricsFile.originalname;
        } else if (removeLyrics) {
            deleteLyricsFile(existing);
            delete existing.lyricsFile;
            delete existing.lyricsOriginalName;
        }

        const iconFile = req.files && req.files['icon'] && req.files['icon'][0];
        if (iconFile) {
            deleteSongIconFile(existing.manualIconFile);
            const iconResult = await optimizeSongIconFile(iconFile.filename);
            existing.manualIconFile = iconResult.fileName;
            existing.iconOriginalName = iconFile.originalname;
            existing.manualIconInfo = buildIconOptimizationInfo(iconResult);
        }

        const advancedCoverFile = req.files && req.files['advancedCover'] && req.files['advancedCover'][0];
        if (advancedCoverFile) {
            deleteSongAdvancedCoverFile(existing.advancedCoverFile);
            existing.advancedCoverFile = advancedCoverFile.filename;
            existing.advancedCoverOriginalName = advancedCoverFile.originalname;
            existing.advancedCoverMime = advancedCoverFile.mimetype || null;
        }

        await ensureSongAudioMetadata(fileId, existing, { forceArtwork: !existing.manualIconFile });

        fs.writeFileSync(jsonPath, JSON.stringify(existing, null, 4), 'utf8');

        // Si cambió el nombre, actualizar en todas las playlists
        if (nombre && nombre !== oldNombre) {
            const playlistFiles = fs.readdirSync(PLAYLISTS_DIR).filter(f => f.endsWith('.txt'));
            playlistFiles.forEach(plFile => {
                const plPath = path.join(PLAYLISTS_DIR, plFile);
                const content = fs.readFileSync(plPath, 'utf8').trim();
                const lines = content ? content.split('\n').filter(l => l.trim()) : [];
                const updated = lines.map(l => l.trim() === oldNombre ? nombre : l);
                if (JSON.stringify(updated) !== JSON.stringify(lines)) {
                    fs.writeFileSync(plPath, updated.join('\n'), 'utf8');
                }
            });
        }

        res.json({ success: true, message: "Metadatos actualizados.", data: existing });
    } catch (e) {
        res.status(500).json({ error: "Error actualizando metadatos" });
    }
});

// ==========================================
// RUTAS DE PLAYLISTS
// ==========================================

// Listar todas las playlists
app.get('/playlists', async (req, res) => {
    try {
        const playlists = migratePlaylistMetadata();
        await ensurePlaylistIconsOptimized(playlists);

        res.json(playlists.map(playlist => ({
            id: playlist.id,
            nombre: playlist.nombre,
            iconUrl: playlist.iconUrl || null,
            numCanciones: countPlaylistSongs(playlist)
        })));
    } catch (err) {
        console.error("Error leyendo playlists:", err);
        res.status(500).json({ error: "Error leyendo playlists" });
    }
});

// Obtener contenido de una playlist por id estable.
app.get('/playlist/:id', async (req, res) => {
    try {
        const { playlist, playlists } = getPlaylistByIdOrLegacy(req.params.id);

        if (!playlist) {
            return res.status(404).json({ error: "Playlist no encontrada" });
        }

        if (await ensurePlaylistIconOptimized(playlist)) {
            writePlaylistMetadata(playlists);
        }

        const canciones = await getSongsForGlobalPlaylist(playlist);

        res.json({
            id: playlist.id,
            nombre: playlist.nombre,
            iconUrl: playlist.iconUrl || null,
            canciones
        });
    } catch (err) {
        console.error("Error leyendo playlist:", err);
        res.status(500).json({ error: "Error leyendo playlist" });
    }
});

// Crear una playlist nueva
app.post('/playlist', uploadPlaylistIcon.single('icon'), async (req, res) => {
    const { nombre } = req.body;
    if (!nombre || !nombre.trim()) {
        return res.status(400).json({ error: "Nombre de playlist requerido" });
    }

    const playlists = migratePlaylistMetadata();
    const safeName = safePlaylistFileName(nombre);
    let fileName = `${safeName}.txt`;
    let filePath = path.resolve(PLAYLISTS_DIR, fileName);
    let suffix = 2;

    while (fs.existsSync(filePath)) {
        fileName = `${safeName}-${suffix}.txt`;
        filePath = path.resolve(PLAYLISTS_DIR, fileName);
        suffix++;
    }

    if (!filePath.startsWith(path.resolve(PLAYLISTS_DIR) + path.sep)) {
        return res.status(403).json({ error: "Nombre no valido" });
    }

    fs.writeFileSync(filePath, '', 'utf8');

    let iconUrl = null;
    if (req.file) {
        const iconResult = await optimizePlaylistIconFile(req.file.filename);
        iconUrl = iconResult.fileName ? `/playlist-icons/${iconResult.fileName}` : null;
    }

    const playlist = {
        id: uniquePlaylistId(safeName, playlists),
        nombre: nombre.trim(),
        fileName,
        iconUrl,
        songAddedAt: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    playlists.push(playlist);
    writePlaylistMetadata(playlists);

    res.json({ success: true, ...playlist, numCanciones: 0 });
});

// Editar nombre visible o icono de una playlist. El id y el archivo .txt no cambian.
app.put('/playlist/:id', uploadPlaylistIcon.single('icon'), async (req, res) => {
    const { playlist, playlists } = getPlaylistByIdOrLegacy(req.params.id);

    if (!playlist) {
        return res.status(404).json({ error: "Playlist no encontrada" });
    }

    const index = playlists.findIndex(p => p.id === playlist.id);
    const nombre = req.body.nombre;

    if (nombre !== undefined) {
        if (!nombre.trim()) {
            return res.status(400).json({ error: "Nombre de playlist requerido" });
        }
        playlists[index].nombre = nombre.trim();
    }

    if (req.file) {
        deletePlaylistIconFile(playlistIconFileNameFromUrl(playlists[index].iconUrl));
        const iconResult = await optimizePlaylistIconFile(req.file.filename);
        playlists[index].iconUrl = iconResult.fileName ? `/playlist-icons/${iconResult.fileName}` : null;
    }

    playlists[index].updatedAt = new Date().toISOString();
    writePlaylistMetadata(playlists);

    res.json({
        success: true,
        ...playlists[index],
        numCanciones: countPlaylistSongs(playlists[index])
    });
});

// Anadir una cancion a una playlist
app.post('/playlist/:id/add-song', async (req, res) => {
    const { playlist, playlists } = getPlaylistByIdOrLegacy(req.params.id);

    if (!playlist) {
        return res.status(404).json({ error: "Playlist no encontrada" });
    }

    const { nombreCancion } = req.body;
    if (!nombreCancion || !nombreCancion.trim()) {
        return res.status(400).json({ error: "Nombre de cancion requerido" });
    }

    const filePath = playlistFilePath(playlist);
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const lines = content ? content.split('\n').filter(l => l.trim()) : [];

    if (lines.includes(nombreCancion.trim())) {
        return res.status(409).json({ error: "Esta cancion ya esta en la playlist." });
    }

    lines.push(nombreCancion.trim());
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

    const allSongs = await listAllSongs(false);
    const song = allSongs.find(item => item.name === nombreCancion.trim() || item.id === nombreCancion.trim());
    if (song) {
        const index = playlists.findIndex(p => p.id === playlist.id);
        playlists[index].songAddedAt = playlists[index].songAddedAt || {};
        playlists[index].songAddedAt[song.id] = new Date().toISOString();
        playlists[index].updatedAt = new Date().toISOString();
        writePlaylistMetadata(playlists);
    }

    res.json({ success: true, message: `"${nombreCancion}" anadida a la playlist.` });
});

// Eliminar una playlist
app.delete('/playlist/:id', (req, res) => {
    const { playlist, playlists } = getPlaylistByIdOrLegacy(req.params.id);

    if (!playlist) {
        return res.status(404).json({ error: "Playlist no encontrada" });
    }

    const filePath = playlistFilePath(playlist);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }

    if (playlist.iconUrl) {
        const iconPath = path.resolve(BASE_DIR, playlist.iconUrl.replace(/^\//, ''));
        const iconsRoot = path.resolve(PLAYLIST_ICONS_DIR);
        if (iconPath.startsWith(iconsRoot + path.sep) && fs.existsSync(iconPath)) {
            fs.unlinkSync(iconPath);
        }
    }

    writePlaylistMetadata(playlists.filter(p => p.id !== playlist.id));
    res.json({ success: true, message: "Playlist eliminada." });
});

// Quitar una cancion de una playlist
app.delete('/playlist/:id/song', async (req, res) => {
    const { playlist, playlists } = getPlaylistByIdOrLegacy(req.params.id);

    if (!playlist) {
        return res.status(404).json({ error: "Playlist no encontrada" });
    }

    const nombreCancion = req.query.cancion;
    if (!nombreCancion) {
        return res.status(400).json({ error: "Nombre de cancion requerido" });
    }

    const filePath = playlistFilePath(playlist);
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const lines = content ? content.split('\n').filter(l => l.trim()) : [];
    const filtered = lines.filter(l => l.trim() !== nombreCancion);

    if (filtered.length === lines.length) {
        return res.status(404).json({ error: "Cancion no encontrada en la playlist" });
    }

    fs.writeFileSync(filePath, filtered.join('\n'), 'utf8');
    const allSongs = await listAllSongs(false);
    const song = allSongs.find(item => item.name === nombreCancion || item.id === nombreCancion);
    if (song) {
        const index = playlists.findIndex(p => p.id === playlist.id);
        if (index >= 0 && playlists[index].songAddedAt) {
            delete playlists[index].songAddedAt[song.id];
            playlists[index].updatedAt = new Date().toISOString();
            writePlaylistMetadata(playlists);
        }
    }
    res.json({ success: true, message: `"${nombreCancion}" quitada de la playlist.` });
});

// Reordenar canciones de una playlist global. La lista se persiste en el .txt.
app.post('/playlist/:id/reorder', async (req, res) => {
    const { playlist, playlists } = getPlaylistByIdOrLegacy(req.params.id);

    if (!playlist) {
        return res.status(404).json({ error: "Playlist no encontrada" });
    }

    const songIds = Array.isArray(req.body.songIds) ? req.body.songIds.map(String) : [];
    if (songIds.length === 0) {
        return res.status(400).json({ error: "songIds requerido." });
    }

    const currentSongs = await getSongsForGlobalPlaylist(playlist);
    const currentIds = currentSongs.map(song => song.id);
    const sameSongs =
        songIds.length === currentIds.length &&
        songIds.every(id => currentIds.includes(id)) &&
        currentIds.every(id => songIds.includes(id));

    if (!sameSongs) {
        return res.status(400).json({ error: "La reordenacion debe contener exactamente las canciones actuales." });
    }

    const byId = new Map(currentSongs.map(song => [song.id, song]));
    const reorderedNames = songIds.map(id => byId.get(id).name);
    fs.writeFileSync(playlistFilePath(playlist), reorderedNames.join('\n'), 'utf8');

    const index = playlists.findIndex(p => p.id === playlist.id);
    if (index >= 0) {
        playlists[index].updatedAt = new Date().toISOString();
        writePlaylistMetadata(playlists);
    }

    res.json({ success: true, canciones: songIds.map(id => byId.get(id)) });
});

const { registerAlbumRoutes } = require('./albums');
const albumApi = registerAlbumRoutes({
    app,
    getDb: getFirebaseAdminDb,
    listAllSongs,
    uploadIcon: uploadAlbumIcon,
    optimizeIcon: optimizeAlbumIconFile,
    deleteIcon: deleteAlbumIconFile,
});
app.get('/admin/canciones', albumApi.requireAdmin, async (req, res, next) => {
    try {
        const songs = await listAllSongs(true);
        res.json(songs.map(song => ({
            ...song,
            themeIds: readSongMetadata(song.id).themeIds,
        })));
    } catch (error) {
        next(error);
    }
});
songThemeStore.registerRoutes({
    app,
    requireAdmin: albumApi.requireAdmin,
    listAllSongs,
    readSongMetadata,
    getDb: getFirebaseAdminDb,
});

// ==========================================
// RUTAS DE DESCARGA DE YOUTUBE
// ==========================================
const { registerYoutubeRoutes } = require('./youtube');
registerYoutubeRoutes({ app, requireAdmin: albumApi.requireAdmin });

// ==========================================
// RUTAS DE RADIO
// ==========================================

app.get('/radio', (req, res) => {
    res.json(getSyncedRadioSnapshot());
});

app.get('/radio/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    radioClients.add(res);
    sendRadioEvent(res, 'state', getSyncedRadioSnapshot());

    const heartbeat = setInterval(() => {
        try {
            res.write(': heartbeat\n\n');
        } catch {
            clearInterval(heartbeat);
            radioClients.delete(res);
        }
    }, 25000);

    req.on('close', () => {
        clearInterval(heartbeat);
        radioClients.delete(res);
    });
});

app.post('/radio/resolve-user-playlist-url', async (req, res) => {
    try {
        const url = req.body.url || req.body.playlistUrl;
        const { playlist, songs, missing } = await getPublicUserPlaylistSongsFromUrl(url);
        res.json({
            playlist: {
                id: playlist.id,
                nombre: playlist.nombre,
                ownerId: playlist.ownerId,
                count: songs.length,
                missing
            }
        });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message || 'No se pudo resolver la playlist.' });
    }
});

app.post('/radio/play', (req, res) => {
    if (radioState.queue.length === 0) {
        return res.status(409).json({ error: 'La radio no tiene canciones en cola.' });
    }

    const now = Date.now();
    if (radioState.anchorPosition === 0) {
        applyAutoRandomPitchToCurrent();
    }
    radioState.anchorPosition = Math.min(radioState.anchorPosition || 0, radioCurrentDuration() || radioState.anchorPosition || 0);
    radioState.status = 'playing';
    if (radioState.anchorPosition <= 0) {
        scheduleRadioCurrentFromStart(now);
    } else {
        radioState.anchorUpdatedAt = now;
    }
    commitRadioState('play');
    res.json(getSyncedRadioSnapshot());
});

app.post('/radio/pause', (req, res) => {
    setRadioPaused();
    commitRadioState('pause');
    res.json(buildRadioSnapshot());
});

app.post('/radio/skip', (req, res) => {
    const wasPlaying = radioState.status === 'playing';
    if (radioState.queue.length > 0) {
        radioState.queue.shift();
    }

    radioState.status = wasPlaying && radioState.queue.length > 0 ? 'playing' : 'paused';
    if (radioState.status === 'playing') {
        applyAutoRandomPitchToCurrent();
        scheduleRadioCurrentFromStart();
    } else {
        radioState.anchorPosition = 0;
        radioState.anchorUpdatedAt = Date.now();
    }
    commitRadioState('skip');
    res.json(buildRadioSnapshot());
});

app.post('/radio/seek', (req, res) => {
    const current = radioCurrentItem();
    if (!current) {
        return res.status(409).json({ error: 'No hay cancion actual.' });
    }

    const duration = radioCurrentDuration();
    const requested = Number(req.body.position);
    if (!Number.isFinite(requested)) {
        return res.status(400).json({ error: 'Posicion no valida.' });
    }

    radioState.anchorPosition = duration > 0 ? Math.min(duration, Math.max(0, requested)) : Math.max(0, requested);
    radioState.anchorUpdatedAt = Date.now();
    commitRadioState('seek');
    res.json(buildRadioSnapshot());
});

app.patch('/radio/settings', (req, res) => {
    freezeCurrentRadioPosition();

    if (typeof req.body.shuffle === 'boolean') {
        radioState.shuffle = req.body.shuffle;
        if (radioState.shuffle) {
            shufflePendingRadioQueue();
        }
    }

    radioState.autoRandomPitch = false;

    if (req.body.shuffleNow) {
        shufflePendingRadioQueue();
    }

    commitRadioState('settings');
    res.json(buildRadioSnapshot());
});

app.post('/radio/queue/songs', async (req, res) => {
    try {
        const inputs = [
            ...(Array.isArray(req.body.songIds) ? req.body.songIds : []),
            ...(Array.isArray(req.body.queries) ? req.body.queries : []),
            ...(req.body.songId ? [req.body.songId] : []),
            ...(req.body.query ? [req.body.query] : [])
        ];

        const { found, missing } = await findSongsByInputs(inputs);
        const { playable, omitted } = splitPlayableSongs(found);

        if (playable.length === 0) {
            return res.status(404).json({
                error: 'No se encontraron canciones reproducibles.',
                missing,
                omitted: omitted.map(song => song.name)
            });
        }

        const items = createRadioItems(maybeShuffleSongs(playable, Boolean(req.body.shuffle)), {
            type: 'song',
            id: 'manual',
            name: playable.length === 1 ? playable[0].name : 'Canciones sueltas'
        }, req.body.pitch, req.body.addedBy, Boolean(req.body.randomPitch));

        enqueueRadioItems(items, req.body.insertAt || req.body.position);
        commitRadioState('queue');
        res.json({ ...buildRadioSnapshot(), added: items.length, missing, omitted: omitted.map(song => song.name) });
    } catch (err) {
        console.error('Error anadiendo canciones a radio:', err);
        res.status(500).json({ error: 'Error anadiendo canciones a radio.' });
    }
});

app.post('/radio/queue/global-playlist', async (req, res) => {
    try {
        const identifier = req.body.playlistId || req.body.id || req.body.name;
        if (!identifier) {
            return res.status(400).json({ error: 'Playlist requerida.' });
        }

        const { playlist } = getPlaylistByIdOrLegacy(identifier);
        if (!playlist) {
            return res.status(404).json({ error: 'Playlist global no encontrada.' });
        }

        const songs = await getSongsForGlobalPlaylist(playlist);
        const { playable, omitted } = splitPlayableSongs(songs);

        if (playable.length === 0) {
            return res.status(404).json({ error: 'La playlist no tiene canciones reproducibles.', omitted: omitted.map(song => song.name) });
        }

        const items = createRadioItems(maybeShuffleSongs(playable, Boolean(req.body.shuffle)), {
            type: 'global',
            id: playlist.id,
            name: playlist.nombre
        }, req.body.pitch, req.body.addedBy, Boolean(req.body.randomPitch));

        enqueueRadioItems(items, req.body.insertAt || req.body.position);
        commitRadioState('queue');
        res.json({ ...buildRadioSnapshot(), added: items.length, omitted: omitted.map(song => song.name) });
    } catch (err) {
        console.error('Error anadiendo playlist global a radio:', err);
        res.status(500).json({ error: 'Error anadiendo playlist global a radio.' });
    }
});

app.post('/radio/queue/album', async (req, res) => {
    try {
        const identifier = req.body.albumId || req.body.id;
        if (!identifier) return res.status(400).json({ error: 'Album requerido.' });

        const { album, songs } = await albumApi.getPublishedAlbumSongs(identifier, req, req.body.entryIds);
        const { playable, omitted } = splitPlayableSongs(songs);
        if (playable.length === 0) {
            return res.status(404).json({ error: 'El album no tiene canciones reproducibles.', omitted: omitted.map(song => song.name) });
        }

        const items = createRadioItems(maybeShuffleSongs(playable, Boolean(req.body.shuffle)), {
            type: 'album',
            id: album.id,
            name: album.nombre,
        }, req.body.pitch, req.body.addedBy, Boolean(req.body.randomPitch));

        enqueueRadioItems(items, req.body.insertAt || req.body.position);
        commitRadioState('queue');
        res.json({ ...buildRadioSnapshot(), added: items.length, omitted: omitted.map(song => song.name) });
    } catch (err) {
        console.error('Error anadiendo album a radio:', err);
        res.status(err.statusCode || 500).json({ error: err.message || 'Error anadiendo album a radio.' });
    }
});

app.post('/radio/queue/user-playlist-url', async (req, res) => {
    try {
        const url = req.body.url || req.body.playlistUrl;
        const { playlist, songs, missing } = await getPublicUserPlaylistSongsFromUrl(url);
        const { playable, omitted } = splitPlayableSongs(songs);

        if (playable.length === 0) {
            return res.status(404).json({ error: 'La playlist propia no tiene canciones reproducibles.', missing, omitted: omitted.map(song => song.name) });
        }

        const items = createRadioItems(maybeShuffleSongs(playable, Boolean(req.body.shuffle)), {
            type: 'private',
            id: playlist.id,
            name: playlist.nombre
        }, req.body.pitch, req.body.addedBy, Boolean(req.body.randomPitch));

        enqueueRadioItems(items, req.body.insertAt || req.body.position);
        commitRadioState('queue');
        res.json({ ...buildRadioSnapshot(), added: items.length, missing, omitted: omitted.map(song => song.name) });
    } catch (err) {
        console.error('Error anadiendo playlist propia a radio:', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Error anadiendo playlist propia a radio.' });
    }
});

app.patch('/radio/queue/:itemId', (req, res) => {
    const item = radioState.queue.find(entry => entry.itemId === req.params.itemId);
    if (!item) {
        return res.status(404).json({ error: 'Elemento de cola no encontrado.' });
    }

    const now = Date.now();
    const isCurrent = radioCurrentItem() && radioCurrentItem().itemId === item.itemId;
    if (isCurrent) {
        radioState.anchorPosition = radioPositionAt(now);
        radioState.anchorUpdatedAt = now;
    }

    if (req.body.pitch !== undefined) {
        item.pitch = clampPitch(req.body.pitch);
    }

    commitRadioState('queue');
    res.json(buildRadioSnapshot());
});

app.delete('/radio/queue/:itemId', (req, res) => {
    const index = radioState.queue.findIndex(entry => entry.itemId === req.params.itemId);
    if (index === -1) {
        return res.status(404).json({ error: 'Elemento de cola no encontrado.' });
    }

    const wasPlaying = radioState.status === 'playing';
    radioState.queue.splice(index, 1);

    if (index === 0) {
        radioState.status = wasPlaying && radioState.queue.length > 0 ? 'playing' : 'paused';
        if (radioState.status === 'playing') {
            scheduleRadioCurrentFromStart();
        } else {
            radioState.anchorPosition = 0;
            radioState.anchorUpdatedAt = Date.now();
        }
    }

    if (radioState.queue.length === 0) {
        radioState.status = 'paused';
        radioState.anchorPosition = 0;
        radioState.anchorUpdatedAt = Date.now();
    }

    commitRadioState('queue');
    res.json(buildRadioSnapshot());
});

app.post('/radio/queue/reorder', (req, res) => {
    freezeCurrentRadioPosition();

    const current = radioCurrentItem();
    const pending = radioState.queue.slice(current ? 1 : 0);

    if (Array.isArray(req.body.itemIds)) {
        const ordered = req.body.itemIds
            .map(id => pending.find(item => item.itemId === id))
            .filter(Boolean);
        const rest = pending.filter(item => !ordered.some(orderedItem => orderedItem.itemId === item.itemId));
        radioState.queue = current ? [current, ...ordered, ...rest] : [...ordered, ...rest];
    } else {
        const from = Number(req.body.fromIndex);
        const to = Number(req.body.toIndex);
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
            return res.status(400).json({ error: 'Indices no validos.' });
        }

        const localFrom = current ? from - 1 : from;
        const localTo = current ? to - 1 : to;
        if (localFrom < 0 || localFrom >= pending.length || localTo < 0 || localTo >= pending.length) {
            return res.status(400).json({ error: 'No se puede mover la cancion actual o indices fuera de rango.' });
        }

        const [item] = pending.splice(localFrom, 1);
        pending.splice(localTo, 0, item);
        radioState.queue = current ? [current, ...pending] : pending;
    }

    commitRadioState('queue');
    res.json(buildRadioSnapshot());
});

app.post('/radio/queue/clear', (req, res) => {
    radioState.queue = [];
    radioState.status = 'paused';
    radioState.anchorPosition = 0;
    radioState.anchorUpdatedAt = Date.now();
    commitRadioState('clear');
    res.json(buildRadioSnapshot());
});

let radioHeartbeatTicks = 0;
setInterval(() => {
    if (syncRadioClock()) {
        commitRadioState('advance');
        radioHeartbeatTicks = 0;
    } else if (radioState.status === 'playing') {
        radioHeartbeatTicks += 1;
        if (radioHeartbeatTicks >= 5) {
            radioHeartbeatTicks = 0;
            broadcastRadioState('state');
        }
    }
}, 1000);

refreshSongDurations().catch(err => {
    console.error('No se pudieron refrescar duraciones al arrancar:', err.message);
});

// ==========================================
// INICIAR SERVIDOR (HTTPS con fallback a HTTP)
// ==========================================
app.use((err, req, res, next) => {
    console.error('Error de API:', err);
    if (res.headersSent) return next(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Error interno del servidor.' });
});

const CERT_PATH = '/etc/letsencrypt/live/welite.ddns.net';

if (fs.existsSync(`${CERT_PATH}/fullchain.pem`) && fs.existsSync(`${CERT_PATH}/privkey.pem`)) {
    const httpsOptions = {
        cert: fs.readFileSync(`${CERT_PATH}/fullchain.pem`),
        key: fs.readFileSync(`${CERT_PATH}/privkey.pem`)
    };
    https.createServer(httpsOptions, app).listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`🎵 Servidor de Música Farreo iniciado (HTTPS 🔒)`);
        console.log(`📁 Almacenamiento: ${BASE_DIR}`);
        console.log(`   ├── audios/     (archivos .mp3)`);
        console.log(`   ├── canciones/  (metadatos .json)`);
        console.log(`   └── playlists/  (listas .txt)`);
        console.log(`📡 Puerto: ${PORT} (HTTPS)`);
        console.log(`======================================================\n`);
    });
} else {
    console.warn('\n⚠️  No se encontraron certificados HTTPS en ' + CERT_PATH);
    console.warn('   Ejecuta: sudo certbot certonly --standalone -d welite.ddns.net');
    console.warn('   Arrancando en modo HTTP (sin cifrar)...\n');
    app.listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`🎵 Servidor de Música Farreo iniciado (HTTP ⚠️)`);
        console.log(`📁 Almacenamiento: ${BASE_DIR}`);
        console.log(`📡 Puerto: ${PORT} (HTTP - sin cifrar)`);
        console.log(`======================================================\n`);
    });
}
