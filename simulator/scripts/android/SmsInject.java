import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Looper;

import java.lang.reflect.Method;

/**
 * Root PDU injector for the DakFlare hardware gate.
 *
 * Runs under app_process as uid 0, which holds BROADCAST_SMS, and delivers a
 * real SMS_RECEIVED broadcast to the app's manifest receiver. It exercises the
 * production receive path (receiver, goAsync, JNI, SmsManager) without a
 * carrier round trip.
 *
 * `ActivityThread` is a hidden API, so it is reached by reflection: a compile
 * stub would shadow the framework class in the dex.
 *
 * Usage: SmsInject <pdu-hex[,pdu-hex...]> [subscription-id]
 */
public final class SmsInject {
    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: SmsInject <hex> [subId]");
            System.exit(2);
        }

        String[] hexParts = args[0].split(",");
        Object[] pdus = new Object[hexParts.length];
        for (int i = 0; i < hexParts.length; i++) {
            pdus[i] = hex(hexParts[i]);
        }

        // app_process starts a bare JVM thread; ActivityThread's Handler needs a
        // Looper before it can be constructed.
        Looper.prepareMainLooper();

        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Method systemMain = activityThread.getMethod("systemMain");
        Object thread = systemMain.invoke(null);
        Method getSystemContext = activityThread.getMethod("getSystemContext");
        Context context = (Context) getSystemContext.invoke(thread);

        Intent intent = new Intent("android.provider.Telephony.SMS_RECEIVED");
        intent.setComponent(new ComponentName(
                "dev.dakflare.simulator",
                "dev.dakflare.simulator.bridge.SmsReceiver"));
        intent.putExtra("pdus", pdus);
        intent.putExtra("format", "3gpp");
        if (args.length > 1) {
            intent.putExtra("subscription", Integer.parseInt(args[1]));
        }
        // An app that is merely not running (not force-stopped) is what a real
        // SMS delivers to; the flag keeps a momentarily stopped package equal.
        intent.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);

        context.sendBroadcast(intent);
        System.out.println("sent pdus=" + pdus.length);
        Thread.sleep(1200);
    }

    private static byte[] hex(String value) {
        int n = value.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) {
            out[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}
