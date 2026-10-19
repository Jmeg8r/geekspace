// swift-tools-version:5.10
// WHAT: gs-capture, the Day Recorder's native helper (ScreenCaptureKit, CoreAudio, Vision).
// WHY: Electron's desktopCapturer cannot leave a denylisted app out of a frame or out of
// system audio; ScreenCaptureKit can, before the frame exists (spec F1). This is the PR 1
// spike form: subcommands that answer the plan's questions, not the production protocol.
// Swift 5 language mode on purpose: the spike is single-threaded glue around callback APIs,
// and Swift 6 strict concurrency would add ceremony without catching anything here.
import PackageDescription

let package = Package(
    name: "gs-capture",
    // 14.2: CoreAudio process taps (Tap.swift) and process objects (ProcWatch.swift).
    platforms: [.macOS("14.2")],
    targets: [
        .executableTarget(name: "gs-capture", path: "Sources/gs-capture"),
        // A stand-in "denylisted app" with its own bundle ID, so the spike controls exactly
        // which app plays audio or holds the mic. The driver wraps it in an .app bundle.
        .executableTarget(name: "spike-tone", path: "Sources/spike-tone"),
        // Pure decision logic (menu-bar masking, OCR merge). Native code is not built on CI
        // (ubuntu), so `swift test` runs locally as part of each native PR's proof.
        .testTarget(name: "gs-captureTests", dependencies: ["gs-capture"], path: "Tests/gs-captureTests"),
    ]
)
