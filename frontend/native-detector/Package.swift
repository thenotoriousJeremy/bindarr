// swift-tools-version: 5.9

import PackageDescription

// The package and product name must be "BindarrNativeDetector": the Capacitor CLI
// derives it from the npm name (bindarr-native-detector) when it writes
// ios/App/CapApp-SPM/Package.swift, and a mismatch fails the iOS build there.
//
// ONNX Runtime: Microsoft's onnxruntime-swift-package-manager repository, and
// download.onnxruntime.ai where its binaries lived, were removed in November
// 2026. The framework is now Microsoft's own onnxruntime.xcframework.zip, taken
// unmodified from the NuGet package Microsoft.ML.OnnxRuntime 1.24.2
// (runtimes/ios/native/; the .nupkg matched nuget.org's SHA-512) and hosted on
// this repository's onnxruntime-ios-1.24.2 release. BindarrOrt is our own shim
// over its C API, in place of the Objective-C wrapper that package carried.
// To move to another version: take the same file from that version's NuGet
// package, publish it on a new release, and update the URL and checksum
// (`swift package compute-checksum`, the zip's SHA-256).
let package = Package(
    name: "BindarrNativeDetector",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "BindarrNativeDetector",
            targets: ["NativeDetectorPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .binaryTarget(
            name: "onnxruntime",
            url: "https://github.com/thenotoriousJeremy/bindarr/releases/download/onnxruntime-ios-1.24.2/onnxruntime.xcframework.zip",
            checksum: "a161fe8628ed3bf8d97915bd34063fe115f58a1b9b0f4f0baec78c62487ac3ee"),
        .target(
            name: "BindarrOrt",
            dependencies: ["onnxruntime"],
            path: "ios/Sources/BindarrOrt",
            // The framework is a static library built from C++ that uses CoreML.
            linkerSettings: [
                .linkedLibrary("c++"),
                .linkedFramework("CoreML"),
                .linkedFramework("Foundation")
            ]),
        .target(
            name: "NativeDetectorPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "BindarrOrt"
            ],
            path: "ios/Sources/NativeDetectorPlugin")
    ]
)
