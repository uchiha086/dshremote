package com.dshremote.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps polling the bridge in the background and posts a notification whenever a
 * DSH turn finishes, so the phone hears about it even when the app is not open.
 */
public class PollService extends Service {

    static final String CHANNEL_ONGOING = "dshremote-ongoing";
    static final String CHANNEL_TURNS = "dshremote-turns";
    private static final String TAG = "dshremote";
    private static final int ONGOING_ID = 1001;

    private Thread worker;
    private volatile boolean running;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannels(this);
        startForeground(ONGOING_ID, ongoingNotification(this, "已连接电脑，等待回合结束"));
        if (!running) {
            running = true;
            worker = new Thread(this::loop, "dshremote-poll");
            worker.setDaemon(true);
            worker.start();
        }
        return START_STICKY;
    }

    private void loop() {
        long since = System.currentTimeMillis();
        while (running) {
            try {
                Store cfg = Store.load(this);
                if (cfg.valid()) {
                    JSONArray events = Http.events(cfg.base(), cfg.token, since);
                    for (int i = 0; i < events.length(); i++) {
                        JSONObject ev = events.optJSONObject(i);
                        if (ev == null) continue;
                        long ts = ev.optLong("ts", 0);
                        if (ts > since) since = ts;
                        if (!"turn_end".equals(ev.optString("type"))) continue;
                        String title = ev.optString("title", "DSH");
                        String status = ev.optString("status", "done");
                        String head = ev.optString("head", "");
                        notifyTurn(this, title + " · " + status, head);
                    }
                }
                Thread.sleep(3000);
            } catch (InterruptedException e) {
                break;
            } catch (Exception e) {
                Log.w(TAG, "poll failed", e);
                try {
                    Thread.sleep(5000);
                } catch (InterruptedException ignored) {
                    break;
                }
            }
        }
    }

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ongoing = new NotificationChannel(CHANNEL_ONGOING, "后台连接", NotificationManager.IMPORTANCE_MIN);
        ongoing.setShowBadge(false);
        nm.createNotificationChannel(ongoing);
        NotificationChannel turns = new NotificationChannel(CHANNEL_TURNS, "回合完成", NotificationManager.IMPORTANCE_DEFAULT);
        turns.setShowBadge(true);
        nm.createNotificationChannel(turns);
    }

    static PendingIntent openApp(Context ctx) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(ctx, 0, intent, flags);
    }

    @SuppressWarnings("deprecation")
    static Notification ongoingNotification(Context ctx, String text) {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, CHANNEL_ONGOING)
                : new Notification.Builder(ctx);
        b.setContentTitle("DSH Remote")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true)
                .setContentIntent(openApp(ctx));
        return b.build();
    }

    @SuppressWarnings("deprecation")
    static void notifyTurn(Context ctx, String title, String text) {
        ensureChannels(ctx);
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, CHANNEL_TURNS)
                : new Notification.Builder(ctx);
        b.setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setAutoCancel(true)
                .setContentIntent(openApp(ctx));
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
    }

    static void start(Context ctx) {
        Intent i = new Intent(ctx, PollService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, PollService.class));
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
