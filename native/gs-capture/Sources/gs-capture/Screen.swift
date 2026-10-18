// WHAT: ScreenCaptureKit screenshots with a denylist filter, window listing, and the
// SHOT_SEC measurement loop (HEIC encode + perceptual-hash skipping + optional OCR).
// WHY: spike questions 1, 5 and 6. The filter is rebuilt from fresh SCShareableContent for
// every frame, because SCContentFilter holds SCRunningApplication instances: an app that
// launches after the filter was built would not be in it.
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Screen {
    /// onScreenWindowsOnly must stay false: with true, an app that has no on-screen window
    /// (a menu-bar app, a call app minimised to the Dock, a background audio player) is
    /// missing from `applications`, so the denylist silently fails to exclude its audio.
    /// Measured in the spike (spike-findings.md, Q2): -15 dBFS of tone leaked through.
    static func content() async -> SCShareableContent {
        do {
            return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            fail("SCShareableContent failed (Screen Recording permission?): \(error.localizedDescription)")
        }
    }

    /// keepOnly, when given, also excludes every app NOT in it. The spike uses that only to
    /// keep real windows out of evidence images; the denylist path is `excluding` alone.
    static func filter(_ content: SCShareableContent, excluding bundleIDs: [String], keepOnly: [String] = []) -> (SCContentFilter, SCDisplay, Int) {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            fail("no display in SCShareableContent")
        }
        let excluded = content.applications.filter {
            bundleIDs.contains($0.bundleIdentifier) || (!keepOnly.isEmpty && !keepOnly.contains($0.bundleIdentifier))
        }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
        return (filter, display, excluded.count)
    }

    static func configuration(_ display: SCDisplay, scale: Double) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.width = Int(Double(display.width) * scale)
        config.height = Int(Double(display.height) * scale)
        config.showsCursor = false
        return config
    }

    static func capture(excluding bundleIDs: [String], keepOnly: [String] = [], scale: Double) async -> (CGImage, Int, Double) {
        let (filter, display, excludedCount) = filter(await content(), excluding: bundleIDs, keepOnly: keepOnly)
        let started = nowMs()
        let config = configuration(display, scale: scale)
        do {
            let image = try await withTimeout(seconds: captureTimeoutSec, what: "captureImage") {
                try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            }
            return (image, excludedCount, nowMs() - started)
        } catch {
            fail("captureImage failed: \(error.localizedDescription)")
        }
    }

    /// Measured in the spike: once replayd wedged, captureImage never returned and never
    /// threw, so a recorder without this would sit "recording" forever with nothing saved.
    static let captureTimeoutSec = 10.0

    /// Window geometry only. Titles are deliberately not emitted: they can carry private text.
    static func listWindows(_ args: Args) async {
        let wanted = args.list("bundle")
        // Matched here so the caller can pick out its own synthetic window without any
        // title ever reaching stdout.
        let titleContains = args.string("title-contains")
        let allLayers = args.string("layers") == "all"
        for window in await content().windows where window.isOnScreen && (allLayers || window.windowLayer == 0) {
            let bundle = window.owningApplication?.bundleIdentifier ?? ""
            if !wanted.isEmpty && !wanted.contains(bundle) { continue }
            if let needle = titleContains, !(window.title ?? "").contains(needle) { continue }
            emit(["bundle": bundle, "pid": window.owningApplication?.processID ?? -1, "windowID": window.windowID,
                  "layer": window.windowLayer, "x": window.frame.origin.x, "y": window.frame.origin.y,
                  "w": window.frame.width, "h": window.frame.height])
        }
    }

    /// Every app SCShareableContent offers as an exclusion target.
    static func listApps(_ args: Args) async {
        for app in await content().applications {
            emit(["bundle": app.bundleIdentifier, "pid": app.processID])
        }
    }

    static func shot(_ args: Args) async {
        let out = args.required("out")
        let scale = args.double("scale", default: 1)
        var (image, excludedCount, captureMs) = await capture(excluding: args.list("exclude"), keepOnly: args.list("keep-only"), scale: scale)
        if let rect = args.string("crop") {
            image = crop(image, pointsRect: rect, scale: scale)
        }
        let bytes = write(image, to: out, heic: out.hasSuffix(".heic"), quality: args.double("quality", default: 0.6))
        emit(["out": out, "captureMs": round3(captureMs), "width": image.width, "height": image.height,
              "bytes": bytes, "excludedApps": excludedCount])
    }

    /// One frame every --interval seconds for --duration seconds. Every frame is encoded so
    /// the driver can replay the same timeline at 2x and 4x the interval; only frames that
    /// survive skipping at this interval are written to --dir.
    static func shots(_ args: Args) async {
        let dir = args.required("dir")
        let interval = args.double("interval", default: 15)
        let duration = args.double("duration", default: 3600)
        let scale = args.double("scale", default: 1)
        let quality = args.double("quality", default: 0.6)
        let grid = Int(args.double("grid", default: 32))
        let threshold = Int(args.double("hamming", default: 8))
        let runOCR = args.string("ocr") == "1"
        let exclude = args.list("exclude")
        do {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        } catch {
            fail("cannot create \(dir): \(error.localizedDescription)")
        }
        let start = nowMs()
        var lastKept: [Bool]?
        var index = 0
        while nowMs() - start < duration * 1000 {
            let tickStart = nowMs()
            let cpuBefore = cpuSeconds()
            let (image, _, captureMs) = await capture(excluding: exclude, scale: scale)
            let hash = dHash(image, grid: grid)
            let encodeStart = nowMs()
            let data = encode(image, heic: true, quality: quality)
            let encodeMs = nowMs() - encodeStart
            let skipped = lastKept.map { hamming($0, hash) <= threshold } ?? false
            var ocrMs = 0.0
            var ocrChars = 0
            if !skipped {
                lastKept = hash
                let path = "\(dir)/frame-\(String(format: "%05d", index)).heic"
                FileManager.default.createFile(atPath: path, contents: data)
                if runOCR {
                    let result = OCR.recognize(image, fast: false)
                    ocrMs = result.ms
                    ocrChars = result.text.count
                }
            }
            emit(["i": index, "t": round3((tickStart - start) / 1000), "captureMs": round3(captureMs),
                  "encodeMs": round3(encodeMs), "bytes": data.count, "hash": hex(hash),
                  "skipped": skipped, "ocrMs": round3(ocrMs), "ocrChars": ocrChars,
                  "cpuSec": round3(cpuSeconds() - cpuBefore)])
            index += 1
            let wait = interval * 1000 - (nowMs() - tickStart)
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000)) }
        }
        emit(["done": true, "frames": index, "totalCpuSec": round3(cpuSeconds())])
    }

    static func crop(_ image: CGImage, pointsRect: String, scale: Double) -> CGImage {
        let parts = pointsRect.split(separator: ",").compactMap { Double($0) }
        guard parts.count == 4 else { fail("--crop wants x,y,w,h in points, got \(pointsRect)") }
        let rect = CGRect(x: parts[0] * scale, y: parts[1] * scale, width: parts[2] * scale, height: parts[3] * scale)
        guard let cropped = image.cropping(to: rect) else { fail("crop \(pointsRect) is outside the frame") }
        return cropped
    }

    static func encode(_ image: CGImage, heic: Bool, quality: Double) -> Data {
        let data = NSMutableData()
        let type = (heic ? UTType.heic : UTType.png).identifier as CFString
        guard let destination = CGImageDestinationCreateWithData(data, type, 1, nil) else {
            fail("no image encoder for \(type)")
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { fail("image encode failed (\(type))") }
        return data as Data
    }

    @discardableResult
    static func write(_ image: CGImage, to path: String, heic: Bool, quality: Double) -> Int {
        let data = encode(image, heic: heic, quality: quality)
        guard FileManager.default.createFile(atPath: path, contents: data) else { fail("cannot write \(path)") }
        return data.count
    }

    /// Difference hash on a (grid+1) x grid greyscale thumbnail: one bit per horizontal
    /// neighbour comparison. grid 8 is the classic 64-bit dHash; a screen of text needs a
    /// finer grid, or a changed paragraph hashes the same and its OCR text is lost.
    static func dHash(_ image: CGImage, grid: Int) -> [Bool] {
        let width = grid + 1, height = grid
        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
            fail("cannot create hash context")
        }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var bits: [Bool] = []
        for row in 0..<height {
            for col in 0..<(width - 1) {
                bits.append(pixels[row * width + col] > pixels[row * width + col + 1])
            }
        }
        return bits
    }

    static func hex(_ bits: [Bool]) -> String {
        stride(from: 0, to: bits.count, by: 4).map { start in
            let nibble = bits[start..<min(start + 4, bits.count)].reduce(0) { ($0 << 1) | ($1 ? 1 : 0) }
            return String(nibble, radix: 16)
        }.joined()
    }

    static func hamming(_ a: [Bool], _ b: [Bool]) -> Int { zip(a, b).filter { $0 != $1 }.count }
}
