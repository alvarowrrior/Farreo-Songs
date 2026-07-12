package com.farreo.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

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

    private FarreoAudioController controller;
    private MediaSessionCompat mediaSession;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Bitmap artwork;
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
        if (nextUrl.equals(artworkUrl) || nextUrl.equals(artworkLoadingUrl)) return;

        if (nextUrl.isEmpty()) {
            artwork = null;
            artworkUrl = "";
            artworkLoadingUrl = "";
            return;
        }

        artworkLoadingUrl = nextUrl;
        new Thread(() -> {
            Bitmap nextArtwork = loadArtwork(nextUrl);
            mainHandler.post(() -> {
                if (stopping) return;
                if (!nextUrl.equals(controller.getNotificationArtworkUrl())) return;
                artwork = nextArtwork;
                artworkUrl = nextUrl;
                artworkLoadingUrl = "";
                NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                manager.notify(NOTIFICATION_ID, buildNotification());
            });
        }, "FarreoArtwork").start();
    }

    private Bitmap loadArtwork(String url) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            decodeArtwork(url, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;

            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, 512);
            Bitmap decoded = decodeArtwork(url, options);
            if (decoded == null) return null;

            int largest = Math.max(decoded.getWidth(), decoded.getHeight());
            if (largest <= 512) return decoded;
            float scale = 512f / largest;
            Bitmap scaled = Bitmap.createScaledBitmap(
                decoded,
                Math.max(1, Math.round(decoded.getWidth() * scale)),
                Math.max(1, Math.round(decoded.getHeight() * scale)),
                true
            );
            if (scaled != decoded) decoded.recycle();
            return scaled;
        } catch (Exception ignored) {
            return null;
        }
    }

    private Bitmap decodeArtwork(String url, BitmapFactory.Options options) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(6000);
        connection.setReadTimeout(6000);
        connection.setDoInput(true);
        try (InputStream input = connection.getInputStream()) {
            return BitmapFactory.decodeStream(input, null, options);
        } finally {
            connection.disconnect();
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
