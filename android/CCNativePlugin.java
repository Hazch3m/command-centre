package com.hazch3m.commandcentre;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Pacelife's own abilities on Android (the iPhone app has the same in Swift):
 * - garminLogin: Garmin's real sign-in page in its own window; hands back the one-time ticket
 *   Garmin gives at the end. The password is typed only into Garmin's page.
 * - openAuth: a sign-in page (Google, Strava) in the browser; resolves with the commandcentre:// address it ends on.
 * - openBrowser: opens a page in the browser and returns at once (Sign in with Apple on Android waits on the service).
 * - health*: Apple Health doesn't exist on Android, so "not available".
 */
@CapacitorPlugin(name = "CCNative")
public class CCNativePlugin extends Plugin {
    private static CCNativePlugin instance;
    private PluginCall authCall;
    private String authScheme;
    private boolean authAway;

    @Override
    public void load() {
        instance = this;
    }

    /** MainActivity hands over commandcentre://… links here. */
    static boolean handleUrl(Uri uri) {
        CCNativePlugin p = instance;
        if (p == null || uri == null || p.authCall == null) return false;
        if (p.authScheme != null && !p.authScheme.equals(uri.getScheme())) return false;
        JSObject r = new JSObject();
        r.put("url", uri.toString());
        p.authCall.resolve(r);
        p.authCall = null;
        return true;
    }

    @PluginMethod
    public void openAuth(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("bad url");
            return;
        }
        if (authCall != null) authCall.reject("cancelled", "CANCELLED");
        authCall = call;
        authScheme = call.getString("scheme", "commandcentre");
        authAway = true;
        getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (authCall == null || !authAway) return;
        authAway = false;
        // Back in the app without the sign-in's link: they closed the browser.
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (authCall != null) {
                authCall.reject("cancelled", "CANCELLED");
                authCall = null;
            }
        }, 1500);
    }

    @PluginMethod
    public void openBrowser(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("bad url");
            return;
        }
        getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        call.resolve();
    }

    @SuppressLint("SetJavaScriptEnabled")
    @PluginMethod
    public void garminLogin(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://sso.garmin.com/")) {
            call.reject("not Garmin's sign-in page");
            return;
        }
        getActivity().runOnUiThread(() -> {
            Dialog d = new Dialog(getActivity(), android.R.style.Theme_DeviceDefault_NoActionBar);
            WebView w = new WebView(getActivity());
            WebSettings s = w.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
            final boolean[] done = { false };
            w.setWebViewClient(new WebViewClient() {
                private boolean check(String u) {
                    if (done[0] || u == null) return false;
                    Uri x = Uri.parse(u);
                    String t = x.getQueryParameter("ticket");
                    if ("connect.garmin.com".equals(x.getHost()) && t != null && !t.isEmpty()) {
                        done[0] = true;
                        JSObject r = new JSObject();
                        r.put("ticket", t);
                        call.resolve(r);
                        d.dismiss();
                        return true;
                    }
                    return false;
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                    return check(req.getUrl().toString());
                }

                @Override
                public void onPageStarted(WebView v, String u, Bitmap icon) {
                    if (!check(u)) super.onPageStarted(v, u, icon);
                }
            });
            d.setContentView(w);
            d.setOnDismissListener(x -> {
                if (!done[0]) {
                    done[0] = true;
                    call.reject("cancelled", "CANCELLED");
                }
                w.destroy();
            });
            w.loadUrl(url);
            d.show();
        });
    }

    @PluginMethod
    public void healthAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", false);
        call.resolve(r);
    }

    @PluginMethod
    public void healthAuthorize(PluginCall call) {
        call.reject("Apple Health is only on iPhone");
    }

    @PluginMethod
    public void healthWorkouts(PluginCall call) {
        call.reject("Apple Health is only on iPhone");
    }

    @PluginMethod
    public void healthWorkoutDetail(PluginCall call) {
        call.reject("Apple Health is only on iPhone");
    }

    @PluginMethod
    public void healthDaily(PluginCall call) {
        call.reject("Apple Health is only on iPhone");
    }

    @PluginMethod
    public void signInWithApple(PluginCall call) {
        call.reject("Sign in with Apple on Android goes through the browser");
    }
}
