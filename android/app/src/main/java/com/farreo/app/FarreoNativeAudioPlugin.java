package com.farreo.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.os.SystemClock;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(
    name = "FarreoNativeAudio",
    permissions = {
        @Permission(alias = "audioVisualization", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class FarreoNativeAudioPlugin extends Plugin implements FarreoAudioController.Listener {
    private static final long MAX_UPDATE_BYTES = 300L * 1024L * 1024L;

    private FarreoAudioController controller;
    private final ExecutorService updateExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean updateInProgress = new AtomicBoolean(false);
    private final AtomicBoolean updateCancelled = new AtomicBoolean(false);
    private AlertDialog updateDialog;
    private ProgressBar updateProgressBar;
    private TextView updateProgressMessage;

    private interface ControllerAction {
        JSObject run();
    }

    @Override
    public void load() {
        cleanupStaleUpdateApks();

        try {
            controller = FarreoAudioController.get(getContext());
            controller.addListener(this);
        } catch (RuntimeException error) {
            controller = null;
            Log.e("FarreoNativeAudio", "No se pudo iniciar el reproductor nativo", error);
        }
    }

    @Override
    protected void handleOnDestroy() {
        updateCancelled.set(true);
        dismissUpdateDialog();
        if (controller != null) controller.removeListener(this);
        updateExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void loadQueue(PluginCall call) {
        JSArray tracks = call.getArray("tracks", new JSArray());
        int startIndex = call.getInt("startIndex", 0);
        JSObject source = call.getObject("source", null);
        boolean shuffle = call.getBoolean("shuffle", false);
        boolean autoRandomPitch = call.getBoolean("autoRandomPitch", true);
        float pitch = call.getDouble("pitch", 1d).floatValue();
        float volume = call.getDouble("volume", 1d).floatValue();
        resolveOnMain(call, () -> controller.loadQueue(tracks, startIndex, source, shuffle, autoRandomPitch, pitch, volume));
    }

    @PluginMethod
    public void play(PluginCall call) {
        resolveOnMain(call, () -> controller.play());
    }

    @PluginMethod
    public void pause(PluginCall call) {
        resolveOnMain(call, () -> controller.pause());
    }

    @PluginMethod
    public void seek(PluginCall call) {
        double position = call.getDouble("position", 0d);
        resolveOnMain(call, () -> controller.seek(position));
    }

    @PluginMethod
    public void next(PluginCall call) {
        resolveOnMain(call, () -> controller.next());
    }

    @PluginMethod
    public void previous(PluginCall call) {
        resolveOnMain(call, () -> controller.previous());
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        float volume = call.getDouble("volume", 1d).floatValue();
        resolveOnMain(call, () -> controller.setVolume(volume));
    }

    @PluginMethod
    public void setPitch(PluginCall call) {
        float pitch = call.getDouble("pitch", 1d).floatValue();
        resolveOnMain(call, () -> controller.setPitch(pitch));
    }

    @PluginMethod
    public void setShuffle(PluginCall call) {
        boolean shuffle = call.getBoolean("shuffle", false);
        resolveOnMain(call, () -> controller.setShuffle(shuffle));
    }

    @PluginMethod
    public void setAutoRandomPitch(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        resolveOnMain(call, () -> controller.setAutoRandomPitch(enabled));
    }

    @PluginMethod
    public void enterRadio(PluginCall call) {
        String apiUrl = call.getString("apiUrl", "");
        resolveOnMain(call, () -> controller.enterRadio(apiUrl));
    }

    @PluginMethod
    public void leaveRadio(PluginCall call) {
        resolveOnMain(call, () -> controller.leaveRadio());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        resolveOnMain(call, () -> controller.getState());
    }

    @PluginMethod
    public void getPendingFirstPlays(PluginCall call) {
        if (!requireController(call)) return;
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            result.put("items", controller.getPendingFirstPlays());
            call.resolve(result);
        });
    }

    @PluginMethod
    public void confirmFirstPlay(PluginCall call) {
        String albumId = call.getString("albumId", "");
        String entryId = call.getString("albumEntryId", "");
        boolean forcePitch = call.getBoolean("forcePitch", true);
        if (albumId.isEmpty() || entryId.isEmpty()) {
            call.reject("Falta identificar la primera escucha.");
            return;
        }
        resolveOnMain(call, () -> controller.confirmFirstPlay(albumId, entryId, forcePitch));
    }

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        try {
            PackageInfo packageInfo = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? packageInfo.getLongVersionCode()
                : packageInfo.versionCode;
            JSObject result = new JSObject();
            result.put("version", packageInfo.versionName);
            result.put("build", versionCode);
            call.resolve(result);
        } catch (PackageManager.NameNotFoundException error) {
            call.reject("No se pudo leer la version instalada.", error);
        }
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url.isEmpty()) {
            call.reject("Falta la URL que se quiere abrir.");
            return;
        }

        if (isFarreoApkUrl(url)) {
            startFarreoAppUpdate(call, url);
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                getActivity().startActivity(intent);
                call.resolve();
            } catch (RuntimeException error) {
                call.reject("No se pudo abrir el enlace.", error);
            }
        });
    }

    private boolean isFarreoApkUrl(String value) {
        try {
            Uri uri = Uri.parse(value);
            String scheme = uri.getScheme();
            String last = uri.getLastPathSegment();
            return "https".equalsIgnoreCase(scheme)
                && last != null
                && "Farreo.apk".equalsIgnoreCase(last);
        } catch (RuntimeException error) {
            return false;
        }
    }

    private File updateDirectory() {
        return new File(getContext().getCacheDir(), "farreo-updates");
    }

    private void cleanupStaleUpdateApks() {
        File dir = updateDirectory();
        File[] files = dir.listFiles();
        if (files == null) return;

        for (File file : files) {
            String name = file.getName().toLowerCase();
            if (name.startsWith("farreo") && name.endsWith(".apk")) {
                try {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                } catch (RuntimeException ignored) {
                    // Cache cleanup is best-effort.
                }
            }
        }
    }

    private void startFarreoAppUpdate(PluginCall call, String url) {
        if (!updateInProgress.compareAndSet(false, true)) {
            // Repeated taps must never queue a second APK download.
            call.resolve();
            return;
        }
        updateCancelled.set(false);
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !getContext().getPackageManager().canRequestPackageInstalls()
        ) {
            updateInProgress.set(false);
            getActivity().runOnUiThread(() -> {
                try {
                    Toast.makeText(
                        getContext(),
                        "Permite a Farreo instalar actualizaciones y vuelve a pulsar Actualizar.",
                        Toast.LENGTH_LONG
                    ).show();
                    Intent settings = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName())
                    );
                    getActivity().startActivity(settings);
                    call.resolve();
                } catch (RuntimeException error) {
                    call.reject("No se pudo abrir el permiso de instalacion.", error);
                }
            });
            return;
        }

        showUpdateDialog();
        updateExecutor.execute(() -> {
            File target = null;
            HttpURLConnection connection = null;

            try {
                File dir = updateDirectory();
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new IllegalStateException("No se pudo preparar la cache de actualizacion.");
                }

                cleanupStaleUpdateApks();
                target = new File(dir, "Farreo-update.apk");

                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(120_000);
                connection.setRequestProperty("User-Agent", "Farreo-Android-Updater");
                connection.connect();

                int responseCode = connection.getResponseCode();
                if (responseCode < 200 || responseCode >= 300) {
                    throw new IllegalStateException("La descarga devolvio HTTP " + responseCode + ".");
                }

                long contentLength = connection.getContentLengthLong();
                if (contentLength > MAX_UPDATE_BYTES) {
                    throw new IllegalStateException("El APK de actualizacion es demasiado grande.");
                }

                long written = 0;
                long lastProgressAt = 0;
                byte[] buffer = new byte[64 * 1024];
                showDownloadProgress(0, contentLength);

                try (
                    InputStream input = connection.getInputStream();
                    FileOutputStream output = new FileOutputStream(target)
                ) {
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        if (updateCancelled.get()) throw new UpdateCancelledException();
                        written += read;
                        if (written > MAX_UPDATE_BYTES) {
                            throw new IllegalStateException("El APK de actualizacion supera el limite permitido.");
                        }
                        output.write(buffer, 0, read);
                        long now = SystemClock.elapsedRealtime();
                        if (now - lastProgressAt >= 160 || (contentLength > 0 && written >= contentLength)) {
                            showDownloadProgress(written, contentLength);
                            lastProgressAt = now;
                        }
                    }
                    output.flush();
                }

                if (updateCancelled.get()) throw new UpdateCancelledException();
                if (written <= 0 || !target.isFile() || (contentLength > 0 && written != contentLength)) {
                    throw new IllegalStateException("La descarga del APK esta incompleta.");
                }

                showDownloadProgress(written, written);
                File installFile = target;
                getActivity().runOnUiThread(() -> {
                    dismissUpdateDialog();
                    try {
                        Uri apkUri = FileProvider.getUriForFile(
                            getContext(),
                            getContext().getPackageName() + ".fileprovider",
                            installFile
                        );

                        Intent install = new Intent(Intent.ACTION_VIEW);
                        install.setDataAndType(apkUri, "application/vnd.android.package-archive");
                        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        getActivity().startActivity(install);
                        call.resolve();
                    } catch (RuntimeException error) {
                        //noinspection ResultOfMethodCallIgnored
                        installFile.delete();
                        call.reject("No se pudo abrir el instalador de Farreo.", error);
                    }
                });
            } catch (UpdateCancelledException ignored) {
                if (target != null) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                }
                getActivity().runOnUiThread(() -> {
                    dismissUpdateDialog();
                    call.resolve(); // Cancellation is intentional: do not open browser fallback.
                });
            } catch (Exception error) {
                if (target != null) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                }
                getActivity().runOnUiThread(() -> {
                    dismissUpdateDialog();
                    if (updateCancelled.get()) {
                        // A canceled/interrupted network request is not a failure:
                        // do not unexpectedly open a browser download.
                        call.resolve();
                        return;
                    }
                    Toast.makeText(
                        getContext(),
                        "No se pudo preparar la actualizacion. Se abrira la descarga normal.",
                        Toast.LENGTH_LONG
                    ).show();
                    call.reject("No se pudo descargar la actualizacion.", error);
                });
            } finally {
                if (connection != null) connection.disconnect();
                updateInProgress.set(false);
            }
        });
    }

    private static class UpdateCancelledException extends Exception { }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
    }

    private void showUpdateDialog() {
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (activity.isFinishing() || activity.isDestroyed()) return;
            if (updateDialog != null && updateDialog.isShowing()) return;

            LinearLayout content = new LinearLayout(activity);
            content.setOrientation(LinearLayout.VERTICAL);
            content.setPadding(dp(24), dp(12), dp(24), dp(10));

            TextView message = new TextView(activity);
            message.setText("Conectando con el servidor...\nNo cierres Farreo mientras se descarga la actualización.");
            message.setTextSize(14);
            content.addView(message);

            ProgressBar progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
            progress.setMax(100);
            progress.setIndeterminate(true);
            LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(8)
            );
            progressParams.topMargin = dp(20);
            content.addView(progress, progressParams);

            updateProgressBar = progress;
            updateProgressMessage = message;
            AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle("Actualizando Farreo")
                .setView(content)
                .setCancelable(false)
                .setNegativeButton("Cancelar", (ignored, which) -> updateCancelled.set(true))
                .create();
            dialog.setCanceledOnTouchOutside(false);
            updateDialog = dialog;
            dialog.show();
        });
    }

    private void showDownloadProgress(long written, long total) {
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (updateProgressBar == null || updateProgressMessage == null || updateCancelled.get()) return;
            boolean hasTotal = total > 0;
            updateProgressBar.setIndeterminate(!hasTotal);
            if (hasTotal) {
                int percent = (int) Math.min(100L, (written * 100L) / total);
                updateProgressBar.setProgress(percent);
                updateProgressMessage.setText(
                    percent + "% descargado (" + formatMegabytes(written) + " / " + formatMegabytes(total) + ")\n"
                    + "No cierres Farreo mientras se descarga la actualización."
                );
            } else {
                updateProgressMessage.setText(
                    "Descargando... " + formatMegabytes(written) + "\n"
                    + "No cierres Farreo mientras se descarga la actualización."
                );
            }
        });
    }

    private String formatMegabytes(long bytes) {
        return String.format(java.util.Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
    }

    private void dismissUpdateDialog() {
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (updateDialog != null) {
                updateDialog.dismiss();
                updateDialog = null;
            }
            updateProgressBar = null;
            updateProgressMessage = null;
        });
    }

    @PluginMethod
    public void enableVisualization(PluginCall call) {
        if (!requireController(call)) return;
        if (getPermissionState("audioVisualization") == PermissionState.GRANTED) {
            finishEnableVisualization(call);
            return;
        }
        requestPermissionForAlias("audioVisualization", call, "visualizationPermissionCallback");
    }

    @PermissionCallback
    private void visualizationPermissionCallback(PluginCall call) {
        if (getPermissionState("audioVisualization") == PermissionState.GRANTED) {
            finishEnableVisualization(call);
            return;
        }
        JSObject result = new JSObject();
        result.put("enabled", false);
        call.resolve(result);
    }

    private void finishEnableVisualization(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            controller.setVisualizationEnabled(true);
            JSObject result = new JSObject();
            result.put("enabled", true);
            call.resolve(result);
        });
    }

    private void resolveOnMain(PluginCall call, ControllerAction action) {
        if (!requireController(call)) return;
        getActivity().runOnUiThread(() -> {
            try {
                call.resolve(action.run());
            } catch (RuntimeException error) {
                Log.e("FarreoNativeAudio", "Fallo al ejecutar el reproductor nativo", error);
                call.reject("No se pudo ejecutar el reproductor nativo.");
            }
        });
    }

    private boolean requireController(PluginCall call) {
        if (controller != null) return true;
        call.reject("El reproductor nativo no esta disponible.");
        return false;
    }

    @Override
    public void onControllerEvent(String eventName, JSObject payload) {
        notifyListeners(eventName, payload);
    }
}
