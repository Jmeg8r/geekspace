// WHAT: tests for the call hold (plan PR 4a): call audio kept in memory, never on disk, until
// the supervisor says the notice was given, then written as `call-` segments that decode alone.
// WHY: spec R5 / F3. No call audio reaches disk without a logged notice, and a declined or
// timed-out call leaves nothing behind.
import AVFoundation
import XCTest
@testable import gs_capture

final class CallHoldTests: XCTestCase {
    /// `count` samples at `rate`, ending at `endMs`.
    func chunk(_ count: Int, value: Float = 0.25, endMs: Double) -> PCMChunk {
        PCMChunk(endMs: endMs, samples: [Float](repeating: value, count: count))
    }

    func testResamplesToSixteenKilohertz() {
        let hold = CallHold(maxSec: 60)
        hold.store(chunk(4_800, endMs: 1_100), sourceRate: 48_000)
        XCTAssertEqual(hold.runs.count, 1)
        XCTAssertEqual(hold.runs[0].samples.count, 1_600)
        XCTAssertEqual(hold.runs[0].startMs, 1_000, accuracy: 0.001)
        XCTAssertEqual(hold.heldSec, 0.1, accuracy: 0.0001)
    }

    func testKeepsTheCountExactAcrossChunksAtAnOddRate() {
        let hold = CallHold(maxSec: 60)
        // 441 frames at 44.1 kHz is 10 ms; 100 of them is one second.
        for i in 1...100 { hold.store(chunk(441, endMs: Double(i) * 10), sourceRate: 44_100) }
        XCTAssertEqual(hold.runs.count, 1)
        XCTAssertEqual(hold.runs[0].samples.count, 16_000)
    }

    func testStoresSamplesAsSixteenBitClamped() {
        let hold = CallHold(maxSec: 60)
        hold.store(PCMChunk(endMs: 1, samples: [0.5, 2, -2]), sourceRate: 16_000)
        XCTAssertEqual(hold.runs[0].samples, [16_384, 32_767, -32_767])
    }

    func testAGapStartsANewRun() {
        let hold = CallHold(maxSec: 60)
        hold.store(chunk(1_600, endMs: 1_100), sourceRate: 16_000)
        hold.store(chunk(1_600, endMs: 1_200), sourceRate: 16_000)
        // Sleep and wake: the next chunk starts 5 s after the last one ended.
        hold.store(chunk(1_600, endMs: 6_300), sourceRate: 16_000)
        XCTAssertEqual(hold.runs.map(\.samples.count), [3_200, 1_600])
        XCTAssertEqual(hold.runs[1].startMs, 6_200, accuracy: 0.001)
    }

    func testStopsAtTheCapAndSaysSo() {
        let hold = CallHold(maxSec: 1)
        for i in 1...20 { hold.store(chunk(1_600, endMs: Double(i) * 100), sourceRate: 16_000) }
        XCTAssertEqual(hold.heldSec, 1, accuracy: 0.0001)
        XCTAssertTrue(hold.overflowed)
    }

    func testTakeEmptiesTheHold() {
        let hold = CallHold(maxSec: 60)
        hold.store(chunk(1_600, endMs: 100), sourceRate: 16_000)
        XCTAssertEqual(hold.take().count, 1)
        XCTAssertTrue(hold.runs.isEmpty)
        XCTAssertEqual(hold.heldSec, 0)
        XCTAssertFalse(hold.overflowed)
    }
}

final class CallSegmentTests: XCTestCase {
    var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("gs-call-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    func testFlushWritesCallSegmentsThatDecodeAlone() throws {
        var reports: [[String: Any]] = []
        let hold = CallHold(maxSec: 60)
        // 3 s of tone at 16 kHz, in 10 ms chunks, from a fixed start.
        let start = 1_793_510_400_000.0
        for i in 1...300 {
            let samples = (0..<160).map { n in Float(sin(2 * Double.pi * 440 * Double((i - 1) * 160 + n) / 16_000)) * 0.3 }
            hold.store(PCMChunk(endMs: start + Double(i) * 10, samples: samples), sourceRate: 16_000)
        }
        let written = CallHold.flush(hold.take(), root: root.path, segmentSec: 2) { event, fields in
            if event == "segment" { reports.append(fields) }
        }
        XCTAssertEqual(written, 2)
        XCTAssertEqual(reports.count, 2)
        for report in reports {
            XCTAssertEqual(report["kind"] as? String, "call")
            let path = try XCTUnwrap(report["path"] as? String)
            XCTAssertTrue(path.split(separator: "/").last!.hasPrefix("call-"), path)
            let file = try AVAudioFile(forReading: root.appendingPathComponent(path))
            XCTAssertGreaterThan(file.length, 0)
            XCTAssertEqual(file.fileFormat.sampleRate, 16_000)
        }
        let first = try XCTUnwrap(reports.first?["start"] as? Double)
        XCTAssertEqual(first, start, accuracy: 0.01)
    }
}
