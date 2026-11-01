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

    // Codex 4a r3 P2: 100 ms pieces overshot a --segment-sec that is not a multiple of them.
    func testFlushedSegmentsNeverExceedAFractionalSegmentLength() throws {
        var reports: [[String: Any]] = []
        let hold = CallHold(maxSec: 60)
        for i in 1...300 {
            hold.store(PCMChunk(endMs: 1_000 + Double(i) * 10, samples: [Float](repeating: 0.2, count: 160)), sourceRate: 16_000)
        }
        _ = CallHold.flush(hold.take(), root: root.path, segmentSec: 2.05) { event, fields in
            if event == "segment" { reports.append(fields) }
        }
        let lengths = reports.compactMap { r -> Double? in
            guard let s = r["start"] as? Double, let e = r["end"] as? Double else { return nil }
            return e - s
        }
        XCTAssertEqual(lengths.count, 2)
        XCTAssertEqual(lengths[0], 2_050, accuracy: 0.01)
        XCTAssertEqual(lengths.reduce(0, +), 3_000, accuracy: 0.01)
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

    func testReleaseAndDiscardNeedAHeldCall() {
        let sink = Sink(), router = makeRouter(sink)
        XCTAssertFalse(router.canRelease)
        XCTAssertFalse(router.canDiscard)
        router.hold(at: 1)
        XCTAssertTrue(router.canRelease)
    }

    // Codex 4b r1 P1: a second call that starts before the first is answered must be held
    // apart, so each call is released or dropped on its own notice.
    func testASecondHoldSplitsAndCallsResolveOldestFirst() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        for start in stride(from: 1_000.0, to: 1_100, by: 10) { router.deliver(chunk(start), sourceRate: 16_000) }
        router.hold(at: 1_100)
        for start in stride(from: 1_100.0, to: 1_200, by: 10) { router.deliver(chunk(start), sourceRate: 16_000) }
        router.release(at: 1_150)
        router.settle(frontier: 1_200)
        XCTAssertEqual(sink.flushed, [[1_000]], "the first call alone, up to where the second began")
        XCTAssertEqual(events(sink), ["callHeld", "callHeld", "callReleased"])
        router.discard(at: 1_200)
        router.deliver(chunk(1_200), sourceRate: 16_000)
        router.settle(frontier: 1_210)
        XCTAssertEqual(events(sink), ["callHeld", "callHeld", "callReleased", "callDiscarded"])
        XCTAssertEqual(sink.system, [1_200])
        XCTAssertEqual(sink.flushed.count, 1)
    }

    // Codex 4b r2: every helper starts held until its first audio-use report; with no call
    // going on, `call clear` turns what was held into ordinary system audio.
    func testClearWritesTheStartupHoldAsSystemAudio() {
        let sink = Sink()
        var systemRuns: [[Double]] = []
        let router = CallRouter(maxSec: 60, startHeld: true,
                                append: { sink.system.append($0.endMs - 10) },
                                closeSystem: { sink.systemCloses += 1 },
                                flush: { runs in sink.flushed.append(runs.map(\.startMs)); return runs.count },
                                flushSystem: { runs in systemRuns.append(runs.map(\.startMs)); return runs.count },
                                report: { sink.reports.append(($0, $1)) })
        router.deliver(chunk(0), sourceRate: 16_000)
        XCTAssertTrue(router.canClear)
        router.clear(at: 20)
        router.deliver(chunk(20), sourceRate: 16_000)
        router.settle(frontier: 30)
        XCTAssertEqual(systemRuns, [[0]])
        XCTAssertTrue(sink.flushed.isEmpty, "no call- file: there was no call")
        XCTAssertEqual(sink.system, [20])
        XCTAssertEqual(events(sink), ["callHeld", "callCleared"])
    }

    // Codex 4b r1 P1: a helper started while a call waits for its notice, or was declined,
    // holds from its first sample instead of recording the call as system audio.
    func testAStartHeldRouterHoldsFromTheFirstSample() {
        let sink = Sink()
        let router = CallRouter(maxSec: 60, startHeld: true,
                                append: { sink.system.append($0.endMs - 10) },
                                closeSystem: { sink.systemCloses += 1 },
                                flush: { runs in sink.flushed.append(runs.map(\.startMs)); return runs.count },
                                report: { sink.reports.append(($0, $1)) })
        router.deliver(chunk(0), sourceRate: 16_000)
        XCTAssertTrue(sink.system.isEmpty)
        XCTAssertTrue(router.canDiscard)
        router.discard(at: 20)
        router.settle(frontier: 30)
        XCTAssertEqual(events(sink), ["callHeld", "callDiscarded"])
    }

    // Codex 4b r3 P1: a call's opening audio, captured before the helper saw the call app,
    // reached a sys- file. The helper holds from before its poll saw the app, so a hold can
    // reach back past where system audio resumed after an earlier call.
    func testAHoldLooksBackPastWhereSystemAudioResumed() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.release(at: 1_100)
        router.hold(at: 1_050, app: "us.zoom.xos")
        router.release(at: 1_200)
        // Delivered after the commands, as the 500 ms hold-back makes it.
        for start in stride(from: 1_000.0, to: 1_300, by: 10) { router.deliver(chunk(start), sourceRate: 16_000) }
        router.settle(frontier: 1_300)
        XCTAssertEqual(sink.flushed, [[1_000], [1_050]], "the second call from where it was looked back to")
        XCTAssertEqual(sink.system.first, 1_200)
        XCTAssertFalse(sink.system.contains { $0 < 1_200 }, "nothing before the second release is system audio")
    }

    func testALookbackNeverReachesIntoTheCallBeforeIt() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.hold(at: 900, app: "us.zoom.xos")
        for start in stride(from: 900.0, to: 1_100, by: 10) { router.deliver(chunk(start), sourceRate: 16_000) }
        router.release(at: 1_100)
        router.release(at: 1_100)
        router.settle(frontier: 1_200)
        XCTAssertEqual(sink.system.first, 900, "before the first hold is system audio")
        XCTAssertFalse(sink.system.contains { $0 >= 1_000 && $0 < 1_100 })
    }

    func testAHoldNamesTheAppItHeld() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000, app: "us.zoom.xos")
        XCTAssertEqual(sink.reports.last?.0, "callHeld")
        XCTAssertEqual(sink.reports.last?.1["app"] as? String, "us.zoom.xos")
    }

    // Codex 4b r4 P1: a poll delayed by a long flush let call audio older than a fixed
    // lookback through as system audio. Audio is delivered only up to what the last poll has
    // classified, and a call is held from there, however late the next poll comes.
    func testTheWatcherHoldsFromWhereItLastClassifiedEvenAfterAStall() {
        var t = 1_000.0
        var processes: [AudioUse.Process] = []
        var holds: [(String, Double)] = []
        var reports: [(String, [String: Any])] = []
        let watcher = AudioUseWatcher(denylist: [], calls: AudioUse.CallTracker(apps: ["us.zoom.xos"], browsers: []),
                                      onCallStart: { holds.append(($0, $1)) }, now: { t }, readProcesses: { _ in processes },
                                      report: { reports.append(($0, $1)) })
        watcher.tick(known: [])
        XCTAssertEqual(watcher.classifiedThrough, 1_000 - AudioUse.detectionLagMs)
        t = 3_000
        processes = [AudioUse.Process(pid: 4_242, parent: 1, bundle: "us.zoom.xos", app: "us.zoom.xos",
                                      input: true, output: true, denylisted: false)]
        watcher.tick(known: [])
        XCTAssertEqual(holds.map(\.0), ["us.zoom.xos"])
        XCTAssertEqual(holds.map(\.1), [1_000 - AudioUse.detectionLagMs], "from the last classified point, not 2 s back")
        XCTAssertEqual(watcher.classifiedThrough, 3_000 - AudioUse.detectionLagMs)
        let classified = reports.filter { $0.0 == "audioClassified" }.compactMap { $0.1["through"] as? Double }
        XCTAssertEqual(classified, [875, 2_875])
        let order = reports.map(\.0).filter { $0 != "audioUse" }
        XCTAssertEqual(order.suffix(1), ["audioClassified"], "a poll's holds come before it says what it classified")
    }

    func testDeliveryWaitsForClassification() {
        XCTAssertEqual(SystemAudioRecorder.releaseLimit(tap: 5_000, classifiedThrough: 1_000) - SystemAudioRecorder.holdMs, 1_000)
        XCTAssertEqual(SystemAudioRecorder.releaseLimit(tap: 1_200, classifiedThrough: 1_000), 1_200, "the tap's own cap still holds")
        XCTAssertEqual(SystemAudioRecorder.releaseLimit(tap: 5_000, classifiedThrough: -.infinity), -.infinity, "nothing before the first poll")
    }

    // At stop, audio after the last classified point is dropped: no poll can say whether a
    // call began in it. A call's span ends there too.
    func testACutoffDropsWhatWasNeverClassified() {
        let sink = Sink(), router = makeRouter(sink)
        router.hold(at: 1_000)
        router.release(at: 1_100)
        router.cutoff(at: 1_050)
        for start in stride(from: 900.0, to: 1_200, by: 10) { router.deliver(chunk(start), sourceRate: 16_000) }
        router.stop()
        XCTAssertEqual(sink.flushed, [[1_000]])
        XCTAssertFalse(sink.system.contains { $0 >= 1_000 })
        XCTAssertEqual(sink.system.first, 900)
    }

    func testTheCallTrackerStartsACallOncePerApp() {
        var tracker = AudioUse.CallTracker(apps: ["us.zoom.xos"], browsers: ["com.google.Chrome"])
        let on = AudioUse.State(input: true, output: true)
        let out = AudioUse.State(input: false, output: true)
        XCTAssertEqual(tracker.update([.app("us.zoom.xos"): out]), ["us.zoom.xos"], "a call app playing audio")
        XCTAssertEqual(tracker.update([.app("us.zoom.xos"): on]), [], "already in a call")
        XCTAssertEqual(tracker.update([.app("us.zoom.xos"): on, .app("com.google.Chrome"): out]), [], "a browser only playing")
        XCTAssertEqual(tracker.update([.app("us.zoom.xos"): on, .app("com.google.Chrome"): on]), ["com.google.Chrome"])
        XCTAssertEqual(tracker.update([.app("com.google.Chrome"): out]), [], "the browser call goes on, its mic off")
        XCTAssertEqual(tracker.update([.app("us.zoom.xos"): out, .app("com.google.Chrome"): out]), ["us.zoom.xos"],
                       "an app that left and came back starts again")
        XCTAssertEqual(tracker.update([.denylisted: on, .app("com.apple.Music"): out]), [], "never-record and other apps")
        XCTAssertTrue(tracker.inCall.isEmpty)
    }
}
