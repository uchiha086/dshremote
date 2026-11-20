package com.dshremote.app;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

import org.json.JSONArray;
import org.json.JSONObject;

/** Minimal JSON-over-HTTP helpers for the dshremote bridge protocol. */
final class Http {

    static final class Text {
        final int status;
        final String body;

        Text(int status, String body) {
            this.status = status;
            this.body = body;
        }

        boolean ok() {
            return status >= 200 && status < 400;
        }
    }

    static Text get(String url, int timeoutMs) {
        return get(url, timeoutMs, null);
    }

    /** Same as {@link #get(String, int)} but may attach the bridge token as a header. */
    static Text get(String url, int timeoutMs, String token) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json, text/plain, */*");
            if (token != null && !token.isEmpty()) {
                // 口令走请求头：URL 会进日志、代理缓存，也会被截图带走。
                conn.setRequestProperty("X-DSH-Token", token);
            }
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (in != null) {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) sb.append(line).append('\n');
                }
            }
            return new Text(status, sb.toString());
        } catch (Exception e) {
            return new Text(-1, e.getClass().getSimpleName() + ": " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static String enc(String s) {
        try {
            return URLEncoder.encode(s == null ? "" : s, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    /** "桥 0.2.0 · 协议 v1" on success, or an error message. */
    static String health(String base, int timeoutMs) {
        Text t = get(Store.trimSlash(base) + "/health", timeoutMs);
        if (!t.ok()) return "连不上：" + t.body;
        try {
            JSONObject o = new JSONObject(t.body);
            return "桥 " + o.optString("version", "?") + " · 协议 v" + o.optInt("protocol", 0);
        } catch (Exception e) {
            return "响应无法解析";
        }
    }

    static String cookie(String base, String token, String webBase) {
        String url = Store.trimSlash(base) + "/auth/cookie?token=" + enc(token) + "&base=" + enc(webBase);
        Text t = get(url, 8000);
        if (!t.ok()) return "";
        try {
            JSONObject o = new JSONObject(t.body);
            return o.optString("cookie", "");
        } catch (Exception e) {
            return "";
        }
    }

    static String authUrl(String base, String token, String webBase) {
        String url = Store.trimSlash(base) + "/auth/url?token=" + enc(token) + "&base=" + enc(webBase);
        Text t = get(url, 8000);
        if (!t.ok()) return "";
        try {
            return new JSONObject(t.body).optString("url", "");
        } catch (Exception e) {
            return "";
        }
    }

    /** A batch of bridge events plus the bridge-side cursor that goes with it. */
    static final class Events {
        final JSONArray list;
        final long latestSeq;

        Events(JSONArray list, long latestSeq) {
            this.list = list;
            this.latestSeq = latestSeq;
        }
    }

    /**
     * One-shot pairing code (60s, single use) exchanged for the real token.
     * Returns the whole JSON on success, null otherwise.
     */
    static JSONObject claim(String base, String code) {
        String url = Store.trimSlash(base) + "/pair/claim?code=" + enc(code);
        Text t = get(url, 8000);
        if (!t.ok()) return null;
        try {
            JSONObject o = new JSONObject(t.body);
            return o.optBoolean("ok", false) ? o : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Fetches turn_end events after {@code afterSeq} (bridge-side sequence, not phone clock).
     * Pass -1 for a first call that only primes the cursor.
     */
    static Events events(String base, String token, long afterSeq) {
        String url = Store.trimSlash(base) + "/events" + (afterSeq >= 0 ? "?afterSeq=" + afterSeq : "");
        Text t = get(url, 6000, token);
        if (!t.ok()) return new Events(new JSONArray(), -1);
        try {
            JSONObject o = new JSONObject(t.body);
            JSONArray arr = o.optJSONArray("events");
            return new Events(arr == null ? new JSONArray() : arr, o.optLong("latestSeq", -1));
        } catch (Exception e) {
            return new Events(new JSONArray(), -1);
        }
    }
}
