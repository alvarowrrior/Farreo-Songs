package com.farreo.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.LruCache;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import com.getcapacitor.JSObject;

public class FarreoAudioService extends Service implements FarreoAudioController.Listener {
    public static final String ACTION_START = "com.farreo.app.audio.START";
    public static final String ACTION_TOGGLE = "com.farreo.app.audio.TOGGLE";
    public static final String ACTION_PREVIOUS = "com.farreo.app.audio.PREVIOUS";
    public static final String ACTION_NEXT = "com.farreo.app.audio.NEXT";
    public static final String ACTION_STOP = "com.farreo.app.audio.STOP";

    private static final String CHANNEL_ID = "farreo_playback";
    private static final int NOTIFICATION_ID = 4001;
    private static final int MAX_ARTWORK_DOWNLOAD_BYTES = 8 * 1024 * 1024;
    private static final int MAX_ARTWORK_DISK_FILES = 48;

    private FarreoAudioController controller;
    private MediaSessionCompat mediaSession;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // Keep several recently used covers in memory. A 512x512 ARGB bitmap is
    // ~1 MB, so 12 MB is enough for normal playlist back/forward navigation
    // without keeping an unbounded image cache alive.
    private final LruCache<String, Bitmap> artworkMemoryCache = new LruCache<String, Bitmap>(12 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
            return Math.max(1, value.getAllocationByteCount() / 1024);
        }
    };

    private Bitmap artwork;
    private Bitmap fallbackArtwork;
    private String artworkUrl = "";
    private String artworkLoadingUrl = "";
    private long lastProgressNotificationAt = 0;
    private volatile boolean stopping = false;

    public static void refresh(Context context) {
        Intent intent = new Intent(context, FarreoAudioService.class);
        intent.setAction(ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (RuntimeException ignored) {
            // Android puede denegar un foreground service fuera de una accion del usuario.
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        controller = FarreoAudioController.get(this);
        controller.addListener(this);
        fallbackArtwork = loadFallbackArtwork();
        artwork = fallbackArtwork;

        mediaSession = new MediaSessionCompat(this, "Farreo");
        mediaSession.setActive(true);
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                controller.play();
            }

            @Override
            public void onPause() {
                controller.pause();
            }

            @Override
            public void onSkipToNext() {
                controller.next();
            }

            @Override
            public void onSkipToPrevious() {
                controller.previous();
            }

            @Override
            public void onSeekTo(long pos) {
                controller.seek(pos / 1000d);
            }

            @Override
            public void onStop() {
                stopPlaybackForUserExit();
            }
        });
        updatePlaybackState();
        refreshArtwork();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (stopping) return START_NOT_STICKY;
        if (intent != null && intent.getAction() != null) {
            switch (intent.getAction()) {
                case ACTION_TOGGLE:
                    if (controller.isPlaying()) {
                        controller.pause();
                    } else {
                        controller.play();
                    }
                    break;
                case ACTION_PREVIOUS:
                    controller.previous();
                    break;
                case ACTION_NEXT:
                    controller.next();
                    break;
                case ACTION_STOP:
                    stopPlaybackForUserExit();
                    return START_NOT_STICKY;
                default:
                    break;
            }
        }

        startForeground(NOTIFICATION_ID, buildNotification());
        updatePlaybackState();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.cancel(NOTIFICATION_ID);
        if (controller != null) controller.removeListener(this);
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
        }
        artworkMemoryCache.evictAll();
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Quitar Farreo de recientes es una salida explicita: no dejamos un
        // foreground service oculto reproduciendo indefinidamente.
        stopPlaybackForUserExit();
        super.onTaskRemoved(rootIntent);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onControllerEvent(String eventName, JSObject payload) {
        if (stopping || "frequency".equals(eventName)) return;
        mainHandler.post(() -> handleControllerEvent(eventName));
    }

    private void handleControllerEvent(String eventName) {
        if (stopping) return;
        long now = SystemClock.elapsedRealtime();
        if ("progress".equals(eventName) && now - lastProgressNotificationAt < 1000) return;

        updatePlaybackState();

        // Track/state events immediately rebuild the text/MediaSession metadata
        // from the controller's canonical current Media3 item. Artwork is
        // resolved separately and never blocks the title from changing.
        if (!"progress".equals(eventName)) {
            refreshArtwork();
        }

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification());
        lastProgressNotificationAt = now;
    }

    private Notification buildNotification() {
        boolean playing = controller.isPlaying();
        int playIcon = playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        String playLabel = playing ? "Pausar" : "Reproducir";

        PendingIntent previous = pending(ACTION_PREVIOUS, 11);
        PendingIntent toggle = pending(ACTION_TOGGLE, 12);
        PendingIntent next = pending(ACTION_NEXT, 13);
        PendingIntent dismiss = pending(ACTION_STOP, 15);
        PendingIntent content = PendingIntent.getActivity(
            this,
            14,
            getPackageManager().getLaunchIntentForPackage(getPackageName()),
            pendingFlags()
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_farreo)
            .setContentTitle(controller.getNotificationTitle())
            .setContentText(controller.getNotificationText())
            .setContentIntent(content)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(false)
            .setDeleteIntent(dismiss)
            .addAction(android.R.drawable.ic_media_previous, "Anterior", previous)
            .addAction(playIcon, playLabel, toggle)
            .addAction(android.R.drawable.ic_media_next, "Siguiente", next)
            .setStyle(new MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));

        if (artwork != null) {
            builder.setLargeIcon(artwork);
        }

        long duration = controller.getNotificationDurationMs();
        if (duration > 0) {
            int max = (int) Math.min(Integer.MAX_VALUE, duration);
            int progress = (int) Math.min(max, controller.getNotificationPositionMs());
            builder.setProgress(max, progress, false);
        }

        updateMediaMetadata();
        return builder.build();
    }

    private PendingIntent pending(String action, int requestCode) {
        Intent intent = new Intent(this, FarreoAudioService.class);
        intent.setAction(action);
        return PendingIntent.getService(this, requestCode, intent, pendingFlags());
    }

    private void stopPlaybackForUserExit() {
        if (stopping) return;
        stopping = true;
        mainHandler.removeCallbacksAndMessages(null);
        if (controller != null) {
            controller.removeListener(this);
            controller.stopForUserExit();
        }
        if (mediaSession != null) {
            mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
                .setState(PlaybackStateCompat.STATE_STOPPED, 0, 0f)
                .build());
            mediaSession.setActive(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.cancel(NOTIFICATION_ID);
        stopSelf();
    }

    private int pendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return flags;
    }

    private void updatePlaybackState() {
        if (mediaSession == null || controller == null) return;
        long actions = PlaybackStateCompat.ACTION_PLAY
            | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            | PlaybackStateCompat.ACTION_SEEK_TO;
        int state = controller.isPlaying()
            ? PlaybackStateCompat.STATE_PLAYING
            : PlaybackStateCompat.STATE_PAUSED;
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(
                state,
                controller.getNotificationPositionMs(),
                controller.getNotificationPlaybackSpeed()
            )
            .build());
    }

    private void updateMediaMetadata() {
        if (mediaSession == null || controller == null) return;
        MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, controller.getNotificationTitle())
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, controller.getNotificationText())
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, controller.getNotificationDurationMs());
        if (artwork != null) {
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, artwork);
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, artwork);
        }
        mediaSession.setMetadata(metadata.build());
    }

    private void refreshArtwork() {
        if (controller == null) return;
        String nextUrl = controller.getNotificationArtworkUrl();

        if (nextUrl.isEmpty()) {
            artwork = fallbackArtwork;
            artworkUrl = "";
            artworkLoadingUrl = "";
            updateMediaMetadata();
            return;
        }

        if (nextUrl.equals(artworkUrl) && artwork != null) return;

        Bitmap cached = artworkMemoryCache.get(nextUrl);
        if (cached == null) {
            cached = readDiskArtwork(nextUrl);
            if (cached != null) artworkMemoryCache.put(nextUrl, cached);
        }

        if (cached != null) {
            artwork = cached;
            artworkUrl = nextUrl;
            artworkLoadingUrl = "";
            updateMediaMetadata();
            return;
        }

        if (nextUrl.equals(artworkLoadingUrl)) {
            // Text metadata can still change while an existing cover request is
            // in flight. Do not start another network request.
            updateMediaMetadata();
            return;
        }

        // Never carry the PREVIOUS song's cover into metadata for the new song.
        // Use the local Farreo icon until the correct cover arrives.
        artwork = fallbackArtwork;
        artworkUrl = "";
        artworkLoadingUrl = nextUrl;
        updateMediaMetadata();

        new Thread(() -> {
            Bitmap nextArtwork = loadArtwork(nextUrl);
            mainHandler.post(() -> {
                if (stopping) return;
                if (!nextUrl.equals(controller.getNotificationArtworkUrl())) {
                    // The user already moved to another song. Keep the bitmap in
                    // cache for later, but never apply it to the wrong metadata.
                    if (nextArtwork != null) artworkMemoryCache.put(nextUrl, nextArtwork);
                    if (nextUrl.equals(artworkLoadingUrl)) artworkLoadingUrl = "";
                    return;
                }

                artwork = nextArtwork != null ? nextArtwork : fallbackArtwork;
                artworkUrl = nextArtwork != null ? nextUrl : "";
                artworkLoadingUrl = "";
                if (nextArtwork != null) artworkMemoryCache.put(nextUrl, nextArtwork);

                NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                manager.notify(NOTIFICATION_ID, buildNotification());
            });
        }, "FarreoArtwork").start();
    }

    private Bitmap loadArtwork(String url) {
        try {
            Bitmap disk = readDiskArtwork(url);
            if (disk != null) return disk;

            byte[] bytes = downloadArtworkBytes(url);
            if (bytes == null || bytes.length == 0) return null;

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;

            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, 512);
            Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            if (decoded == null) return null;

            int largest = Math.max(decoded.getWidth(), decoded.getHeight());
            Bitmap result = decoded;
            if (largest > 512) {
                float scale = 512f / largest;
                result = Bitmap.createScaledBitmap(
                    decoded,
                    Math.max(1, Math.round(decoded.getWidth() * scale)),
                    Math.max(1, Math.round(decoded.getHeight() * scale)),
                    true
                );
                if (result != decoded) decoded.recycle();
            }

            writeDiskArtwork(url, result);
            return result;
        } catch (Exception ignored) {
            return null;
        }
    }

    private byte[] downloadArtworkBytes(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(6000);
        connection.setReadTimeout(6000);
        connection.setDoInput(true);
        connection.setUseCaches(true);
        try (InputStream input = connection.getInputStream();
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_ARTWORK_DOWNLOAD_BYTES) return null;
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } finally {
            connection.disconnect();
        }
    }

    private File artworkCacheDirectory() {
        File directory = new File(getCacheDir(), "farreo-artwork-v1");
        if (!directory.exists()) directory.mkdirs();
        return directory;
    }

    private File artworkCacheFile(String url) {
        return new File(artworkCacheDirectory(), sha256(url) + ".png");
    }

    private Bitmap readDiskArtwork(String url) {
        try {
            File file = artworkCacheFile(url);
            if (!file.isFile()) return null;
            Bitmap cached = BitmapFactory.decodeFile(file.getAbsolutePath());
            if (cached == null) {
                file.delete();
                return null;
            }
            // Mark as recently used so pruning behaves like an on-disk LRU.
            file.setLastModified(System.currentTimeMillis());
            return cached;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void writeDiskArtwork(String url, Bitmap bitmap) {
        if (bitmap == null) return;
        try {
            File file = artworkCacheFile(url);
            File temp = new File(file.getParentFile(), file.getName() + ".tmp");
            try (FileOutputStream output = new FileOutputStream(temp)) {
                bitmap.compress(Bitmap.CompressFormat.PNG, 92, output);
            }
            if (!temp.renameTo(file)) {
                file.delete();
                temp.renameTo(file);
            }
            file.setLastModified(System.currentTimeMillis());
            pruneDiskArtwork();
        } catch (Exception ignored) {
            // Playback/notification metadata remain valid without disk caching.
        }
    }

    private void pruneDiskArtwork() {
        File[] files = artworkCacheDirectory().listFiles((dir, name) -> name.endsWith(".png"));
        if (files == null || files.length <= MAX_ARTWORK_DISK_FILES) return;

        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (int index = 0; index < files.length - MAX_ARTWORK_DISK_FILES; index++) {
            files[index].delete();
        }
    }

    private String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) result.append(String.format("%02x", b));
            return result.toString();
        } catch (Exception ignored) {
            return Integer.toHexString(value.hashCode());
        }
    }

    private Bitmap loadFallbackArtwork() {
        try {
            Drawable drawable = getApplicationInfo().loadIcon(getPackageManager());
            if (drawable instanceof BitmapDrawable) {
                Bitmap bitmap = ((BitmapDrawable) drawable).getBitmap();
                if (bitmap != null) return bitmap;
            }

            int width = Math.max(1, drawable.getIntrinsicWidth());
            int height = Math.max(1, drawable.getIntrinsicHeight());
            int largest = Math.max(width, height);
            if (largest > 256) {
                float scale = 256f / largest;
                width = Math.max(1, Math.round(width * scale));
                height = Math.max(1, Math.round(height * scale));
            }
            Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            drawable.setBounds(0, 0, width, height);
            drawable.draw(canvas);
            return bitmap;
        } catch (Exception ignored) {
            return null;
        }
    }

    private int sampleSize(int width, int height, int target) {
        int sample = 1;
        while (width / (sample * 2) >= target && height / (sample * 2) >= target) {
            sample *= 2;
        }
        return sample;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Farreo",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Reproduccion de musica de Farreo");
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.createNotificationChannel(channel);
    }
}
