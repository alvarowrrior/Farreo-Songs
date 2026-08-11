const { spawn, execFile } = require('child_process');
const fs = require('fs');

// Descarga de YouTube. Vive en el servidor de casa y no en Vercel porque hace
// falta un disco persistente, binarios instalados, tiempo sin limite y una IP
// residencial (YouTube manda desafios de bot a las IPs de datacenter).

const YOUTUBE_REGEX =
    /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/|v\/)|youtu\.be\/)[\w\-]+/i;

// Limites pensados para no comerse el ancho de banda de casa, que es el mismo
// por el que se sirve la musica.
const MAX_CONCURRENT = Number(process.env.YOUTUBE_MAX_CONCURRENT) || 2;
const TIMEOUT_MS = (Number(process.env.YOUTUBE_TIMEOUT_SECONDS) || 600) * 1000;

function which(command) {
    return new Promise(resolve => {
        execFile('which', [command], (error, stdout) => {
            if (error) return resolve(null);
            const first = String(stdout).split('\n').map(line => line.trim()).filter(Boolean)[0];
            resolve(first || null);
        });
    });
}

function resolveBinary(envValue, command) {
    if (envValue && fs.existsSync(envValue)) return Promise.resolve(envValue);
    return which(command);
}

function sanitize(name) {
    return String(name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120).trim() || 'youtube';
}

function contentDisposition(filename, ext) {
    const full = `${filename}.${ext}`;
    const ascii = full.replace(/[^\x20-\x7E]+/g, '_').replace(/"/g, "'") || `youtube.${ext}`;
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`;
}

function registerYoutubeRoutes({ app, requireAdmin }) {
    let active = 0;

    // yt-dlp necesita un runtime JS para extraer YouTube; reutilizamos el Node
    // que ya ejecuta este servidor en vez de exigir deno.
    const commonArgs = ['--js-runtimes', `node:${process.execPath}`];

    async function binaries() {
        const [ytdlp, ffmpeg] = await Promise.all([
            resolveBinary(process.env.YTDLP_PATH, 'yt-dlp'),
            resolveBinary(process.env.FFMPEG_PATH, 'ffmpeg'),
        ]);
        return { ytdlp, ffmpeg };
    }

    function getTitle(binaryPath, url) {
        return new Promise((resolve, reject) => {
            const proc = spawn(binaryPath, [
                ...commonArgs,
                '--no-playlist',
                '--no-warnings',
                '--encoding', 'utf-8',
                '--print', '%(title)s',
                url,
            ]);
            proc.stdout.setEncoding('utf8');
            let out = '';
            let err = '';
            const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
            proc.stdout.on('data', chunk => { out += chunk; });
            proc.stderr.on('data', chunk => { err += chunk.toString(); });
            proc.on('error', error => { clearTimeout(timer); reject(error); });
            proc.on('close', code => {
                clearTimeout(timer);
                if (code === 0 && out.trim()) resolve(out.trim().split('\n')[0]);
                else reject(new Error(err.trim() || `yt-dlp salio con codigo ${code}`));
            });
        });
    }

    // Publica a proposito: la web necesita saber si puede ofrecer la herramienta
    // antes de que el usuario inicie sesion. No revela nada sensible.
    app.get('/youtube/status', async (req, res, next) => {
        try {
            const { ytdlp, ffmpeg } = await binaries();
            res.json({
                available: Boolean(ytdlp),
                ytdlp: Boolean(ytdlp),
                ffmpeg: Boolean(ffmpeg),
                busy: active >= MAX_CONCURRENT,
                reason: ytdlp
                    ? null
                    : 'El servidor no tiene yt-dlp instalado. Instalalo con "sudo pipx install yt-dlp" o define YTDLP_PATH.',
            });
        } catch (error) {
            next(error);
        }
    });

    app.post('/youtube/download', requireAdmin, async (req, res, next) => {
        const { url, format } = req.body || {};

        if (!url || !YOUTUBE_REGEX.test(url)) {
            return res.status(400).json({ error: 'URL de YouTube no valida.' });
        }
        if (format !== 'mp3' && format !== 'mp4') {
            return res.status(400).json({ error: 'El formato debe ser mp3 o mp4.' });
        }
        if (active >= MAX_CONCURRENT) {
            return res.status(429).json({
                error: `Ya hay ${active} descargas en curso. Espera a que terminen.`,
            });
        }

        let ytdlp;
        let ffmpeg;
        try {
            ({ ytdlp, ffmpeg } = await binaries());
        } catch (error) {
            return next(error);
        }

        if (!ytdlp) {
            return res.status(503).json({ error: 'El servidor no tiene yt-dlp instalado.' });
        }

        let title = 'youtube';
        try {
            title = sanitize(await getTitle(ytdlp, url));
        } catch (error) {
            return res.status(502).json({ error: `No se pudo leer el video: ${error.message}` });
        }

        active++;
        const children = [];
        let finished = false;

        const cleanup = () => {
            if (finished) return;
            finished = true;
            active--;
            clearTimeout(timeout);
            // Si el usuario cancela la descarga, matamos los procesos: si no,
            // seguirian tirando del ancho de banda para nada.
            for (const child of children) {
                try { child.kill('SIGKILL'); } catch { /* ya habia terminado */ }
            }
        };

        const timeout = setTimeout(() => {
            console.warn('[youtube] descarga abortada por tiempo:', url);
            cleanup();
            res.destroy();
        }, TIMEOUT_MS);

        res.on('close', cleanup);
        res.on('finish', cleanup);

        const spawnTracked = (binary, args) => {
            const child = spawn(binary, args);
            children.push(child);
            child.on('error', error => {
                console.error('[youtube] fallo al lanzar', binary, error.message);
                if (!res.headersSent) res.status(500).json({ error: `No se pudo ejecutar ${binary}.` });
                cleanup();
            });
            return child;
        };

        if (format === 'mp4') {
            const downloader = spawnTracked(ytdlp, [
                ...commonArgs,
                '-f', 'best[ext=mp4]/best',
                '--no-playlist',
                '-o', '-',
                '--quiet',
                '--no-warnings',
                url,
            ]);
            downloader.stderr.on('data', chunk => console.error('[yt-dlp]', chunk.toString().trim()));

            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', contentDisposition(title, 'mp4'));
            res.setHeader('Cache-Control', 'no-store');
            return downloader.stdout.pipe(res);
        }

        if (!ffmpeg) {
            // Sin ffmpeg no transcodificamos: servimos el mejor audio tal cual
            // en vez de fallar. La web avisa del cambio de formato.
            const downloader = spawnTracked(ytdlp, [
                ...commonArgs,
                '-f', 'bestaudio[ext=m4a]/bestaudio/best',
                '--no-playlist',
                '-o', '-',
                '--quiet',
                '--no-warnings',
                url,
            ]);
            downloader.stderr.on('data', chunk => console.error('[yt-dlp]', chunk.toString().trim()));

            res.setHeader('Content-Type', 'audio/mp4');
            res.setHeader('Content-Disposition', contentDisposition(title, 'm4a'));
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Farreo-Audio-Fallback', 'm4a');
            return downloader.stdout.pipe(res);
        }

        const downloader = spawnTracked(ytdlp, [
            ...commonArgs,
            '-f', 'bestaudio/best',
            '--no-playlist',
            '-o', '-',
            '--quiet',
            '--no-warnings',
            url,
        ]);
        const transcoder = spawnTracked(ffmpeg, [
            '-i', 'pipe:0',
            '-vn',
            '-f', 'mp3',
            '-ab', '192k',
            '-loglevel', 'error',
            'pipe:1',
        ]);

        downloader.stderr.on('data', chunk => console.error('[yt-dlp]', chunk.toString().trim()));
        transcoder.stderr.on('data', chunk => console.error('[ffmpeg]', chunk.toString().trim()));

        downloader.stdout.pipe(transcoder.stdin);
        downloader.stdout.on('error', () => transcoder.stdin.destroy());
        transcoder.stdin.on('error', () => { /* EPIPE cuando se cancela */ });

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', contentDisposition(title, 'mp3'));
        res.setHeader('Cache-Control', 'no-store');
        transcoder.stdout.pipe(res);
    });
}

module.exports = { registerYoutubeRoutes };
