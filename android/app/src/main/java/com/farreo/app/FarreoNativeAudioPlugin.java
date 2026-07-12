package com.farreo.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "FarreoNativeAudio")
public class FarreoNativeAudioPlugin extends Plugin implements FarreoAudioController.Listener {
    private FarreoAudioController controller;

    @Override
    public void load() {
        controller = FarreoAudioController.get(getContext());
        controller.addListener(this);
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
        call.resolve(controller.loadQueue(tracks, startIndex, source, shuffle, pitch, volume));
    }

    @PluginMethod
    public void play(PluginCall call) {
        call.resolve(controller.play());
    }

    @PluginMethod
    public void pause(PluginCall call) {
        call.resolve(controller.pause());
    }

    @PluginMethod
    public void seek(PluginCall call) {
        call.resolve(controller.seek(call.getDouble("position", 0d)));
    }

    @PluginMethod
    public void next(PluginCall call) {
        call.resolve(controller.next());
    }

    @PluginMethod
    public void previous(PluginCall call) {
        call.resolve(controller.previous());
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        call.resolve(controller.setVolume(call.getDouble("volume", 1d).floatValue()));
    }

    @PluginMethod
    public void setPitch(PluginCall call) {
        call.resolve(controller.setPitch(call.getDouble("pitch", 1d).floatValue()));
    }

    @PluginMethod
    public void setShuffle(PluginCall call) {
        call.resolve(controller.setShuffle(call.getBoolean("shuffle", false)));
    }

    @PluginMethod
    public void enterRadio(PluginCall call) {
        call.resolve(controller.enterRadio(call.getString("apiUrl", "")));
    }

    @PluginMethod
    public void leaveRadio(PluginCall call) {
        call.resolve(controller.leaveRadio());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(controller.getState());
    }

    @Override
    public void onControllerEvent(String eventName, JSObject payload) {
        notifyListeners(eventName, payload);
    }
}
