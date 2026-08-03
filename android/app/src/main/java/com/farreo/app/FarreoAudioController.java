package com.farreo.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.audiofx.Visualizer;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.ContextCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;

public class FarreoAudioController {
    public interface Listener {
        void onControllerEvent(String eventName, JSObject payload);
    }

    private static final String DEFAULT_API_URL = "https://welite.ddns.net:3001";
    private static final String AUDIO_PREFS = "farreo-native-audio";
    private static final String PENDING_FIRST_PLAYS = "pending-album-first-plays";
    private static FarreoAudioController instance;

    private final Context context;
    private final ExoPlayer player;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();

    private JSONArray tracks = new JSONArray();
    private JSObject source;
    private int currentIndex = -1;
    private float volume = 1f;
    private float pitch = 1f;
    private boolean shuffle = false;
    private boolean autoRandomPitch = true;
    private int lastPitchTrackIndex = -1;
    private int firstListenLockedIndex = -1;
    private boolean firstListenPitchLocked = false;
    private long stateVersion = 0;
    private boolean radioMode = false;
    private boolean userExitStopping = false;
    private boolean visualizationEnabled = false;
    private Visualizer visualizer;
    private int visualizerAudioSessionId = C.AUDIO_SESSION_ID_UNSET;
    private String radioApiUrl = DEFAULT_API_URL;
    private String radioItemId = "";
    private String radioStatus = "paused";

    private final Runnable progressRunnable = new Runnable() {
        @Override
        public void run() {
            notifyProgress();
            mainHandler.postDelayed(this, 200);
        }
    };

    private final Runnable radioPollRunnable = new Runnable() {
        @Override
        public void run() {
            if (!radioMode) return;
            pollRadio();
            mainHandler.postDelayed(this, 2000);
        }
    };

    private FarreoAudioController(Context appContext) {
        context = appContext.getApplicationContext();
        player = new ExoPlayer.Builder(context).build();
        player.setVolume(volume);
        player.setPlaybackParameters(new PlaybackParameters(pitch, pitch));
        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                notifyState("state");
                refreshForegroundService();
            }

            @Override
            public void onMediaItemTransition(MediaItem mediaItem, int reason) {
                int index = player.getCurrentMediaItemIndex();
                boolean firstListenStarted = false;
                if (index >= 0) {
                    currentIndex = index;
                    firstListenStarted = applyFirstListenPitch(index);
                    if (!radioMode && !firstListenPitchLocked && autoRandomPitch && index != lastPitchTrackIndex) {
                        pitch = 0.8f + ((float) Math.random() * 0.4f);
                        player.setPlaybackParameters(new PlaybackParameters(pitch, pitch));
                    }
                    lastPitchTrackIndex = index;
                }
                if (firstListenStarted) notifyState("firstListenStarted");
                notifyState("trackChanged");
                refreshForegroundService();
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_ENDED) {
                    notifyState("ended");
                } else {
                    notifyState("state");
                }
                refreshForegroundService();
            }

            @Override
            public void onAudioSessionIdChanged(int audioSessionId) {
                configureVisualizer(audioSessionId);
            }
        });
        mainHandler.post(progressRunnable);
    }

    public static synchronized FarreoAudioController get(Context context) {
        if (instance == null) {
            instance = new FarreoAudioController(context.getApplicationContext());
        }
        return instance;
    }

    public void addListener(Listener listener) {
        listeners.add(listener);
    }

    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    public void setVisualizationEnabled(boolean enabled) {
        visualizationEnabled = enabled;
        if (!enabled) {
            releaseVisualizer();
            return;
        }
        configureVisualizer(player.getAudioSessionId());
    }

    public JSObject loadQueue(JSArray nextTracks, int startIndex, JSObject nextSource, boolean nextShuffle, boolean nextAutoRandomPitch, float nextPitch, float nextVolume) {
        userExitStopping = false;
        leaveRadioInternal();
        JSONArray normalizedTracks = nextTracks == null ? new JSONArray() : nextTracks;
        boolean sameQueue = hasSameQueue(normalizedTracks);
        tracks = normalizedTracks;
        source = nextSource;
        shuffle = nextShuffle;
        autoRandomPitch = nextAutoRandomPitch;
        pitch = clamp(nextPitch, 0.5f, 1.5f);
        volume = clamp(nextVolume, 0f, 1f);

        if (!sameQueue) {
            player.clearMediaItems();
            for (int i = 0; i < tracks.length(); i++) {
                JSONObject track = tracks.optJSONObject(i);
                String url = resolveUrl(track == null ? "" : track.optString("url", ""));
                if (!url.isEmpty()) {
                    player.addMediaItem(MediaItem.fromUri(Uri.parse(url)));
                }
            }
        }

        if (player.getMediaItemCount() == 0) {
            currentIndex = -1;
            player.stop();
            notifyState("state");
            return getState();
        }

        currentIndex = Math.max(0, Math.min(startIndex, player.getMediaItemCount() - 1));
        firstListenLockedIndex = -1;
        firstListenPitchLocked = false;
        lastPitchTrackIndex = currentIndex;
        boolean firstListenStarted = applyFirstListenPitch(currentIndex);
        player.setVolume(volume);
        player.setPlaybackParameters(new PlaybackParameters(pitch, pitch));
        player.setShuffleModeEnabled(shuffle);
        player.setRepeatMode(player.getMediaItemCount() > 1 ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
        player.seekTo(currentIndex, 0);
        player.prepare();
        ensureForeground();
        if (firstListenStarted) notifyState("firstListenStarted");
        notifyState("trackChanged");
        return getState();
    }

    public JSObject play() {
        userExitStopping = false;
        if (radioMode) {
            postRadio("/radio/play");
            return getState();
        }
        if (player.getMediaItemCount() > 0) {
            ensureForeground();
            player.play();
        }
        notifyState("state");
        return getState();
    }

    public JSObject pause() {
        if (radioMode) {
            String action = "playing".equals(radioStatus) ? "/radio/pause" : "/radio/play";
            postRadio(action);
            return getState();
        }
        player.pause();
        notifyState("state");
        return getState();
    }

    public JSObject seek(double positionSeconds) {
        long positionMs = Math.max(0, Math.round(positionSeconds * 1000));
        if (radioMode) {
            postRadio("/radio/seek", String.format(Locale.US, "{\"position\":%.3f}", positionSeconds));
            return getState();
        }
        player.seekTo(positionMs);
        notifyProgress();
        return getState();
    }

    public JSObject next() {
        if (radioMode) {
            postRadio("/radio/skip");
            return getState();
        }
        if (player.hasNextMediaItem()) {
            player.seekToNextMediaItem();
        }
        return getState();
    }

    public JSObject previous() {
        if (radioMode) {
            seek(0);
            return getState();
        }
        if (player.getCurrentPosition() > 3000) {
            player.seekTo(0);
        } else if (player.hasPreviousMediaItem()) {
            player.seekToPreviousMediaItem();
        }
        return getState();
    }

    public JSObject setVolume(float nextVolume) {
        volume = clamp(nextVolume, 0f, 1f);
        player.setVolume(volume);
        notifyState("state");
        return getState();
    }

    public JSObject setPitch(float nextPitch) {
        if (firstListenPitchLocked && !radioMode) return getState();
        pitch = clamp(nextPitch, 0.5f, 1.5f);
        player.setPlaybackParameters(new PlaybackParameters(pitch, pitch));
        if (radioMode && !radioItemId.isEmpty()) {
            postRadio("/radio/queue/" + radioItemId, String.format(Locale.US, "{\"pitch\":%.3f}", pitch), "PATCH");
        }
        notifyState("state");
        return getState();
    }

    public JSObject setShuffle(boolean nextShuffle) {
        shuffle = nextShuffle;
        player.setShuffleModeEnabled(shuffle);
        if (radioMode) {
            postRadio("/radio/settings", String.format(Locale.US, "{\"shuffle\":%s}", shuffle ? "true" : "false"), "PATCH");
        }
        notifyState("state");
        return getState();
    }

    public JSObject setAutoRandomPitch(boolean enabled) {
        autoRandomPitch = enabled;
        notifyState("state");
        return getState();
    }

    public JSObject enterRadio(String apiUrl) {
        userExitStopping = false;
        radioMode = true;
        radioApiUrl = (apiUrl == null || apiUrl.isEmpty()) ? DEFAULT_API_URL : apiUrl;
        ensureForeground();
        pollRadio();
        mainHandler.removeCallbacks(radioPollRunnable);
        mainHandler.postDelayed(radioPollRunnable, 1600);
        notifyState("state");
        return getState();
    }

    public JSObject leaveRadio() {
        leaveRadioInternal();
        notifyState("state");
        return getState();
    }

    public void stopForUserExit() {
        // La radio es compartida: al cerrar esta APK se corta solamente su
        // reproduccion local, sin enviar una pausa a toda la estacion.
        userExitStopping = true;
        if (radioMode) leaveRadioInternal();
        visualizationEnabled = false;
        releaseVisualizer();
        player.pause();
        notifyState("state");
    }

    private void leaveRadioInternal() {
        radioMode = false;
        radioItemId = "";
        radioStatus = "paused";
        mainHandler.removeCallbacks(radioPollRunnable);
    }

    public JSObject getState() {
        JSObject state = new JSObject();
        state.put("isAvailable", true);
        state.put("stateVersion", stateVersion);
        state.put("isPlaying", player.isPlaying());
        state.put("isBuffering", player.getPlaybackState() == Player.STATE_BUFFERING);
        state.put("currentTrack", getCurrentTrackOrNull());
        state.put("currentSource", source == null ? JSONObject.NULL : source);
        state.put("position", player.getCurrentPosition() / 1000d);
        state.put("duration", getDurationSeconds());
        state.put("volume", volume);
        state.put("pitch", pitch);
        state.put("shuffle", shuffle);
        state.put("autoRandomPitch", autoRandomPitch);
        state.put("isPitchLocked", firstListenPitchLocked && !radioMode);
        state.put("canPlayNext", radioMode || player.hasNextMediaItem());
        state.put("canPlayPrev", radioMode || player.hasPreviousMediaItem() || player.getCurrentPosition() > 3000);
        state.put("radioMode", radioMode);
        state.put("radioStatus", radioStatus);
        return state;
    }

    public JSArray getPendingFirstPlays() {
        JSArray result = new JSArray();
        JSONArray pending = readPendingFirstPlays();
        for (int index = 0; index < pending.length(); index++) {
            JSONObject item = pending.optJSONObject(index);
            if (item != null) result.put(item);
        }
        return result;
    }

    public JSObject confirmFirstPlay(String albumId, String entryId, boolean keepPitchLocked) {
        JSONArray pending = readPendingFirstPlays();
        JSONArray next = new JSONArray();
        for (int index = 0; index < pending.length(); index++) {
            JSONObject item = pending.optJSONObject(index);
            if (item == null) continue;
            if (albumId.equals(item.optString("albumId")) && entryId.equals(item.optString("albumEntryId"))) continue;
            next.put(item);
        }
        context.getSharedPreferences(AUDIO_PREFS, Context.MODE_PRIVATE).edit().putString(PENDING_FIRST_PLAYS, next.toString()).apply();
        JSONObject current = getCurrentTrackOrNull();
        if (!keepPitchLocked && current != null && albumId.equals(current.optString("albumId")) && entryId.equals(current.optString("albumEntryId"))) {
            firstListenPitchLocked = false;
            firstListenLockedIndex = -1;
        }
        return getState();
    }

    private boolean hasSameQueue(JSONArray nextTracks) {
        if (tracks.length() != nextTracks.length() || player.getMediaItemCount() != nextTracks.length()) return false;
        for (int i = 0; i < tracks.length(); i++) {
            JSONObject currentTrack = tracks.optJSONObject(i);
            JSONObject nextTrack = nextTracks.optJSONObject(i);
            if (currentTrack == null || nextTrack == null) return false;
            if (!currentTrack.optString("id", "").equals(nextTrack.optString("id", ""))) return false;
            if (!resolveUrl(currentTrack.optString("url", "")).equals(resolveUrl(nextTrack.optString("url", "")))) return false;
        }
        return true;
    }

    public String getNotificationTitle() {
        JSONObject track = getCurrentTrackOrNull();
        return track == null ? "Farreo" : track.optString("name", "Farreo");
    }

    public String getNotificationText() {
        if (source != null) {
            return source.optString("name", radioMode ? "Radio" : "Farreo");
        }
        return radioMode ? "Radio" : "Farreo";
    }

    public String getNotificationArtworkUrl() {
        JSONObject track = getCurrentTrackOrNull();
        return track == null ? "" : resolveUrl(track.optString("iconUrl", ""));
    }

    public long getNotificationPositionMs() {
        return Math.max(0, player.getCurrentPosition());
    }

    public long getNotificationDurationMs() {
        long duration = player.getDuration();
        if (duration != C.TIME_UNSET && duration > 0) return duration;
        JSONObject track = getCurrentTrackOrNull();
        return track == null ? 0 : Math.max(0, Math.round(track.optDouble("duration", 0) * 1000));
    }

    public float getNotificationPlaybackSpeed() {
        return pitch;
    }

    private void configureVisualizer(int audioSessionId) {
        if (!visualizationEnabled || audioSessionId == C.AUDIO_SESSION_ID_UNSET || audioSessionId <= 0) return;
        if (visualizer != null && visualizerAudioSessionId == audioSessionId) return;

        releaseVisualizer();
        try {
            Visualizer nextVisualizer = new Visualizer(audioSessionId);
            int[] captureSizeRange = Visualizer.getCaptureSizeRange();
            int captureSize = Math.min(1024, captureSizeRange[1]);
            captureSize = Math.max(captureSizeRange[0], captureSize);
            nextVisualizer.setCaptureSize(captureSize);
            int rate = Math.min(Visualizer.getMaxCaptureRate(), 8000);
            nextVisualizer.setDataCaptureListener(new Visualizer.OnDataCaptureListener() {
                @Override
                public void onWaveFormDataCapture(Visualizer ignored, byte[] waveform, int samplingRate) {
                    // FFT delivers a frequency spectrum, which matches the wave header.
                }

                @Override
                public void onFftDataCapture(Visualizer ignored, byte[] fft, int samplingRate) {
                    final byte[] snapshot = fft.clone();
                    mainHandler.post(() -> notifyFrequency(snapshot));
                }
            }, rate, false, true);
            nextVisualizer.setEnabled(true);
            visualizer = nextVisualizer;
            visualizerAudioSessionId = audioSessionId;
        } catch (RuntimeException ignored) {
            // Some devices do not expose an analysable audio session. Playback
            // remains unaffected and the web header simply stays hidden.
            releaseVisualizer();
        }
    }

    private void releaseVisualizer() {
        if (visualizer != null) {
            try {
                visualizer.setEnabled(false);
                visualizer.release();
            } catch (RuntimeException ignored) {
            }
        }
        visualizer = null;
        visualizerAudioSessionId = C.AUDIO_SESSION_ID_UNSET;
    }

    private void notifyFrequency(byte[] fft) {
        if (!visualizationEnabled || fft.length < 8) return;
        int availableBins = Math.max(1, (fft.length / 2) - 1);
        int outputBins = Math.min(64, availableBins);
        JSArray samples = new JSArray();

        for (int outputIndex = 0; outputIndex < outputBins; outputIndex += 1) {
            int from = 1 + (outputIndex * availableBins / outputBins);
            int to = Math.max(from + 1, 1 + ((outputIndex + 1) * availableBins / outputBins));
            double magnitude = 0;
            for (int bin = from; bin < to && bin < availableBins + 1; bin += 1) {
                int real = fft[bin * 2];
                int imaginary = fft[(bin * 2) + 1];
                magnitude += Math.sqrt((real * real) + (imaginary * imaginary));
            }
            double average = magnitude / Math.max(1, to - from);
            int level = (int) Math.min(255, Math.round(Math.log1p(average) * 54));
            samples.put(level);
        }

        JSObject payload = new JSObject();
        payload.put("samples", samples);
        for (Listener listener : listeners) {
            listener.onControllerEvent("frequency", payload);
        }
    }

    public boolean isPlaying() {
        return player.isPlaying();
    }

    public boolean hasTrack() {
        return getCurrentTrackOrNull() != null;
    }

    public boolean isRadioMode() {
        return radioMode;
    }

    private void pollRadio() {
        new Thread(() -> {
            try {
                String response = request("GET", "/radio", null);
                JSONObject state = new JSONObject(response);
                applyRadioState(state);
            } catch (Exception error) {
                notifyError(error.getMessage());
            }
        }).start();
    }

    private void applyRadioState(JSONObject state) {
        mainHandler.post(() -> {
            JSONObject item = state.optJSONObject("currentItem");
            radioStatus = state.optString("status", "paused");
            if (item == null) {
                player.pause();
                tracks = new JSONArray();
                currentIndex = -1;
                radioItemId = "";
                notifyState("state");
                return;
            }

            JSONObject song = item.optJSONObject("song");
            if (song == null) return;

            String itemId = item.optString("itemId", "");
            double position = state.optDouble("position", 0);
            float nextPitch = (float) item.optDouble("pitch", 1);
            boolean changed = !itemId.equals(radioItemId);
            radioItemId = itemId;
            pitch = clamp(nextPitch, 0.5f, 1.5f);

            JSONObject nextSource = item.optJSONObject("source");
            source = new JSObject();
            if (nextSource != null) {
                source.put("id", nextSource.optString("id", "radio"));
                source.put("name", nextSource.optString("name", "Radio"));
                source.put("type", "radio");
            } else {
                source.put("id", "radio");
                source.put("name", "Radio");
                source.put("type", "radio");
            }

            JSONArray nextTracks = new JSONArray();
            JSONObject nativeSong = new JSONObject();
            copySong(song, nativeSong);
            nextTracks.put(nativeSong);
            tracks = nextTracks;
            currentIndex = 0;

            String url = resolveUrl(nativeSong.optString("url", ""));
            if (changed || player.getMediaItemCount() == 0) {
                player.clearMediaItems();
                player.addMediaItem(MediaItem.fromUri(Uri.parse(url)));
                player.prepare();
            }

            player.setPlaybackParameters(new PlaybackParameters(pitch, pitch));
            long desiredMs = Math.max(0, Math.round(position * 1000));
            long drift = Math.abs(player.getCurrentPosition() - desiredMs);
            if (changed || drift > 700) {
                player.seekTo(desiredMs);
            }

            if ("playing".equals(radioStatus)) {
                ensureForeground();
                player.play();
            } else {
                player.pause();
            }

            notifyState(changed ? "trackChanged" : "state");
        });
    }

    private void postRadio(String path) {
        postRadio(path, "{}", "POST");
    }

    private void postRadio(String path, String body) {
        postRadio(path, body, "POST");
    }

    private void postRadio(String path, String body, String method) {
        new Thread(() -> {
            try {
                request(method, path, body);
                pollRadio();
            } catch (Exception error) {
                notifyError(error.getMessage());
            }
        }).start();
    }

    private String request(String method, String path, String body) throws Exception {
        URL url = new URL(radioApiUrl + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(6000);
        connection.setReadTimeout(6000);
        connection.setRequestProperty("Accept", "application/json");
        if (body != null && !"GET".equals(method)) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }

        int status = connection.getResponseCode();
        BufferedReader reader = new BufferedReader(new InputStreamReader(
            status >= 400 ? connection.getErrorStream() : connection.getInputStream(),
            StandardCharsets.UTF_8
        ));
        StringBuilder builder = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            builder.append(line);
        }
        reader.close();
        if (status >= 400) throw new Exception("Radio HTTP " + status);
        return builder.toString();
    }

    private JSONObject getCurrentTrackOrNull() {
        if (currentIndex < 0 || currentIndex >= tracks.length()) return null;
        return tracks.optJSONObject(currentIndex);
    }

    private boolean applyFirstListenPitch(int index) {
        JSONObject track = index >= 0 && index < tracks.length() ? tracks.optJSONObject(index) : null;
        if (track == null || radioMode) {
            firstListenPitchLocked = false;
            firstListenLockedIndex = -1;
            return false;
        }
        if (index == firstListenLockedIndex) {
            firstListenPitchLocked = true;
            pitch = 1f;
            player.setPlaybackParameters(new PlaybackParameters(1f, 1f));
            return false;
        }

        firstListenPitchLocked = false;
        firstListenLockedIndex = -1;
        String albumId = track.optString("albumId", "");
        String entryId = track.optString("albumEntryId", "");
        if (!track.optBoolean("firstListenPending", false) || albumId.isEmpty() || entryId.isEmpty()) return false;

        firstListenPitchLocked = true;
        firstListenLockedIndex = index;
        pitch = 1f;
        player.setPlaybackParameters(new PlaybackParameters(1f, 1f));
        try {
            track.put("firstListenPending", false);
        } catch (JSONException ignored) {
        }
        enqueuePendingFirstPlay(albumId, entryId);
        return true;
    }

    private JSONArray readPendingFirstPlays() {
        SharedPreferences preferences = context.getSharedPreferences(AUDIO_PREFS, Context.MODE_PRIVATE);
        try {
            return new JSONArray(preferences.getString(PENDING_FIRST_PLAYS, "[]"));
        } catch (JSONException ignored) {
            return new JSONArray();
        }
    }

    private void enqueuePendingFirstPlay(String albumId, String entryId) {
        JSONArray pending = readPendingFirstPlays();
        for (int index = 0; index < pending.length(); index++) {
            JSONObject item = pending.optJSONObject(index);
            if (item != null && albumId.equals(item.optString("albumId")) && entryId.equals(item.optString("albumEntryId"))) return;
        }
        JSONObject item = new JSONObject();
        try {
            item.put("albumId", albumId);
            item.put("albumEntryId", entryId);
            pending.put(item);
            context.getSharedPreferences(AUDIO_PREFS, Context.MODE_PRIVATE).edit().putString(PENDING_FIRST_PLAYS, pending.toString()).apply();
        } catch (JSONException ignored) {
        }
    }

    private double getDurationSeconds() {
        long duration = player.getDuration();
        if (duration != C.TIME_UNSET && duration > 0) return duration / 1000d;
        JSONObject track = getCurrentTrackOrNull();
        return track == null ? 0 : track.optDouble("duration", 0);
    }

    private void notifyState(String eventName) {
        stateVersion += 1;
        JSObject state = getState();
        for (Listener listener : listeners) {
            listener.onControllerEvent(eventName, state);
        }
    }

    private void notifyProgress() {
        if (!player.isPlaying()) return;
        JSObject progress = new JSObject();
        progress.put("position", player.getCurrentPosition() / 1000d);
        progress.put("duration", getDurationSeconds());
        for (Listener listener : listeners) {
            listener.onControllerEvent("progress", progress);
        }
    }

    private void notifyError(String message) {
        JSObject payload = new JSObject();
        payload.put("message", message == null ? "Error de audio nativo" : message);
        for (Listener listener : listeners) {
            listener.onControllerEvent("error", payload);
        }
    }

    private void ensureForeground() {
        if (userExitStopping || (!hasTrack() && !radioMode)) return;
        Intent intent = new Intent(context, FarreoAudioService.class);
        intent.setAction(FarreoAudioService.ACTION_START);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException error) {
            notifyError("No se pudo iniciar el audio en segundo plano.");
        }
    }

    private void refreshForegroundService() {
        if (userExitStopping || (!hasTrack() && !radioMode)) return;
        FarreoAudioService.refresh(context);
    }

    private String resolveUrl(String url) {
        if (url == null || url.isEmpty()) return "";
        if (url.startsWith("http://") || url.startsWith("https://")) return url;
        return radioApiUrl + url;
    }

    private void copySong(JSONObject sourceSong, JSONObject targetSong) {
        JSONArray names = sourceSong.names();
        if (names == null) return;
        for (int i = 0; i < names.length(); i++) {
            String key = names.optString(i);
            try {
                targetSong.put(key, sourceSong.opt(key));
            } catch (JSONException ignored) {
            }
        }
        try {
            targetSong.put("url", resolveUrl(targetSong.optString("url", "")));
        } catch (JSONException ignored) {
        }
    }

    private float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }
}
