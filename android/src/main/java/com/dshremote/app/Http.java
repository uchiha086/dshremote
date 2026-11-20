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
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json, text/plain, */*");
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

    /** Returns turn_end events newer than {@code since}; empty array on any error. */
    static JSONArray events(String base, String token, long since) {
        String url = Store.trimSlash(base) + "/events?token=" + enc(token) + "&since=" + since;
        Text t = get(url, 6000);
        if (!t.ok()) return new JSONArray();
        try {
            JSONObject o = new JSONObject(t.body);
            JSONArray arr = o.optJSONArray("events");
            return arr == null ? new JSONArray() : arr;
        } catch (Exception e) {
            return new JSONArray();
        }
    }
}
