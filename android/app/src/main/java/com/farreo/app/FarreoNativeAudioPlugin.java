package com.farreo.app;

import android.Manifest;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import android.util.Log;

@CapacitorPlugin(
    name = "FarreoNativeAudio",
    permissions = {
        @Permission(alias = "audioVisualization", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class FarreoNativeAudioPlugin extends Plugin implements FarreoAudioController.Listener {
    private FarreoAudioController controller;

    private interface ControllerAction {
        JSObject run();
    }

    @Override
    public void load() {
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
        if (controller != null) controller.removeListener(this);
        super.handleOnDestroy();
    }

    @PluginMethod
    public void loadQueue(PluginCall call) {
        JSArray tracks = call.getArray("tracks", new JSArray());
        int startIndex = call.getInt("startIndex", 0);
        JSObject source = call.getObject("source", null);
        boolean shuffle = call.getBoolean("shuffle", false);
        float pitch = call.getDouble("pitch", 1d).floatValue();
        float volume = call.getDouble("volume", 1d).floatValue();
        resolveOnMain(call, () -> controller.loadQueue(tracks, startIndex, source, shuffle, pitch, volume));
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
