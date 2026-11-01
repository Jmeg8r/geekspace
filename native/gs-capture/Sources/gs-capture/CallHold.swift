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
    static func flush(_ runs: [Run], root: String, segmentSec: Double,
                      report: @escaping (String, [String: Any]) -> Void) -> Int {
        var written = 0
        let writer = SegmentWriter(root: root, segmentSec: segmentSec, sampleRate: rate, prefix: "call", kind: "call") { event, fields in
            if event == "segment" { written += 1 }
            report(event, fields)
        }
        // 100 ms pieces, so a segment rolls close to segmentSec.
        let piece = Int(rate / 10)
        for run in runs {
            var offset = 0
            while offset < run.samples.count {
                let end = min(offset + piece, run.samples.count)
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
