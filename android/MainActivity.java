package com.hazch3m.commandcentre;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CCNativePlugin.class);
        super.onCreate(savedInstanceState);
    }

    /** commandcentre://… : a sign-in finishing in the browser. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && intent.getData() != null) CCNativePlugin.handleUrl(intent.getData());
    }
}
