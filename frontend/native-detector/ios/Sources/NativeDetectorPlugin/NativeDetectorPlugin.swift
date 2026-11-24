import Foundation
import UIKit
import Capacitor
import BindarrOrt

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
    private static let shape: [Int64] = [1, 3, Int64(size), Int64(size)]

    // Shared across plugin instances and touched only on `queue`: the session
    // outlives a bridge reload, and ORT work stays off the plugin call queue.
    // A BindarrOrtSession (BindarrOrt.h, over ORT's C API) is not reference
    // counted: every one made is released with bindarr_ort_release.
    private static let queue = DispatchQueue(label: "com.bindarr.nativedetector", qos: .userInitiated)
    private static var session: OpaquePointer?
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
                if let old = Self.session { bindarr_ort_release(old) }
                Self.session = nil
                Self.loadedTag = nil
                Self.engine = nil

                // "auto" times each engine on this phone and keeps the fastest; see
                // the Android twin for why that is decided here and not guessed.
                let candidates = ep == "auto" ? ["cpu", "coreml"] : [ep]
                var timings: [String: Any] = [:]
                var errors: [String: Any] = [:]
                var best: (OpaquePointer, String, Double)?
                for cand in candidates {
                    var made: OpaquePointer?
                    do {
                        let s = try Self.create(model: bytes, ep: cand)
                        made = s
                        let ms = try Self.bench(s)
                        timings[cand] = (ms * 10).rounded() / 10
                        if best == nil || ms < best!.2 {
                            if let loser = best?.0 { bindarr_ort_release(loser) }
                            best = (s, cand, ms)
                        } else {
                            bindarr_ort_release(s)
                        }
                    } catch {
                        if let s = made { bindarr_ort_release(s) }
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
                Self.outputNames = Set(Self.sessionOutputNames(of: s))
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
                let out = try Self.run(session, input, outputs: Array(wanted))
                let t2 = CFAbsoluteTimeGetCurrent()
                guard let corners = out["corners"], corners.count >= 8 else {
                    call.reject("model has no corners output")
                    return
                }
                var r: [String: Any] = [
                    "corners": corners.prefix(8).map { Double($0) },
                    "prepMs": ((t1 - t0) * 10000).rounded() / 10,
                    "runMs": ((t2 - t1) * 10000).rounded() / 10
                ]
                if let f = out["sharpness"]?.first { r["sharpness"] = Double(f) }
                if let f = out["presence"]?.first { r["presence"] = Double(f) }
                call.resolve(r)
            } catch {
                call.reject("detect failed: \(error.localizedDescription)")
            }
        }
    }

    private static func failure(_ code: Int, _ message: String) -> NSError {
        NSError(domain: "NativeDetector", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private static func message(_ err: [CChar]) -> String {
        err.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
    }

    // Graph optimisations on, no spinning threads, up to four intra-op threads.
    // CoreML is added as an MLProgram; whatever it cannot take falls back to the
    // CPU EP, which gets the same cores.
    private static func create(model: Data, ep: String) throws -> OpaquePointer {
        let threads = Int32(max(1, min(4, ProcessInfo.processInfo.activeProcessorCount)))
        let useCoreML: Int32
        switch ep {
        case "cpu":
            useCoreML = 0
        case "coreml":
            guard bindarr_ort_coreml_available() != 0 else { throw failure(2, "CoreML EP not in this ORT build") }
            useCoreML = 1
        default:
            throw failure(3, "unknown engine \(ep)")
        }
        var err = [CChar](repeating: 0, count: 512)
        let errCount = err.count
        let made = model.withUnsafeBytes { bytes in
            bindarr_ort_create(bytes.baseAddress, bytes.count, useCoreML, threads, &err, errCount)
        }
        guard let session = made else { throw failure(1, message(err)) }
        return session
    }

    private static func sessionOutputNames(of s: OpaquePointer) -> [String] {
        (0..<bindarr_ort_output_count(s)).compactMap { i in
            bindarr_ort_output_name(s, i).map { String(cString: $0) }
        }
    }

    // One run with the frame as input "image"; each requested output as floats.
    private static func run(_ s: OpaquePointer, _ input: [Float], outputs: [String]) throws -> [String: [Float]] {
        var err = [CChar](repeating: 0, count: 512)
        let errCount = err.count
        var data = [UnsafeMutablePointer<Float>?](repeating: nil, count: outputs.count)
        var lens = [Int](repeating: 0, count: outputs.count)
        let cNames = outputs.map { strdup($0) }
        defer { cNames.forEach { free($0) } }
        let names: [UnsafePointer<CChar>?] = cNames.map { $0.map { UnsafePointer($0) } }
        let rc = input.withUnsafeBufferPointer { inBuf in
            shape.withUnsafeBufferPointer { dims in
                names.withUnsafeBufferPointer { n in
                    bindarr_ort_run(s, "image", inBuf.baseAddress, dims.baseAddress, dims.count,
                                    n.baseAddress, n.count, &data, &lens, &err, errCount)
                }
            }
        }
        defer { data.forEach { bindarr_ort_free($0) } }
        guard rc == 0 else { throw failure(5, message(err)) }
        var out: [String: [Float]] = [:]
        for (i, name) in outputs.enumerated() {
            if let p = data[i] { out[name] = Array(UnsafeBufferPointer(start: p, count: lens[i])) }
        }
        return out
    }

    // Mean of three runs after two warm-ups, on a blank frame.
    private static func bench(_ s: OpaquePointer) throws -> Double {
        let blank = [Float](repeating: 0, count: 3 * plane)
        let names = sessionOutputNames(of: s)
        var total = 0.0
        for i in 0..<5 {
            let t = CFAbsoluteTimeGetCurrent()
            _ = try run(s, blank, outputs: names)
            if i >= 2 { total += (CFAbsoluteTimeGetCurrent() - t) * 1000 }
        }
        return total / 3
    }

    // Draw into a 384x384 RGBX buffer (squashing, the same `fit: fill` as the
    // other paths), then normalise into a CHW float tensor.
    private static func tensor(from cg: CGImage) throws -> [Float] {
        let ok: Bool = rgbx.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: size, height: size, bitsPerComponent: 8,
                                      bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: size, height: size))
            return true
        }
        guard ok else { throw failure(4, "no bitmap context") }
        var data = [Float](repeating: 0, count: 3 * plane)
        let l0 = lut[0], l1 = lut[1], l2 = lut[2]
        data.withUnsafeMutableBufferPointer { f in
            rgbx.withUnsafeBufferPointer { p in
                for i in 0..<plane {
                    let j = i * 4
                    f[i] = l0[Int(p[j])]
                    f[plane + i] = l1[Int(p[j + 1])]
                    f[2 * plane + i] = l2[Int(p[j + 2])]
                }
            }
        }
        return data
    }
}
