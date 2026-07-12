package com.farreo.app;

import android.content.Context;
import android.content.Intent;
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
    private boolean radioMode = false;
    private String radioApiUrl = DEFAULT_API_URL;
    private String radioItemId = "";
    private String radioStatus = "paused";

    private final Runnable progressRunnable = new Runnable() {
        @Override
        public void run() {
            notifyProgress();
            mainHandler.postDelayed(this, 500);
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
                FarreoAudioService.refresh(context);
            }

            @Override
            public void onMediaItemTransition(MediaItem mediaItem, int reason) {
                int index = player.getCurrentMediaItemIndex();
                if (index >= 0) currentIndex = index;
                notifyState("trackChanged");
                FarreoAudioService.refresh(context);
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_ENDED) {
                    notifyState("ended");
                }
                FarreoAudioService.refresh(context);
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

    public JSObject loadQueue(JSArray nextTracks, int startIndex, JSObject nextSource, boolean nextShuffle, float nextPitch, float nextVolume) {
        leaveRadioInternal();
        tracks = nextTracks == null ? new JSONArray() : nextTracks;
        source = nextSource;
        shuffle = nextShuffle;
        pitch = clamp(nextPitch, 0.5f, 1.5f);
        volume = clamp(nextVolume, 0f, 1f);

        player.clearMediaItems();
        for (int i = 0; i < tracks.length(); i++) {
            JSONObject track = tracks.optJSONObject(i);
            String url = resolveUrl(track == null ? "" : track.optString("url", ""));
            if (!url.isEmpty()) {
                player.addMediaItem(MediaItem.fromUri(Uri.parse(url)));
            }
        }

        if (player.getMediaItemCount() == 0) {
            currentIndex = -1;
            player.stop();
            notifyState("state");
            return getState();
        }

        currentIndex = Math.max(0, Math.min(startIndex, player.getMediaItemCount() - 1));
        player.setVolume(volume);
        player.setPlaybackParameters(new PlaybackParameters(pitch, pitch));
        player.seekTo(currentIndex, 0);
        player.prepare();
        ensureForeground();
        notifyState("trackChanged");
        return getState();
    }

    public JSObject play() {
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

    public JSObject enterRadio(String apiUrl) {
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

    private void leaveRadioInternal() {
        radioMode = false;
        radioItemId = "";
        radioStatus = "paused";
        mainHandler.removeCallbacks(radioPollRunnable);
    }

    public JSObject getState() {
        JSObject state = new JSObject();
        state.put("isAvailable", true);
        state.put("isPlaying", player.isPlaying());
        state.put("currentTrack", getCurrentTrackOrNull());
        state.put("currentSource", source == null ? JSONObject.NULL : source);
        state.put("position", player.getCurrentPosition() / 1000d);
        state.put("duration", getDurationSeconds());
        state.put("volume", volume);
        state.put("pitch", pitch);
        state.put("shuffle", shuffle);
        state.put("canPlayNext", radioMode || player.hasNextMediaItem());
        state.put("canPlayPrev", radioMode || player.hasPreviousMediaItem() || player.getCurrentPosition() > 3000);
        state.put("radioMode", radioMode);
        state.put("radioStatus", radioStatus);
        return state;
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

    private double getDurationSeconds() {
        long duration = player.getDuration();
        if (duration != C.TIME_UNSET && duration > 0) return duration / 1000d;
        JSONObject track = getCurrentTrackOrNull();
        return track == null ? 0 : track.optDouble("duration", 0);
    }

    private void notifyState(String eventName) {
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
        Intent intent = new Intent(context, FarreoAudioService.class);
        intent.setAction(FarreoAudioService.ACTION_START);
        ContextCompat.startForegroundService(context, intent);
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
