import Foundation
import UIKit
import Capacitor
import OnnxRuntimeBindings

// The live scanner's corner model, run by native ONNX Runtime. The Android twin
// (android/.../NativeDetectorPlugin.java) explains the why; the protocol is the
// same on both:
//
//   status()                      -> { tag, engine }
//   load({ model, tag, ep })      -> { engine, loadMs, timings, errors }
//   detect({ image })             -> { corners[8], sharpness, presence, runMs, prepMs }
//
// Keep this the ONLY file with an @objc(...) plugin annotation: `cap sync` builds
// the iOS plugin class list from the first such match in each Swift file.
@objc(NativeDetectorPlugin)
public class NativeDetectorPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeDetectorPlugin"
    public let jsName = "NativeDetector"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detect", returnType: CAPPluginReturnPromise)
    ]

    private static let size = 384
    private static let plane = size * size
    private static let mean: [Float] = [0.485, 0.456, 0.406]
    private static let std: [Float] = [0.229, 0.224, 0.225]
    private static let shape: [NSNumber] = [1, 3, NSNumber(value: size), NSNumber(value: size)]

    // Shared across plugin instances and touched only on `queue`: the session
    // outlives a bridge reload, and ORT work stays off the plugin call queue.
    private static let queue = DispatchQueue(label: "com.bindarr.nativedetector", qos: .userInitiated)
    private static var env: ORTEnv?
    private static var session: ORTSession?
    private static var outputNames: Set<String> = []
    private static var loadedTag: String?
    private static var engine: String?
    private static let lut: [[Float]] = (0..<3).map { c in
        (0..<256).map { v in (Float(v) / 255 - NativeDetectorPlugin.mean[c]) / NativeDetectorPlugin.std[c] }
    }
    private static var rgbx = [UInt8](repeating: 0, count: plane * 4)

    @objc func status(_ call: CAPPluginCall) {
        Self.queue.async {
            var r: [String: Any] = [:]
            if let t = Self.loadedTag { r["tag"] = t }
            if let e = Self.engine { r["engine"] = e }
            call.resolve(r)
        }
    }

    @objc func load(_ call: CAPPluginCall) {
        guard let model = call.getString("model"), let bytes = Data(base64Encoded: model, options: .ignoreUnknownCharacters) else {
            call.reject("model is required")
            return
        }
        let tag = call.getString("tag")
        let ep = call.getString("ep") ?? "auto"
        Self.queue.async {
            let t0 = Date()
            do {
                if Self.env == nil { Self.env = try ORTEnv(loggingLevel: .warning) }
                Self.session = nil
                Self.loadedTag = nil
                Self.engine = nil
                // ORT's Objective-C API loads from a path, not bytes.
                let path = FileManager.default.temporaryDirectory.appendingPathComponent("bindarr-detector.onnx")
                try bytes.write(to: path, options: .atomic)

                // "auto" times each engine on this phone and keeps the fastest; see
                // the Android twin for why that is decided here and not guessed.
                let candidates = ep == "auto" ? ["cpu", "coreml"] : [ep]
                var timings: [String: Any] = [:]
                var errors: [String: Any] = [:]
                var best: (ORTSession, String, Double)?
                for cand in candidates {
                    do {
                        let s = try Self.create(path: path.path, ep: cand)
                        let ms = try Self.bench(s)
                        timings[cand] = (ms * 10).rounded() / 10
                        if best == nil || ms < best!.2 { best = (s, cand, ms) }
                    } catch {
                        errors[cand] = error.localizedDescription
                        CAPLog.print("[NativeDetector] \(cand) unavailable: \(error.localizedDescription)")
                    }
                }
                guard let winner = best else {
                    call.reject("no engine could load the model: \(errors)")
                    return
                }
                let (s, bestEp, _) = winner
                Self.session = s
                Self.outputNames = Set(try s.outputNames())
                Self.loadedTag = tag
                Self.engine = "native-\(bestEp)"
                CAPLog.print("[NativeDetector] \(Self.engine!) ready, timings \(timings)")
                call.resolve([
                    "engine": Self.engine!,
                    "loadMs": Int(Date().timeIntervalSince(t0) * 1000),
                    "timings": timings,
                    "errors": errors
                ])
            } catch {
                call.reject("load failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func detect(_ call: CAPPluginCall) {
        guard let image = call.getString("image") else {
            call.reject("image is required")
            return
        }
        Self.queue.async {
            guard let session = Self.session else {
                call.reject("not loaded")
                return
            }
            do {
                let t0 = CFAbsoluteTimeGetCurrent()
                guard let data = Data(base64Encoded: image, options: .ignoreUnknownCharacters),
                      let cg = UIImage(data: data)?.cgImage else {
                    call.reject("image did not decode")
                    return
                }
                let input = try Self.tensor(from: cg)
                let t1 = CFAbsoluteTimeGetCurrent()
                let wanted = Self.outputNames.intersection(["corners", "sharpness", "presence"])
                let out = try session.run(withInputs: ["image": input], outputNames: wanted, runOptions: nil)
                let t2 = CFAbsoluteTimeGetCurrent()
                guard let cornerValue = out["corners"] else {
                    call.reject("model has no corners output")
                    return
                }
                let corners = try Self.floats(cornerValue)
                guard corners.count >= 8 else {
                    call.reject("model has no corners output")
                    return
                }
                var r: [String: Any] = [
                    "corners": corners.prefix(8).map { Double($0) },
                    "prepMs": ((t1 - t0) * 10000).rounded() / 10,
                    "runMs": ((t2 - t1) * 10000).rounded() / 10
                ]
                if let v = out["sharpness"], let f = try Self.floats(v).first { r["sharpness"] = Double(f) }
                if let v = out["presence"], let f = try Self.floats(v).first { r["presence"] = Double(f) }
                call.resolve(r)
            } catch {
                call.reject("detect failed: \(error.localizedDescription)")
            }
        }
    }

    private static func create(path: String, ep: String) throws -> ORTSession {
        guard let env = env else { throw NSError(domain: "NativeDetector", code: 1, userInfo: [NSLocalizedDescriptionKey: "no ORT environment"]) }
        let threads = max(1, min(4, ProcessInfo.processInfo.activeProcessorCount))
        let opts = try ORTSessionOptions()
        try opts.setGraphOptimizationLevel(.all)
        try opts.addConfigEntry(withKey: "session.intra_op.allow_spinning", value: "0")
        switch ep {
        case "cpu":
            try opts.setIntraOpNumThreads(Int32(threads))
        case "coreml":
            guard ORTIsCoreMLExecutionProviderAvailable() else {
                throw NSError(domain: "NativeDetector", code: 2, userInfo: [NSLocalizedDescriptionKey: "CoreML EP not in this ORT build"])
            }
            // Whatever CoreML cannot take falls back to the CPU EP, so give that
            // part the cores too.
            try opts.setIntraOpNumThreads(Int32(threads))
            let coreml = ORTCoreMLExecutionProviderOptions()
            coreml.createMLProgram = true
            try opts.appendCoreMLExecutionProvider(with: coreml)
        default:
            throw NSError(domain: "NativeDetector", code: 3, userInfo: [NSLocalizedDescriptionKey: "unknown engine \(ep)"])
        }
        return try ORTSession(env: env, modelPath: path, sessionOptions: opts)
    }

    // Mean of three runs after two warm-ups, on a blank frame.
    private static func bench(_ s: ORTSession) throws -> Double {
        let blank = NSMutableData(length: 3 * plane * MemoryLayout<Float>.size)!
        let x = try ORTValue(tensorData: blank, elementType: .float, shape: shape)
        let names = Set(try s.outputNames())
        var total = 0.0
        for i in 0..<5 {
            let t = CFAbsoluteTimeGetCurrent()
            _ = try s.run(withInputs: ["image": x], outputNames: names, runOptions: nil)
            if i >= 2 { total += (CFAbsoluteTimeGetCurrent() - t) * 1000 }
        }
        return total / 3
    }

    // Draw into a 384x384 RGBX buffer (squashing, the same `fit: fill` as the
    // other paths), then normalise into a CHW float tensor.
    private static func tensor(from cg: CGImage) throws -> ORTValue {
        let ok: Bool = rgbx.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: size, height: size, bitsPerComponent: 8,
                                      bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: size, height: size))
            return true
        }
        guard ok else { throw NSError(domain: "NativeDetector", code: 4, userInfo: [NSLocalizedDescriptionKey: "no bitmap context"]) }
        let data = NSMutableData(length: 3 * plane * MemoryLayout<Float>.size)!
        let f = data.mutableBytes.assumingMemoryBound(to: Float.self)
        let l0 = lut[0], l1 = lut[1], l2 = lut[2]
        rgbx.withUnsafeBufferPointer { p in
            for i in 0..<plane {
                let j = i * 4
                f[i] = l0[Int(p[j])]
                f[plane + i] = l1[Int(p[j + 1])]
                f[2 * plane + i] = l2[Int(p[j + 2])]
            }
        }
        return try ORTValue(tensorData: data, elementType: .float, shape: shape)
    }

    private static func floats(_ v: ORTValue) throws -> [Float] {
        let d = try v.tensorData() as Data
        return d.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }
}
