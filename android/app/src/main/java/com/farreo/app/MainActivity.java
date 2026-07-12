package com.farreo.app;

import com.getcapacitor.BridgeActivity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FarreoNativeAudioPlugin.class);
        registerPlugin(FarreoGoogleAuthPlugin.class);
        super.onCreate(savedInstanceState);
        openFarreoLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openFarreoLink(intent);
    }

    private void openFarreoLink(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"farreo.vercel.app".equals(data.getHost())) return;
        if (getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(data.toString()));
    }
}
