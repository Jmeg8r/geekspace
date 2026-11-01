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

// Codex 4a r1 P1: the command lands while up to 500 ms of audio still sits in PCMHold. That
// tail was routed by the mode at delivery, so a discarded call's last half second reached a
// sys- file and a released call's tail was filed as system audio. CallRouter decides by when
// each chunk was captured, and settles a call only once everything before its end is out.
final class CallRouterTests: XCTestCase {
    final class Sink {
        var system: [Double] = []      // start ms of chunks written as system audio
        var systemSamples = 0
        var heldSamples: Int?
        var systemCloses = 0
        var flushed: [[Double]] = []   // per released call: start ms of its runs' samples
        var reports: [(String, [String: Any])] = []
    }

    /// 10 ms of 16 kHz audio starting at `startMs`.
    func chunk(_ startMs: Double) -> PCMChunk {
        PCMChunk(endMs: startMs + 10, samples: [Float](repeating: 0.25, count: 160))
    }

    func makeRouter(_ sink: Sink) -> CallRouter {
        CallRouter(maxSec: 60,
                   append: { chunk in
                       sink.system.append(chunk.endMs - Double(chunk.samples.count) / 16)
                       sink.systemSamples += chunk.samples.count
                   },
                   closeSystem: { sink.systemCloses += 1 },
                   flush: { runs in
                       sink.flushed.append(runs.map(\.startMs))
                       return runs.count
                   },
                   report: { sink.reports.append(($0, $1)) })
    }

    func events(_ sink: Sink) -> [String] { sink.reports.map(\.0) }

    func testAudioBeforeTheHoldIsSystemAndTheSegmentClosesAtTheHold() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.deliver(chunk(990), sourceRate: 16_000)
        router.deliver(chunk(1_000), sourceRate: 16_000)
        XCTAssertEqual(sink.system, [990])
        XCTAssertEqual(sink.systemCloses, 1)
        XCTAssertEqual(events(sink), ["callHeld"])
    }

    func testADiscardedCallsTailNeverReachesTheSystemWriter() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.deliver(chunk(1_000), sourceRate: 16_000)
        router.discard(at: 1_500)
        // Still in PCMHold when the discard landed: captured during the call.
        router.deliver(chunk(1_400), sourceRate: 16_000)
        router.deliver(chunk(1_490), sourceRate: 16_000)
        router.deliver(chunk(1_500), sourceRate: 16_000)
        router.settle(frontier: 1_510)
        XCTAssertEqual(sink.system, [1_500])
        XCTAssertTrue(sink.flushed.isEmpty)
        XCTAssertEqual(events(sink), ["callHeld", "callDiscarded"])
        XCTAssertEqual(sink.reports.last?.1["reason"] as? String, "command")
    }

    func testAReleasedCallsTailIsWrittenWithTheCall() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.deliver(chunk(1_000), sourceRate: 16_000)
        router.release(at: 1_500)
        router.settle(frontier: 1_200)
        XCTAssertTrue(sink.flushed.isEmpty, "the tail before the release is not out yet")
        router.deliver(chunk(1_490), sourceRate: 16_000)
        router.deliver(chunk(1_500), sourceRate: 16_000)
        router.settle(frontier: 1_510)
        XCTAssertEqual(sink.flushed.count, 1)
        // 1490 follows 1010 within the 500 ms gap tolerance, so it is the same run.
        XCTAssertEqual(sink.flushed[0], [1_000])
        XCTAssertEqual(sink.system, [1_500])
        XCTAssertEqual(events(sink), ["callHeld", "callReleased"])
    }

    func testCallsSettleInOrderWhenCommandsComeQuickly() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.release(at: 1_100)
        router.hold(at: 1_200)
        router.discard(at: 1_300)
        for start in stride(from: 1_000.0, to: 1_400, by: 10) { router.deliver(chunk(start), sourceRate: 16_000) }
        router.settle(frontier: 1_400)
        XCTAssertEqual(events(sink), ["callHeld", "callHeld", "callReleased", "callDiscarded"])
        XCTAssertEqual(sink.flushed.count, 1)
        XCTAssertEqual(sink.system.first, 1_100)
        XCTAssertFalse(sink.system.contains { $0 >= 1_200 && $0 < 1_300 }, "the discarded call wrote nothing")
    }

    func testAStopWhileHeldDiscardsTheCall() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.deliver(chunk(1_000), sourceRate: 16_000)
        router.stop()
        XCTAssertTrue(sink.flushed.isEmpty)
        XCTAssertEqual(events(sink), ["callHeld", "callDiscarded"])
        XCTAssertEqual(sink.reports.last?.1["reason"] as? String, "stop")
    }

    func testAStopSettlesAReleaseStillWaitingForItsTail() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.deliver(chunk(1_000), sourceRate: 16_000)
        router.release(at: 1_500)
        router.stop()
        XCTAssertEqual(sink.flushed.count, 1)
        XCTAssertEqual(events(sink), ["callHeld", "callReleased"])
    }

    // Codex 4a r2 P1: a chunk straddling a boundary was routed whole by its start, so up to
    // 10 ms of call audio reached a sys- file.
    func testAChunkStraddlingTheHoldIsSplitAtTheBoundary() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.deliver(chunk(995), sourceRate: 16_000)
        router.release(at: 2_000)
        router.settle(frontier: 2_000)
        XCTAssertEqual(sink.systemSamples, 80, "only the 5 ms before the hold is system audio")
        XCTAssertEqual(sink.flushed, [[1_000]], "the 5 ms after it starts the call")
    }

    func testAChunkStraddlingADiscardDropsOnlyTheCallPart() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.discard(at: 1_005)
        router.deliver(chunk(1_000), sourceRate: 16_000)
        router.settle(frontier: 1_010)
        XCTAssertEqual(sink.systemSamples, 80)
        XCTAssertEqual(sink.system, [1_005])
    }

    func testOutOfOrderCommandsAreRefused() {
        let sink = Sink(), router = makeRouter(sink)
        XCTAssertFalse(router.canRelease)
        XCTAssertFalse(router.canDiscard)
        router.hold(at: 1)
        XCTAssertFalse(router.canHold)
        XCTAssertTrue(router.canRelease)
    }
}
