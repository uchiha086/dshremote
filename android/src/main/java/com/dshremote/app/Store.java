package com.dshremote.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Persisted connection settings. */
final class Store {
    private static final String FILE = "dshremote";

    String host = "";
    int port = 3088;
    String token = "";
    int proxyPort = 7627;
    String tunnel = "";
    boolean preferTunnel = false;

    static Store load(Context ctx) {
        Store s = new Store();
        SharedPreferences p = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE);
        s.host = p.getString("host", "");
        s.port = p.getInt("port", 3088);
        s.token = p.getString("token", "");
        s.proxyPort = p.getInt("proxyPort", 7627);
        s.tunnel = p.getString("tunnel", "");
        s.preferTunnel = p.getBoolean("preferTunnel", false);
        return s;
    }

    void save(Context ctx) {
        SharedPreferences.Editor e = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit();
        e.putString("host", host);
        e.putInt("port", port);
        e.putString("token", token);
        e.putInt("proxyPort", proxyPort);
        e.putString("tunnel", tunnel);
        e.putBoolean("preferTunnel", preferTunnel);
        e.apply();
    }

    void clear(Context ctx) {
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().clear().apply();
        host = "";
        token = "";
        tunnel = "";
        preferTunnel = false;
    }

    boolean useTunnel() {
        return preferTunnel || host.isEmpty();
    }

    String base() {
        if (useTunnel()) return trimSlash(tunnel);
        return "http://" + host + ":" + port;
    }

    String webBase() {
        if (useTunnel()) return trimSlash(tunnel) + "/";
        return "http://" + host + ":" + proxyPort + "/";
    }

    boolean valid() {
        if (token.isEmpty()) return false;
        return useTunnel() ? !tunnel.isEmpty() : !host.isEmpty();
    }

    void apply(PairLink link) {
        token = link.token;
        if (!link.tunnel.isEmpty()) tunnel = link.tunnel;
        if (!link.host.isEmpty()) {
            host = link.host;
            port = link.port;
        }
        preferTunnel = link.host.isEmpty() && !link.tunnel.isEmpty();
    }

    static String trimSlash(String s) {
        String v = s == null ? "" : s.trim();
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }
}
