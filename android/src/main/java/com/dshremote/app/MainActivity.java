package com.dshremote.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

import org.json.JSONObject;
import android.widget.TextView;

/**
 * Two screens: a connection screen (first run, or opened from the gear button) and a
 * full-screen WebView showing the desktop DSH UI.
 */
public class MainActivity extends Activity {

    private static final int REQ_NOTIFICATIONS = 7;

    private FrameLayout root;
    private Store cfg;
    private String statusMessage = "";
    private String pendingLink = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        PollService.ensureChannels(this);
        requestNotificationPermission();
        cfg = Store.load(this);
        handleIntent(getIntent());
        if (cfg.valid()) {
            showMain();
            connect();
        } else {
            showSetup(statusMessage);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
        if (cfg.valid() && pendingLink.isEmpty()) {
            showMain();
            connect();
        } else if (!pendingLink.isEmpty()) {
            showSetup("");
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;
        String raw = data.toString();
        if (!PairLink.looksLikePairLink(raw)) return;
        PairLink link = PairLink.parse(raw);
        // v2 只有一次性 code，没有 token；token 要等用户在设置页点「连接」时才换。
        if (link.token.isEmpty() && link.code.isEmpty()) {
            statusMessage = "配对链接里既没有口令也没有一次性码，请重新扫码";
            return;
        }
        if (!link.token.isEmpty()) {
            cfg.apply(link);
            cfg.save(this);
        }
        pendingLink = raw;
        statusMessage = "已从二维码读取配置";
    }

    // ---------------------------------------------------------------- setup screen

    private void showSetup(String message) {
        WebView old = currentWebView();
        if (old != null) {
            root.removeView(old);
            old.destroy();
        }
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setBackgroundColor(Color.WHITE);
        int pad = dp(28);
        col.setPadding(pad, dp(56), pad, pad);

        TextView title = new TextView(this);
        title.setText("DSH Remote");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        title.setTextColor(Color.rgb(20, 20, 20));
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        col.addView(title, matchWrap());

        TextView sub = new TextView(this);
        sub.setText("先配对，再用手机操控电脑上的 DSH");
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        sub.setTextColor(Color.rgb(110, 110, 110));
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = matchWrap();
        subLp.topMargin = dp(10);
        col.addView(sub, subLp);

        EditText linkField = new EditText(this);
        linkField.setHint("配对链接（扫码后会自动填）");
        linkField.setText(pendingLink);
        linkField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        linkField.setSingleLine(false);
        linkField.setMinLines(2);
        LinearLayout.LayoutParams linkLp = matchWrap();
        linkLp.topMargin = dp(28);
        col.addView(linkField, linkLp);

        EditText tokenField = new EditText(this);
        tokenField.setHint("配对 token");
        tokenField.setText(cfg.token);
        tokenField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        tokenField.setSingleLine(true);
        tokenField.setInputType(InputType.TYPE_CLASS_TEXT);
        LinearLayout.LayoutParams tokenLp = matchWrap();
        tokenLp.topMargin = dp(12);
        col.addView(tokenField, tokenLp);

        TextView status = new TextView(this);
        status.setText(message);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        status.setTextColor(message.startsWith("连不上") ? Color.rgb(200, 60, 60) : Color.rgb(0, 130, 90));
        status.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams statusLp = matchWrap();
        statusLp.topMargin = dp(16);
        col.addView(status, statusLp);

        Button connectBtn = new Button(this);
        connectBtn.setText("连接");
        connectBtn.setAllCaps(false);
        connectBtn.setTextColor(Color.WHITE);
        connectBtn.setBackground(rounded(Color.rgb(24, 90, 235), dp(14)));
        LinearLayout.LayoutParams connectLp = matchWrap();
        connectLp.topMargin = dp(20);
        connectLp.height = dp(52);
        col.addView(connectBtn, connectLp);

        TextView foot = new TextView(this);
        foot.setText("v0.2.1 · 电脑端需要 dshremote-bridge 插件");
        foot.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        foot.setTextColor(Color.rgb(160, 160, 160));
        foot.setGravity(Gravity.CENTER);        LinearLayout.LayoutParams footLp = matchWrap();
        footLp.topMargin = dp(24);
        col.addView(foot, footLp);

        connectBtn.setOnClickListener(v -> {
            String raw = linkField.getText().toString().trim();
            String token = tokenField.getText().toString().trim();
            if (!raw.isEmpty() && PairLink.looksLikePairLink(raw)) {
                PairLink link = PairLink.parse(raw);
                if (link.token.isEmpty()) link.token = token;
                cfg.apply(link);
                // v2 二维码里只有 60 秒一次性码：真正连之前先换成 token。
                if (link.token.isEmpty() && !link.code.isEmpty()) {
                    String claimBase = !link.base.isEmpty() ? link.base : link.tunnel;
                    final String code = link.code;
                    final String base = claimBase;
                    status.setText("正在用一次性码换取访问凭证…");
                    new Thread(() -> {
                        JSONObject claimed = Http.claim(base, code);
                        final String claimedToken = claimed == null ? "" : claimed.optString("token", "");
                        final String claimedTunnel = claimed == null ? "" : claimed.optString("tunnel", "");
                        runOnUiThread(() -> {
                            if (claimedToken.isEmpty()) {
                                status.setText("配对码已失效（60 秒过期），请回电脑刷新二维码");
                                return;
                            }
                            cfg.token = claimedToken;
                            if (!claimedTunnel.isEmpty()) cfg.tunnel = claimedTunnel;
                            cfg.save(this);
                            afterClaim();
                        });
                    }, "dshremote-claim").start();
                    return;
                }
            } else if (!token.isEmpty()) {
                cfg.token = token;
                if (!raw.isEmpty() && cfg.host.isEmpty() && cfg.tunnel.isEmpty()) {
                    cfg.host = raw.replace("http://", "").replace("https://", "");
                }
            }
            afterClaim();
        });

        root = new FrameLayout(this);
        root.addView(col, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
    }

    // ---------------------------------------------------------------- main screen

    /** 拿到 token 之后的统一入口：校验配置 → 进主界面 → 连接。 */
    private void afterClaim() {
        cfg.save(this);
        if (!cfg.valid()) {
            statusMessage = "还缺地址或 token";
            showSetup(statusMessage);
            return;
        }
        pendingLink = "";
        showMain();
        connect();
    }

    private void showMain() {
        WebView old = currentWebView();
        if (old != null) {
            // 换页必须先销毁旧 WebView，否则页面里的定时器与监听会一直活着。
            root.removeView(old);
            old.destroy();
        }
        root = new FrameLayout(this);
        WebView web = buildWebView();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView gear = new TextView(this);
        gear.setText("\u2699");
        gear.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        gear.setTextColor(Color.rgb(50, 50, 50));
        gear.setGravity(Gravity.CENTER);
        gear.setBackground(rounded(Color.argb(242, 255, 255, 255), dp(19)));
        gear.setOnClickListener(v -> showSetup(""));
        FrameLayout.LayoutParams gearLp = new FrameLayout.LayoutParams(dp(38), dp(38), Gravity.TOP | Gravity.END);
        gearLp.topMargin = dp(40);
        gearLp.rightMargin = dp(12);
        root.addView(gear, gearLp);

        setContentView(root);
    }

    private WebView buildWebView() {
        WebView web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        }
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebViewClient(new WebViewClient());
        return web;
    }

    private WebView currentWebView() {
        if (root == null) return null;
        for (int i = 0; i < root.getChildCount(); i++) {
            View v = root.getChildAt(i);
            if (v instanceof WebView) return (WebView) v;
        }
        return null;
    }

    // ---------------------------------------------------------------- connection

    private void connect() {
        final Store snapshot = cfg;
        new Thread(() -> {
            String base = snapshot.base();
            String webBase = snapshot.webBase();
            String health = Http.health(base, 6000);
            String url = webBase;
            if (health.startsWith("连不上")) {
                final String msg = health;
                runOnUiThread(() -> {
                    if (currentWebView() == null) {
                        showSetup("连不上：" + msg);
                    }
                });
                return;
            }
            String cookie = Http.cookie(base, snapshot.token, webBase);
            if (cookie.isEmpty()) {
                String authed = Http.authUrl(base, snapshot.token, webBase);
                if (!authed.isEmpty()) url = authed;
            } else {
                String root = webBase.endsWith("/") ? webBase.substring(0, webBase.length() - 1) : webBase;
                CookieManager cm = CookieManager.getInstance();
                cm.setCookie(root, cookie);
                cm.setCookie(root + "/", cookie);
                cm.flush();
            }
            final String target = url;
            runOnUiThread(() -> {
                WebView web = currentWebView();
                if (web != null) web.loadUrl(target);
            });
        }, "dshremote-connect").start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 前台服务只能在"用户看得见界面"时拉起，否则 Android 12+ 会直接抛
        // ForegroundServiceStartNotAllowedException。放到 onResume 里最稳。
        if (cfg != null && cfg.valid()) {
            PollService.start(this);
        }
    }

    @Override
    protected void onDestroy() {
        WebView web = currentWebView();
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }

    // ---------------------------------------------------------------- helpers

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private static LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private GradientDrawable rounded(int color, int radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(radius);
        return d;
    }
}
