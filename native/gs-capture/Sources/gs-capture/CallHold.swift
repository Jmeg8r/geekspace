// WHAT: the call hold (plan PR 4a). While a call waits for its recording notice, system audio
// is kept here, in memory, and written only when the supervisor releases it. A discard, a
// stop or a crash leaves nothing on disk (spec R5, F3).
// WHY 16 kHz mono Int16: 32 KB/s, so the default 30-minute cap is about 58 MB, and 16 kHz
// mono is what the transcriber uses anyway (meetingProcessor.mjs).
import Foundation

final class CallHold {
    static let rate = 16_000.0
    // Notice timeout (15 min) plus its one extension (15 min), set by the supervisor.
    static let defaultMaxSec = 1_800.0

    /// One stretch of continuous audio. A gap (sleep and wake) or a rate change starts another.
    struct Run {
        var startMs: Double
        var samples: [Int16]
        /// Source frames consumed so far, at `sourceRate`: keeps the resampled count exact
        /// across chunks, so a run's timeline is its samples.
        var sourceFrames: Double
        var sourceRate: Double
    }

    private(set) var runs: [Run] = []
    private(set) var overflowed = false
    private let capSamples: Int
    private var total = 0

    init(maxSec: Double) {
        capSamples = Int(maxSec * CallHold.rate)
    }

    var heldSec: Double { Double(total) / CallHold.rate }

    func store(_ chunk: PCMChunk, sourceRate: Double) {
        let n = chunk.samples.count
        guard n > 0 else { return }
        let startMs = chunk.endMs - Double(n) / sourceRate * 1000
        let continues = runs.last.map {
            $0.sourceRate == sourceRate
                && SegmentWriter.continues(expectedStartMs: $0.startMs + $0.sourceFrames / sourceRate * 1000, chunkStartMs: startMs)
        } ?? false
        if !continues { runs.append(Run(startMs: startMs, samples: [], sourceFrames: 0, sourceRate: sourceRate)) }
        var run = runs.removeLast()
        let ratio = CallHold.rate / sourceRate
        let target = Int(((run.sourceFrames + Double(n)) * ratio).rounded(.down))
        var k = run.samples.count
        while k < target {
            guard total < capSamples else {
                overflowed = true
                break
            }
            // Linear interpolation at this output sample's place in the chunk.
            let p = max(0, Double(k) / ratio - run.sourceFrames)
            let i = min(Int(p), n - 1)
            let j = min(i + 1, n - 1)
            let frac = Float(p - Double(i))
            run.samples.append(CallHold.int16(chunk.samples[i] * (1 - frac) + chunk.samples[j] * frac))
            total += 1
            k += 1
        }
        run.sourceFrames += Double(n)
        runs.append(run)
    }

    /// Everything held, oldest first; the hold is empty afterwards.
    func take() -> [Run] {
        defer {
            runs = []
            total = 0
            overflowed = false
        }
        return runs
    }

    static func int16(_ sample: Float) -> Int16 {
        Int16((max(-1, min(1, sample)) * 32_767).rounded())
    }

    /// Write released runs as `call-` segments of at most `segmentSec`, each a complete file
    /// (spec R2). Returns how many segments were written.
    /// `prefix`/`kind`: `call` for a released call; `sys`/`system` for a cleared startup hold.
    static func flush(_ runs: [Run], root: String, segmentSec: Double, prefix: String = "call", kind: String = "call",
                      report: @escaping (String, [String: Any]) -> Void) -> Int {
        var written = 0
        let writer = SegmentWriter(root: root, segmentSec: segmentSec, sampleRate: rate, prefix: prefix, kind: kind) { event, fields in
            if event == "segment" { written += 1 }
            report(event, fields)
        }
        // 100 ms pieces, cut short at a segment's end, so no segment runs past segmentSec
        // (Codex review of PR 4a, round 3).
        let piece = Int(rate / 10)
        let perSegment = Int((segmentSec * rate).rounded(.down))
        for run in runs {
            var offset = 0
            var inSegment = 0
            while offset < run.samples.count {
                if inSegment == perSegment { inSegment = 0 }
                let end = min(offset + piece, offset + perSegment - inSegment, run.samples.count)
                inSegment += end - offset
                let samples = run.samples[offset..<end].map { Float($0) / 32_767 }
                writer.append(PCMChunk(endMs: run.startMs + Double(end) / rate * 1000, samples: samples))
                offset = end
            }
            // A run is continuous; the next one is not, so it gets its own file.
            writer.close()
        }
        return written
    }
}

/// Routes released tap audio by when it was captured: system audio to the writer, call audio
/// to that call's hold, a discarded call's audio nowhere (Codex review of PR 4a, round 1).
/// WHY by capture time: a command lands while up to 500 ms of audio still sits in PCMHold.
/// Routed by the mode at delivery, a discarded call's tail reached a sys- file and a released
/// call's tail was filed as system audio. A call is settled (written or dropped) only once
/// everything captured before its end has been delivered.
/// Used from the recorder's control queue only.
final class CallRouter {
    /// `clear`: there was no call (a helper's startup hold, plan PR 4b); written as system audio.
    private enum Fate { case pending, release, discard(String), clear }
    private final class Call {
        let hold: CallHold
        var fate = Fate.pending
        /// The stop's unclassified tail: dropped without a callDiscarded line of its own.
        var silent = false
        init(maxSec: Double) { hold = CallHold(maxSec: maxSec) }
    }
    /// From `fromMs` on, audio belongs to `call` (nil: system audio).
    private struct Span {
        let fromMs: Double
        let call: Call?
    }

    private let maxSec: Double
    private let append: (PCMChunk) -> Void
    private let closeSystem: () -> Void
    private let flush: ([CallHold.Run]) -> Int
    private let flushSystem: ([CallHold.Run]) -> Int
    private let report: (String, [String: Any]) -> Void
    private var spans = [Span(fromMs: -.infinity, call: nil)]
    private var routingCall = false

    /// `startHeld`: everything from the first sample belongs to a held call, for a helper
    /// started while a call waits for its notice or was declined (Codex review of PR 4b).
    init(maxSec: Double, startHeld: Bool = false, append: @escaping (PCMChunk) -> Void, closeSystem: @escaping () -> Void,
         flush: @escaping ([CallHold.Run]) -> Int, flushSystem: @escaping ([CallHold.Run]) -> Int = { _ in 0 },
         report: @escaping (String, [String: Any]) -> Void) {
        self.maxSec = maxSec
        self.append = append
        self.closeSystem = closeSystem
        self.flush = flush
        self.flushSystem = flushSystem
        self.report = report
        if startHeld { hold(at: -.infinity) }
    }

    /// The oldest call still waiting for a release or a discard: commands resolve calls in the
    /// order they were held. A hold while one waits holds the new call apart (Codex #4b r1).
    private var oldestPending: (index: Int, call: Call)? {
        for (index, span) in spans.enumerated() {
            if let call = span.call, case .pending = call.fate { return (index, call) }
        }
        return nil
    }

    var canHold: Bool { true }
    var canRelease: Bool { oldestPending != nil }
    var canDiscard: Bool { oldestPending != nil }
    var canClear: Bool { oldestPending != nil }

    /// Audio captured from `t` on is a new call's. `t` may be in the past (the helper's own
    /// holds look back past its poll's detection lag, Codex review of PR 4b, round 3): system
    /// audio that resumed after `t` is the new call's instead, but a call held before it keeps
    /// what it held. `app` is the call app the helper saw start, when it held on its own.
    func hold(at t: Double, app: String? = nil) {
        let from = begin(Call(maxSec: maxSec), at: t)
        var fields: [String: Any] = ["t": from.isFinite ? round3(from) : 0]
        if let app { fields["app"] = app }
        report("callHeld", fields)
    }

    /// Start `call`'s span at `t`, or where the last call's span began if that is later. System
    /// audio that resumed after it is the new span's. Returns where the span begins.
    private func begin(_ call: Call, at t: Double) -> Double {
        let floor = spans.last { $0.call != nil }?.fromMs ?? -.infinity
        let from = max(t, floor)
        while spans.count > 1, let last = spans.last, last.call == nil, last.fromMs > from { spans.removeLast() }
        spans.append(Span(fromMs: from, call: call))
        return from
    }

    /// The helper is stopping: audio captured from `t` on was never classified (no poll can
    /// say whether a call began in it), so it is dropped, and any call ends there (Codex
    /// review of PR 4b, round 4).
    func cutoff(at t: Double) {
        let tail = Call(maxSec: maxSec)
        tail.fate = .discard("stop")
        tail.silent = true
        _ = begin(tail, at: t)
    }

    /// Audio captured in [from, to) was never checked by an audio-use poll: system audio in it is
    /// dropped, and system audio resumes at `to`. A held call keeps what it holds: its audio is
    /// never written without a notice anyway (Codex review of PR 4b, round 6).
    func gap(from: Double, to: Double) {
        if let held = spans.last?.call, case .pending = held.fate { return }
        let dropped = Call(maxSec: maxSec)
        dropped.fate = .discard("gap")
        dropped.silent = true
        let start = begin(dropped, at: from)
        if to > start { spans.append(Span(fromMs: to, call: nil)) }
    }

    func release(at t: Double) { resolve(.release, at: t) }

    func discard(at t: Double, reason: String = "command") { resolve(.discard(reason), at: t) }

    /// No call after all: what was held is ordinary system audio.
    func clear(at t: Double) { resolve(.clear, at: t) }

    /// Resolve the oldest waiting call. If it is still the one being held, system audio
    /// resumes at `t`; otherwise it already ended where the next call began.
    private func resolve(_ fate: Fate, at t: Double) {
        guard let (index, call) = oldestPending else { return }
        call.fate = fate
        if index == spans.count - 1 { spans.append(Span(fromMs: t, call: nil)) }
    }

    /// Each sample goes where its own capture time falls, so a chunk that straddles a hold,
    /// release or discard is split there (Codex review of PR 4a, round 2).
    func deliver(_ chunk: PCMChunk, sourceRate: Double) {
        let n = chunk.samples.count
        let startMs = chunk.endMs - Double(n) / sourceRate * 1000
        var from = 0
        while from < n {
            let fromMs = startMs + Double(from) / sourceRate * 1000
            let index = spans.lastIndex { $0.fromMs <= fromMs } ?? 0
            var to = n
            if index + 1 < spans.count {
                // Samples that start before the next span's beginning stay in this one.
                let boundary = ((spans[index + 1].fromMs - startMs) * sourceRate / 1000).rounded(.up)
                to = min(n, max(from + 1, Int(boundary)))
            }
            let piece = PCMChunk(endMs: startMs + Double(to) / sourceRate * 1000, samples: Array(chunk.samples[from..<to]))
            route(piece, to: spans[index].call, sourceRate: sourceRate)
            from = to
        }
    }

    private func route(_ piece: PCMChunk, to call: Call?, sourceRate: Double) {
        guard let call else {
            routingCall = false
            append(piece)
            return
        }
        // The system segment ends where the call begins, so no call audio is in a sys- file.
        if !routingCall {
            closeSystem()
            routingCall = true
        }
        if case .discard = call.fate { return }
        call.hold.store(piece, sourceRate: sourceRate)
    }

    /// Write or drop every call whose audio has all been delivered: everything captured
    /// before `frontier` is out of PCMHold.
    func settle(frontier: Double) {
        while spans.count > 1, spans[1].fromMs <= frontier {
            let done = spans.removeFirst()
            guard let call = done.call else { continue }
            switch call.fate {
            case .release:
                let (heldSec, overflowed) = (call.hold.heldSec, call.hold.overflowed)
                let segments = flush(call.hold.take())
                report("callReleased", ["segments": segments, "heldSec": round3(heldSec), "overflowed": overflowed])
            case .discard(let reason):
                let heldSec = call.hold.heldSec
                _ = call.hold.take()
                if !call.silent { report("callDiscarded", ["heldSec": round3(heldSec), "reason": reason]) }
            case .clear:
                let heldSec = call.hold.heldSec
                let segments = flushSystem(call.hold.take())
                report("callCleared", ["segments": segments, "heldSec": round3(heldSec)])
            case .pending:
                // Held apart by a later call, and not answered yet: it settles later, in order.
                spans.insert(done, at: 0)
                return
            }
        }
    }

    /// The tap has stopped and everything is delivered: a call still waiting for its notice
    /// is dropped (never written without one), and the rest settle.
    func stop() {
        while oldestPending != nil { discard(at: .infinity, reason: "stop") }
        settle(frontier: .infinity)
    }
}
