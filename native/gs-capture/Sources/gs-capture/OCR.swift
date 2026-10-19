// WHAT: local Vision OCR, and the renderer for the synthetic OCR fixtures.
// WHY: spike question 5 (spec R6). Fixtures are rendered from a JSON description at run time
// instead of committing screenshots: the repo is public, and a rendered image of known text
// gives exact ground truth to score against.
import AppKit
import Foundation
import Vision

enum OCR {
    struct Result { let text: String; let lines: [String]; let ms: Double }

    static func recognize(_ image: CGImage, fast: Bool) -> Result {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = fast ? .fast : .accurate
        request.usesLanguageCorrection = !fast
        let started = nowMs()
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
        } catch {
            fail("Vision OCR failed: \(error.localizedDescription)")
        }
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        return Result(text: lines.joined(separator: "\n"), lines: lines, ms: nowMs() - started)
    }

    // Spike Q5: accurate OCR read nothing of mid-grey text on light grey (#8a8a8a on #ececec),
    // and binarising at this luminance recovered all of it.
    static let thresholdLuminance: UInt8 = 190

    /// Greyscale copy with every pixel above `thresholdLuminance` white and the rest black.
    static func thresholded(_ image: CGImage) -> CGImage {
        let width = image.width, height = image.height
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue),
              let data = context.data else {
            fail("cannot create threshold context \(width)x\(height)")
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let pixels = data.bindMemory(to: UInt8.self, capacity: width * height)
        for i in 0..<(width * height) { pixels[i] = pixels[i] > thresholdLuminance ? 255 : 0 }
        guard let result = context.makeImage() else { fail("cannot read back threshold image") }
        return result
    }

    /// Accurate OCR of the frame AND of a thresholded copy, lines unioned in reading order.
    /// WHY both passes every time instead of "retry when few lines" (the spike's suggestion):
    /// measured on the fixtures, pooled word recall rises from 0.826 to 0.979 for about twice
    /// the OCR time (229 vs 107 ms a kept frame), and there is no few-lines threshold to tune.
    /// Both #ececec-background fixtures read nothing at all in the plain pass (plan.md, PR 3b-1).
    static func recognizeMerged(_ image: CGImage) -> Result {
        let started = nowMs()
        let plain = recognize(image, fast: false)
        let binary = recognize(thresholded(image), fast: false)
        var seen = Set<String>()
        let lines = (plain.lines + binary.lines).filter { seen.insert($0).inserted }
        return Result(text: lines.joined(separator: "\n"), lines: lines, ms: nowMs() - started)
    }

    /// Mean luminance 0–255, so a proof can assert a band is black rather than just unread.
    static func meanLuma(_ image: CGImage) -> Double {
        let width = image.width, height = image.height
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue),
              let data = context.data else { fail("cannot create luma context") }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let pixels = data.bindMemory(to: UInt8.self, capacity: width * height)
        var sum = 0
        for i in 0..<(width * height) { sum += Int(pixels[i]) }
        return Double(sum) / Double(max(width * height, 1))
    }

    static func load(_ path: String) -> CGImage {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            fail("cannot read image \(path)")
        }
        return image
    }

    /// gs-capture ocr [--level fast|accurate|merged] [--text 1] [--crop x,y,w,h] <image>...
    /// Text is printed only when asked: real screenshots must never put OCR text in a log.
    static func run(_ args: Args) {
        let level = args.string("level") ?? "accurate"
        guard ["fast", "accurate", "merged"].contains(level) else { fail("--level must be fast, accurate or merged, got \(level)") }
        let withText = args.string("text") == "1"
        guard !args.positional.isEmpty else { fail("ocr needs at least one image path") }
        for path in args.positional {
            var image = load(path)
            // --crop x,y,w,h in pixels (top-left origin), as Screen.crop takes it at scale 1.
            if let rect = args.string("crop") { image = Screen.crop(image, pointsRect: rect, scale: 1) }
            let result = level == "merged" ? recognizeMerged(image) : recognize(image, fast: level == "fast")
            var line: [String: Any] = ["file": path, "ms": round3(result.ms), "lines": result.lines.count, "chars": result.text.count,
                                       "meanLuma": round3(meanLuma(image)), "width": image.width, "height": image.height]
            if withText { line["text"] = result.lines }
            emit(line)
        }
    }

    // MARK: fixtures

    struct FixtureLine: Decodable { let text: String; let x: Double; let y: Double; let size: Double; let mono: Bool?; let color: String? }
    struct Fixture: Decodable { let name: String; let background: String; let lines: [FixtureLine] }
    struct FixtureFile: Decodable { let header: String; let width: Int; let height: Int; let fixtures: [Fixture] }

    static func color(_ hex: String) -> NSColor {
        let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
        return NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                       blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }

    /// gs-capture render-fixtures --spec <json> --dir <out> [--scale 2]
    /// --scale renders the same layout at Retina pixel density, to compare OCR at the
    /// point-resolution capture size against full pixel resolution.
    static func renderFixtures(_ args: Args) {
        let specPath = args.required("spec")
        let dir = args.required("dir")
        let scale = args.double("scale", default: 1)
        let file: FixtureFile
        do {
            file = try JSONDecoder().decode(FixtureFile.self, from: Data(contentsOf: URL(fileURLWithPath: specPath)))
        } catch {
            fail("cannot parse \(specPath): \(error)")
        }
        guard file.header.hasPrefix("SYNTHETIC") else { fail("\(specPath) is not headed SYNTHETIC; refusing to render") }
        do {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        } catch {
            fail("cannot create \(dir): \(error.localizedDescription)")
        }
        for fixture in file.fixtures {
            guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(Double(file.width) * scale),
                                             pixelsHigh: Int(Double(file.height) * scale),
                                             bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                             colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
                  let context = NSGraphicsContext(bitmapImageRep: rep) else {
                fail("cannot allocate a \(file.width)x\(file.height) canvas")
            }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            context.cgContext.scaleBy(x: scale, y: scale)
            color(fixture.background).setFill()
            NSRect(x: 0, y: 0, width: file.width, height: file.height).fill()
            for line in fixture.lines {
                let font = line.mono == true
                    ? NSFont.monospacedSystemFont(ofSize: line.size, weight: .regular)
                    : NSFont.systemFont(ofSize: line.size)
                let text = NSAttributedString(string: line.text, attributes: [
                    .font: font, .foregroundColor: color(line.color ?? "#1d1d1f"),
                ])
                // Fixture y is measured from the top, like a screen; AppKit draws from the bottom.
                text.draw(at: NSPoint(x: line.x, y: Double(file.height) - line.y - line.size * 1.2))
            }
            NSGraphicsContext.restoreGraphicsState()
            guard let image = rep.cgImage else { fail("render of \(fixture.name) produced no image") }
            let path = "\(dir)/\(fixture.name).png"
            let bytes = Screen.write(image, to: path, heic: false, quality: 1)
            emit(["fixture": fixture.name, "out": path, "bytes": bytes, "lines": fixture.lines.count])
        }
    }
}
