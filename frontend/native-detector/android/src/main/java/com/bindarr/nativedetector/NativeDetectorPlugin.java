package com.bindarr.nativedetector;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.Collections;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// The live scanner's corner model, run by native ONNX Runtime.
//
// In the WebView the same model runs on ONE wasm thread: the WebView is never
// cross-origin isolated, so wasm gets no SharedArrayBuffer and no threads, and the
// JIT'd wasm is about twice the cost of native code on the same core besides.
// Here it gets the phone's real cores and its NEON kernels.
//
// The protocol is deliberately small, and the JS side (src/utils/nativeDetector.js)
// owns everything that is not inference: the sharpness gate, corner ordering, the
// focus score and the card signature all stay in the code the wasm path runs, so
// the two engines cannot drift apart.
//
//   status()                      -> { tag, engine }        what is loaded now
//   load({ model, tag, ep })      -> { engine, loadMs, timings, errors }
//   detect({ image })             -> { corners[8], sharpness, presence, runMs, prepMs }
//
// Frames arrive as base64 JPEG (~30 KB) rather than raw RGBA (~590 KB): the bridge
// is JSON strings, and encoding plus decoding a small JPEG is far cheaper than
// pushing three-quarters of a megabyte of base64 through it several times a second.
@CapacitorPlugin(name = "NativeDetector")
public class NativeDetectorPlugin extends Plugin {
    private static final String TAG = "NativeDetector";
    private static final int SIZE = 384;
    private static final int PLANE = SIZE * SIZE;
    private static final float[] MEAN = {0.485f, 0.456f, 0.406f};
    private static final float[] STD = {0.229f, 0.224f, 0.225f};
    private static final long[] SHAPE = {1, 3, SIZE, SIZE};

    // Static, and touched only from EXECUTOR: the plugin object is re-created with
    // the activity, the loaded session should not be, and ORT work must never run
    // on Capacitor's shared plugin thread, which every other plugin call waits on.
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static OrtEnvironment env;
    private static OrtSession session;
    private static String loadedTag;
    private static String engine;
    private static final FloatBuffer INPUT =
        ByteBuffer.allocateDirect(3 * PLANE * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
    private static final int[] ARGB = new int[PLANE];
    // value -> normalised float, per channel: 3 table lookups a pixel, no division.
    private static final float[][] LUT = new float[3][256];

    static {
        for (int c = 0; c < 3; c++) {
            for (int v = 0; v < 256; v++) LUT[c][v] = (v / 255f - MEAN[c]) / STD[c];
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        EXECUTOR.execute(() -> {
            JSObject r = new JSObject();
            r.put("tag", loadedTag);
            r.put("engine", engine);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void load(PluginCall call) {
        final String model = call.getString("model");
        final String tag = call.getString("tag");
        final String ep = call.getString("ep", "auto");
        if (model == null || model.isEmpty()) {
            call.reject("model is required");
            return;
        }
        EXECUTOR.execute(() -> {
            long t0 = SystemClock.elapsedRealtime();
            try {
                byte[] bytes = Base64.decode(model, Base64.DEFAULT);
                if (env == null) env = OrtEnvironment.getEnvironment();
                closeSession();

                // "auto" times each engine on this phone and keeps the fastest. Which
                // one wins depends on the SoC and was NOT measurable from a desktop, so
                // it is decided here rather than guessed; the result rides on every
                // detection as the engine name, and the timings come back to the log.
                String[] candidates = "auto".equals(ep) ? new String[]{"cpu", "xnnpack"} : new String[]{ep};
                JSObject timings = new JSObject();
                JSObject errors = new JSObject();
                OrtSession best = null;
                String bestEp = null;
                double bestMs = Double.MAX_VALUE;
                for (String cand : candidates) {
                    OrtSession s = null;
                    try {
                        s = create(bytes, cand);
                        double ms = bench(s);
                        timings.put(cand, Math.round(ms * 10) / 10.0);
                        if (ms < bestMs) {
                            if (best != null) best.close();
                            best = s;
                            bestEp = cand;
                            bestMs = ms;
                            s = null;
                        }
                    } catch (Throwable t) {
                        errors.put(cand, String.valueOf(t.getMessage()));
                        Log.w(TAG, cand + " unavailable: " + t);
                    } finally {
                        if (s != null) s.close();
                    }
                }
                if (best == null) {
                    call.reject("no engine could load the model: " + errors);
                    return;
                }
                session = best;
                loadedTag = tag;
                engine = "native-" + bestEp;
                JSObject r = new JSObject();
                r.put("engine", engine);
                r.put("loadMs", SystemClock.elapsedRealtime() - t0);
                r.put("timings", timings);
                r.put("errors", errors);
                Log.i(TAG, engine + " ready, timings " + timings + (errors.length() > 0 ? ", errors " + errors : ""));
                call.resolve(r);
            } catch (Throwable t) {
                Log.e(TAG, "load failed", t);
                call.reject("load failed: " + t.getMessage());
            }
        });
    }

    @PluginMethod
    public void detect(PluginCall call) {
        final String image = call.getString("image");
        if (image == null) {
            call.reject("image is required");
            return;
        }
        EXECUTOR.execute(() -> {
            if (session == null) {
                call.reject("not loaded");
                return;
            }
            try {
                long t0 = SystemClock.elapsedRealtimeNanos();
                byte[] jpeg = Base64.decode(image, Base64.DEFAULT);
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
                Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, opts);
                if (bmp == null) {
                    call.reject("image did not decode");
                    return;
                }
                // The scanner sends exactly 384x384; anything else is squashed, the
                // same `fit: fill` the wasm path and the server use.
                if (bmp.getWidth() != SIZE || bmp.getHeight() != SIZE) {
                    Bitmap scaled = Bitmap.createScaledBitmap(bmp, SIZE, SIZE, true);
                    bmp.recycle();
                    bmp = scaled;
                }
                bmp.getPixels(ARGB, 0, SIZE, 0, 0, SIZE, SIZE);
                bmp.recycle();
                for (int i = 0; i < PLANE; i++) {
                    int p = ARGB[i];
                    INPUT.put(i, LUT[0][(p >> 16) & 0xff]);
                    INPUT.put(PLANE + i, LUT[1][(p >> 8) & 0xff]);
                    INPUT.put(2 * PLANE + i, LUT[2][p & 0xff]);
                }
                long t1 = SystemClock.elapsedRealtimeNanos();
                JSObject r = new JSObject();
                try (OnnxTensor x = OnnxTensor.createTensor(env, INPUT, SHAPE);
                     OrtSession.Result out = session.run(Collections.singletonMap("image", x))) {
                    long t2 = SystemClock.elapsedRealtimeNanos();
                    float[] corners = floats(out, "corners");
                    if (corners == null || corners.length < 8) {
                        call.reject("model has no corners output");
                        return;
                    }
                    JSArray c = new JSArray();
                    for (int i = 0; i < 8; i++) c.put((double) corners[i]);
                    r.put("corners", c);
                    float[] sharp = floats(out, "sharpness");
                    float[] presence = floats(out, "presence");
                    if (sharp != null && sharp.length > 0) r.put("sharpness", (double) sharp[0]);
                    if (presence != null && presence.length > 0) r.put("presence", (double) presence[0]);
                    r.put("prepMs", Math.round((t1 - t0) / 1e5) / 10.0);
                    r.put("runMs", Math.round((t2 - t1) / 1e5) / 10.0);
                }
                call.resolve(r);
            } catch (Throwable t) {
                Log.e(TAG, "detect failed", t);
                call.reject("detect failed: " + t.getMessage());
            }
        });
    }

    private static OrtSession create(byte[] bytes, String ep) throws OrtException {
        int threads = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors()));
        try (OrtSession.SessionOptions o = new OrtSession.SessionOptions()) {
            o.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            // Spinning threads keep cores hot between frames for a few percent of
            // latency; on a phone that is battery and heat for nothing.
            o.addConfigEntry("session.intra_op.allow_spinning", "0");
            switch (ep) {
                case "cpu":
                    o.setIntraOpNumThreads(threads);
                    break;
                case "xnnpack":
                    // XNNPACK brings its own pool; ORT's should not compete with it.
                    o.setIntraOpNumThreads(1);
                    Map<String, String> x = Collections.singletonMap("intra_op_num_threads", String.valueOf(threads));
                    o.addXnnpack(x);
                    break;
                default:
                    throw new IllegalArgumentException("unknown engine " + ep);
            }
            return env.createSession(bytes, o);
        }
    }

    // Mean of three runs after two warm-ups (kernel setup and allocation land on
    // the first ones), on a blank frame: speed does not depend on what is in it.
    private static double bench(OrtSession s) throws OrtException {
        for (int i = 0; i < PLANE * 3; i++) INPUT.put(i, 0f);
        double total = 0;
        for (int i = 0; i < 5; i++) {
            long t = SystemClock.elapsedRealtimeNanos();
            try (OnnxTensor x = OnnxTensor.createTensor(env, INPUT, SHAPE);
                 OrtSession.Result out = s.run(Collections.singletonMap("image", x))) {
                if (i >= 2) total += (SystemClock.elapsedRealtimeNanos() - t) / 1e6;
            }
        }
        return total / 3;
    }

    private static float[] floats(OrtSession.Result out, String name) throws OrtException {
        Optional<OnnxValue> v = out.get(name);
        if (!v.isPresent() || !(v.get() instanceof OnnxTensor)) return null;
        FloatBuffer fb = ((OnnxTensor) v.get()).getFloatBuffer();
        if (fb == null) return null;
        float[] a = new float[fb.remaining()];
        fb.get(a);
        return a;
    }

    private static void closeSession() {
        if (session != null) {
            try {
                session.close();
            } catch (Throwable t) {
                Log.w(TAG, "closing the old session: " + t);
            }
        }
        session = null;
        loadedTag = null;
        engine = null;
    }
}
