package com.dshremote.app;

import java.net.URI;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;

/** Parses a pairing link: dshremote://pair?v=1&name=..&base=..&web=..&tunnel=..&token=.. */
final class PairLink {
    String name = "";
    String base = "";
    String web = "";
    String tunnel = "";
    String token = "";
    String host = "";
    int port = 3088;
    int proxyPort = 7627;

    static boolean looksLikePairLink(String s) {
        return s != null && s.trim().startsWith("dshremote://pair");
    }

    static PairLink parse(String raw) {
        PairLink link = new PairLink();
        try {
            URI uri = URI.create(raw.trim());
            String query = uri.getRawQuery();
            Map<String, String> params = new HashMap<>();
            if (query != null) {
                for (String pair : query.split("&")) {
                    int idx = pair.indexOf('=');
                    if (idx <= 0) continue;
                    String key = pair.substring(0, idx);
                    String value = URLDecoder.decode(pair.substring(idx + 1), "UTF-8");
                    params.put(key, value);
                }
            }
            link.name = nullToEmpty(params.get("name"));
            link.token = nullToEmpty(params.get("token"));
            link.tunnel = nullToEmpty(params.get("tunnel"));
            link.base = nullToEmpty(params.get("base"));
            link.web = nullToEmpty(params.get("web"));
            if (link.base.startsWith("https://")) {
                link.tunnel = link.base;
                link.base = "";
            }
            applyBase(link);
        } catch (Exception ignored) {
            // leave defaults; caller reports an error
        }
        return link;
    }

    private static void applyBase(PairLink link) {
        if (link.base.isEmpty()) return;
        try {
            URI u = URI.create(link.base);
            link.host = u.getHost() == null ? "" : u.getHost();
            int p = u.getPort();
            if (p > 0) link.port = p;
        } catch (Exception ignored) {
        }
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
