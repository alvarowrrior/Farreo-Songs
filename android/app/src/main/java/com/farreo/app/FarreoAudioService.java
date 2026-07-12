package com.farreo.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

import android.support.v4.media.session.MediaSessionCompat;
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

    public static void refresh(Context context) {
        Intent intent = new Intent(context, FarreoAudioService.class);
        intent.setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
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
        });
        updatePlaybackState();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getAction() != null) {
            switch (intent.getAction()) {
                case ACTION_TOGGLE:
                    controller.pause();
                    break;
                case ACTION_PREVIOUS:
                    controller.previous();
                    break;
                case ACTION_NEXT:
                    controller.next();
                    break;
                case ACTION_STOP:
                    controller.pause();
                    stopForeground(false);
                    stopSelf();
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
        if (controller != null) controller.removeListener(this);
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onControllerEvent(String eventName, JSObject payload) {
        updatePlaybackState();
        if (!"progress".equals(eventName)) {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            manager.notify(NOTIFICATION_ID, buildNotification());
        }
    }

    private Notification buildNotification() {
        boolean playing = controller.isPlaying();
        int playIcon = playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        String playLabel = playing ? "Pausar" : "Reproducir";

        PendingIntent previous = pending(ACTION_PREVIOUS, 11);
        PendingIntent toggle = pending(ACTION_TOGGLE, 12);
        PendingIntent next = pending(ACTION_NEXT, 13);
        PendingIntent content = PendingIntent.getActivity(
            this,
            14,
            getPackageManager().getLaunchIntentForPackage(getPackageName()),
            pendingFlags()
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(controller.getNotificationTitle())
            .setContentText(controller.getNotificationText())
            .setContentIntent(content)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(controller.hasTrack())
            .addAction(android.R.drawable.ic_media_previous, "Anterior", previous)
            .addAction(playIcon, playLabel, toggle)
            .addAction(android.R.drawable.ic_media_next, "Siguiente", next)
            .setStyle(new MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2))
            .build();
    }

    private PendingIntent pending(String action, int requestCode) {
        Intent intent = new Intent(this, FarreoAudioService.class);
        intent.setAction(action);
        return PendingIntent.getService(this, requestCode, intent, pendingFlags());
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
            .setState(state, 0, 1f)
            .build());
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
