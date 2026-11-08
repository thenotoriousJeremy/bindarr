// swift-tools-version: 5.9

import PackageDescription

// The package and product name must be "BindarrNativeDetector": the Capacitor CLI
// derives it from the npm name (bindarr-native-detector) when it writes
// ios/App/CapApp-SPM/Package.swift, and a mismatch fails the iOS build there.
let package = Package(
    name: "BindarrNativeDetector",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "BindarrNativeDetector",
            targets: ["NativeDetectorPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager.git", from: "1.24.2")
    ],
    targets: [
        .target(
            name: "NativeDetectorPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager")
            ],
            path: "ios/Sources/NativeDetectorPlugin")
    ]
)
