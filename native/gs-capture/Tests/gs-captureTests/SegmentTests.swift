// WHAT: tests for system-audio segments: the PCM hold (release after the hold, drop never
// delivers), roll decisions, and a real AAC round trip in which every segment decodes alone.
// WHY: the drop is the PR 3a leak guarantee carried into real audio, and "each segment
// decodes on its own" is spec R2. Neither needs a live tap to check.
import AVFoundation
import XCTest
@testable import gs_capture

final class PCMHoldTests: XCTestCase {
    func makeHold(holdMs: Double = 500) -> (PCMHold, () -> [PCMChunk], () -> Int) {
        var delivered: [PCMChunk] = []
        var drops = 0
        let hold = PCMHold(holdMs: holdMs, sampleRate: 1000, deliver: { delivered.append($0) }, onDrop: { drops += 1 })
        return (hold, { delivered }, { drops })
    }

    func ingest(_ hold: PCMHold, _ samples: [Float], channels: Int = 1, at t: Double) {
        samples.withUnsafeBufferPointer { hold.ingest(interleaved: $0, channels: channels, at: t) }
    }

    func testDownmixAveragesChannels() {
        let mono = [Float]([1, 0, 0.5, 0.5]).withUnsafeBufferPointer { PCMHold.downmix($0, channels: 2) }
        XCTAssertEqual(mono, [0.5, 0.5])
    }

    func testReleasesOnlyChunksOlderThanTheHold() {
        let (hold, delivered, _) = makeHold()
        ingest(hold, [0.1], at: 1000)
        ingest(hold, [0.2], at: 1400)
        hold.release(now: 1500)
        XCTAssertEqual(delivered().map(\.endMs), [1000])
        hold.release(now: 1900)
        XCTAssertEqual(delivered().map(\.endMs), [1000, 1400])
    }

    func testDropDiscardsEverythingHeldAndNeverDeliversIt() {
        let (hold, delivered, drops) = makeHold()
        ingest(hold, [Float](repeating: 0.5, count: 150), at: 1000)
        let dropped = hold.drop()
        hold.releaseAll()
        XCTAssertTrue(delivered().isEmpty)
        XCTAssertEqual(drops(), 1)
        // 150 frames at 1 kHz: two 100 ms windows (rounded up), at the loudness held.
        XCTAssertEqual(dropped.windows, 2)
        XCTAssertEqual(dropped.maxRms, 0.5, accuracy: 1e-6)
    }

    func testRateChangesAfterADrop() {
        let (hold, _, _) = makeHold()
        ingest(hold, [0.1], at: 1)
        _ = hold.drop()
        hold.setSampleRate(44_100)
        XCTAssertEqual(hold.rate, 44_100)
    }

    func testSampleCountSpansDrops() {
        let (hold, _, _) = makeHold()
        ingest(hold, [0, 0, 0], at: 1)
        _ = hold.drop()
        ingest(hold, [0, 0], at: 2)
        XCTAssertEqual(hold.sampleCount(), 5)
    }
}

final class SegmentRollTests: XCTestCase {
    func testRollsWhenFull() {
        XCTAssertFalse(SegmentWriter.shouldRoll(frames: 47_999, sampleRate: 48_000, segmentSec: 1, openDay: "d", chunkDay: "d"))
        XCTAssertTrue(SegmentWriter.shouldRoll(frames: 48_000, sampleRate: 48_000, segmentSec: 1, openDay: "d", chunkDay: "d"))
    }

    func testRollsAtTheDayBoundary() {
        XCTAssertTrue(SegmentWriter.shouldRoll(frames: 1, sampleRate: 48_000, segmentSec: 300,
                                               openDay: "2026-10-19", chunkDay: "2026-10-20"))
    }
}

final class SegmentWriterTests: XCTestCase {
    static let rate = 48_000.0
    var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("gs-segments-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    /// `seconds` of a 440 Hz tone in 10 ms chunks, the tap's usual size, ending at `startMs + seconds`.
    func feed(_ writer: SegmentWriter, seconds: Double, startMs: Double) {
        let chunk = Int(Self.rate / 100)
        for index in 0..<Int(seconds * 100) {
            let first = index * chunk
            let samples = (0..<chunk).map { Float(0.3 * sin(2 * .pi * 440 * Double(first + $0) / Self.rate)) }
            writer.append(PCMChunk(endMs: startMs + Double(index + 1) * 10, samples: samples))
        }
    }

    func testEverySegmentDecodesOnItsOwnAndSpansAreContiguous() throws {
        var segments: [[String: Any]] = []
        let writer = SegmentWriter(root: root.path, segmentSec: 2, sampleRate: Self.rate) { event, fields in
            XCTAssertEqual(event, "segment")
            segments.append(fields)
        }
        let start = Date().timeIntervalSince1970 * 1000
        feed(writer, seconds: 5, startMs: start)
        writer.close()

        XCTAssertEqual(segments.count, 3)
        for (index, segment) in segments.enumerated() {
            let path = try XCTUnwrap(segment["path"] as? String)
            XCTAssertEqual(segment["kind"] as? String, "system")
            XCTAssertTrue(path.hasPrefix("\(segment["day"] as! String)/sys-") && path.hasSuffix(".m4a"))
            // Decoded alone: a fresh reader, no other segment opened first.
            let file = try AVAudioFile(forReading: root.appendingPathComponent(path))
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
            try file.read(into: buffer)
            let samples = UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
            let rms = sqrt(samples.reduce(0.0) { $0 + Double($1 * $1) } / Double(samples.count))
            XCTAssertEqual(rms, 0.3 / 2.0.squareRoot(), accuracy: 0.03, "segment \(index) does not carry the tone")
            if index > 0 {
                XCTAssertEqual(segment["start"] as! Double, segments[index - 1]["end"] as! Double, accuracy: 1)
            }
        }
        // Full segments are 2 s; the last one carries the remaining 1 s.
        XCTAssertEqual((segments[0]["end"] as! Double) - (segments[0]["start"] as! Double), 2000, accuracy: 1)
        XCTAssertEqual((segments[2]["end"] as! Double) - (segments[2]["start"] as! Double), 1000, accuracy: 1)
        // Nothing partial is left behind.
        let day = segments[0]["day"] as! String
        let names = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(day).path)
        XCTAssertFalse(names.contains { $0.hasPrefix(".partial-") })
    }

    func testAPauseInDeliveryStartsANewSegment() throws {
        // Sleep/wake with no rebuild: delivery stops, then resumes an hour later. The resumed
        // audio must not be stamped as if it followed on (Codex review of PR 3b-2).
        var segments: [[String: Any]] = []
        let writer = SegmentWriter(root: root.path, segmentSec: 300, sampleRate: Self.rate) { _, fields in segments.append(fields) }
        let start = Date().timeIntervalSince1970 * 1000
        let hourMs = 3_600_000.0
        feed(writer, seconds: 1, startMs: start)
        feed(writer, seconds: 1, startMs: start + hourMs)
        writer.close()
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(segments[0]["end"] as! Double, start + 1000, accuracy: 1)
        XCTAssertEqual(segments[1]["start"] as! Double, start + hourMs, accuracy: 1)
    }

    func testContinuityTolerance() {
        XCTAssertTrue(SegmentWriter.continues(expectedStartMs: 1000, chunkStartMs: 1000 + SegmentWriter.gapToleranceMs))
        XCTAssertFalse(SegmentWriter.continues(expectedStartMs: 1000, chunkStartMs: 1001 + SegmentWriter.gapToleranceMs))
        // A clock that steps backwards breaks the timeline too.
        XCTAssertFalse(SegmentWriter.continues(expectedStartMs: 1000, chunkStartMs: 999 - SegmentWriter.gapToleranceMs))
    }

    func testRetunedWriterWritesAtTheNewRate() throws {
        var segments: [[String: Any]] = []
        let writer = SegmentWriter(root: root.path, segmentSec: 300, sampleRate: Self.rate) { _, fields in segments.append(fields) }
        writer.setSampleRate(44_100)
        let samples = [Float](repeating: 0.1, count: 44_100)
        writer.append(PCMChunk(endMs: Date().timeIntervalSince1970 * 1000, samples: samples))
        writer.close()
        let segment = try XCTUnwrap(segments.first)
        XCTAssertEqual((segment["end"] as! Double) - (segment["start"] as! Double), 1000, accuracy: 1)
        let file = try AVAudioFile(forReading: root.appendingPathComponent(segment["path"] as! String))
        XCTAssertEqual(file.fileFormat.sampleRate, 44_100)
    }

    func testCloseWithNothingOpenAnnouncesNothing() {
        let writer = SegmentWriter(root: root.path, segmentSec: 2, sampleRate: Self.rate) { _, _ in XCTFail("no segment expected") }
        writer.close()
    }
}
