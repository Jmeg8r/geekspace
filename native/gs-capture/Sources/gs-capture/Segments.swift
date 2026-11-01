// WHAT: system-audio segments for `gs-capture run` (plan PR 3b-2). The tap's samples are held
// back as real PCM, released into one AAC .m4a file per segment, and dropped, never
// written, when a rebuild finds a new denylisted process.
// WHY PCM, not RMS windows: the spike form only metered. Production has to write audio, and
// the PR 3a guarantee (audio from a new denylisted process never leaves the hold) only holds if
// the same buffers that are dropped are the ones that would have been written.
// WHY one finalized file per segment: spec R2. Any segment must decode without the ones
// before it, so each is a complete container, written under a hidden name and renamed when
// it is finished, so a path is never announced for a partial file.
import AVFoundation
import CoreAudio
import Foundation

/// A run of mono samples, stamped when the tap delivered it (the end of the run).
struct PCMChunk {
    let endMs: Double
    let samples: [Float]
}

/// Holds mono PCM `holdMs` before handing it to `deliver`. `ingest` runs on the tap's IO
/// queue; everything else on the recorder's control queue.
final class PCMHold: TapSink, @unchecked Sendable {
    private let lock = NSLock()
    private let holdMs: Double
    private var sampleRate: Double
    private let deliver: (PCMChunk) -> Void
    private let onDrop: () -> Void
    private var pending: [PCMChunk] = []
    private var total = 0

    /// `onDrop` runs after a drop, so the writer can close the segment around the gap.
    init(holdMs: Double, sampleRate: Double, deliver: @escaping (PCMChunk) -> Void, onDrop: @escaping () -> Void) {
        self.holdMs = holdMs
        self.sampleRate = sampleRate
        self.deliver = deliver
        self.onDrop = onDrop
    }

    func ingest(_ buffers: UnsafeMutableAudioBufferListPointer, tapChannels: Int) {
        // Interleaved tap stream: one buffer carrying exactly the tap's channels. Anything
        // else would be written as noise, so it fails the run instead (spec R3).
        guard buffers.count == 1, let buffer = buffers.first, Int(buffer.mNumberChannels) == tapChannels else {
            fail("tap IO delivered \(buffers.count) buffer(s) with \(buffers.first?.mNumberChannels ?? 0) channels; expected 1 buffer with \(tapChannels)")
        }
        guard let data = buffer.mData else { return }
        let floats = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self),
                                         count: Int(buffer.mDataByteSize) / MemoryLayout<Float>.size)
        ingest(interleaved: floats, channels: tapChannels, at: nowMs())
    }

    /// The testable half of `ingest`: downmix to mono and hold.
    func ingest(interleaved: UnsafeBufferPointer<Float>, channels: Int, at t: Double) {
        let mono = PCMHold.downmix(interleaved, channels: channels)
        guard !mono.isEmpty else { return }
        lock.withLock {
            pending.append(PCMChunk(endMs: t, samples: mono))
            total += mono.count
        }
    }

    /// Mono is what transcription uses, and it halves what is held and written.
    static func downmix(_ interleaved: UnsafeBufferPointer<Float>, channels: Int) -> [Float] {
        guard channels > 1 else { return Array(interleaved) }
        let frames = interleaved.count / channels
        var mono = [Float](repeating: 0, count: frames)
        for frame in 0..<frames {
            var sum: Float = 0
            for channel in 0..<channels { sum += interleaved[frame * channels + channel] }
            mono[frame] = sum / Float(channels)
        }
        return mono
    }

    func sampleCount() -> Int { lock.withLock { total } }

    var rate: Double { lock.withLock { sampleRate } }

    /// Only between sessions, after a drop: anything still held was captured at the old rate.
    func setSampleRate(_ rate: Double) {
        lock.withLock {
            guard pending.isEmpty else { fail("sample rate changed while \(pending.count) chunk(s) were held") }
            sampleRate = rate
        }
    }

    func release(now: Double) {
        // Taken under the lock, delivered outside it, so encoding never blocks the IO queue.
        let ready = lock.withLock {
            let ready = pending.prefix { $0.endMs <= now - holdMs }
            pending.removeFirst(ready.count)
            return Array(ready)
        }
        ready.forEach(deliver)
    }

    func releaseAll() { release(now: .infinity) }

    func drop() -> (windows: Int, maxRms: Double) {
        let dropped = lock.withLock {
            let dropped = pending
            pending.removeAll()
            return dropped
        }
        onDrop()
        let frames = dropped.reduce(0) { $0 + $1.samples.count }
        let windowFrames = max(Int(rate) / 10, 1)
        let maxRms = dropped.map { chunk in
            sqrt(chunk.samples.reduce(0.0) { $0 + Double($1 * $1) } / Double(chunk.samples.count))
        }.max() ?? 0
        return ((frames + windowFrames - 1) / windowFrames, maxRms)
    }
}

/// Writes released PCM as one AAC .m4a per segment under `<root>/<day>/`, and reports each
/// finished segment. Used from the recorder's control queue only.
final class SegmentWriter {
    // Speech-grade mono AAC: about 2.4 MB per 5-minute segment. The transcriber resamples
    // to 16 kHz anyway (meetingProcessor.mjs).
    static let aacBitRate = 32_000
    // A chunk this far from where the samples written so far say it should start means
    // delivery paused (sleep/wake) or the clock jumped. Callback jitter and drift over a
    // segment are tens of ms at most.
    static let gapToleranceMs = 500.0

    private struct Open {
        let file: AVAudioFile
        let partial: URL
        let final: URL
        let day: String
        let path: String
        let startMs: Double
        var frames: Int
        var peak: Float
    }

    private let root: String
    private let segmentSec: Double
    private(set) var sampleRate: Double
    private let report: (String, [String: Any]) -> Void
    private var open: Open?

    init(root: String, segmentSec: Double, sampleRate: Double, report: @escaping (String, [String: Any]) -> Void) {
        self.root = root
        self.segmentSec = segmentSec
        self.sampleRate = sampleRate
        self.report = report
    }

    /// A segment closes when it is full or the local day changed: a segment's file lives in
    /// the folder of the day it started, and a day's record should not continue in yesterday's
    /// file.
    static func shouldRoll(frames: Int, sampleRate: Double, segmentSec: Double, openDay: String, chunkDay: String) -> Bool {
        Double(frames) / sampleRate >= segmentSec || openDay != chunkDay
    }

    /// A segment's samples are its timeline: `end` is start plus samples written. So audio
    /// that does not follow on in time must start a new segment, or everything after a pause
    /// would be stamped too early (Codex review of PR 3b-2).
    static func continues(expectedStartMs: Double, chunkStartMs: Double) -> Bool {
        abs(chunkStartMs - expectedStartMs) <= gapToleranceMs
    }

    /// Only between segments (a rebuild has just closed one): a tap rebuilt on a new output
    /// device can run at another rate, and its samples must not be written at the old one.
    func setSampleRate(_ rate: Double) {
        guard open == nil else { fail("sample rate changed with segment \(open!.path) still open") }
        sampleRate = rate
    }

    func append(_ chunk: PCMChunk) {
        let startMs = chunk.endMs - Double(chunk.samples.count) / sampleRate * 1000
        let (chunkDay, _) = Run.dayAndFile(Date(timeIntervalSince1970: startMs / 1000), prefix: "sys", ext: "m4a")
        if let current = open,
           SegmentWriter.shouldRoll(frames: current.frames, sampleRate: sampleRate, segmentSec: segmentSec,
                                    openDay: current.day, chunkDay: chunkDay)
           || !SegmentWriter.continues(expectedStartMs: current.startMs + Double(current.frames) / sampleRate * 1000,
                                       chunkStartMs: startMs) {
            close()
        }
        if open == nil { open = begin(at: startMs) }
        guard var current = open else { return }
        do {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: current.file.processingFormat,
                                                frameCapacity: AVAudioFrameCount(chunk.samples.count)),
                  let channel = buffer.floatChannelData?[0] else {
                fail("cannot allocate a \(chunk.samples.count)-frame audio buffer for \(current.path)")
            }
            buffer.frameLength = AVAudioFrameCount(chunk.samples.count)
            chunk.samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: chunk.samples.count) }
            try current.file.write(from: buffer)
        } catch {
            fail("cannot write audio to \(current.path): \(error.localizedDescription)")
        }
        current.frames += chunk.samples.count
        current.peak = chunk.samples.reduce(current.peak) { max($0, abs($1)) }
        open = current
    }

    /// Finalize, check the file decodes on its own, rename it into place, then announce it.
    /// Does nothing when no segment is open.
    func close() {
        guard let current = open else { return }
        open = nil
        current.file.close()
        let (partial, final, path) = (current.partial, current.final, current.path)
        let (startMs, frames, peak, day) = (current.startMs, current.frames, current.peak, current.day)
        _ = consume current
        do {
            let readable = try AVAudioFile(forReading: partial)
            guard readable.length > 0 else { fail("segment \(path) has no audio after it was finalized") }
            try placeWithoutReplacing(partial, at: final)
        } catch {
            fail("cannot finalize segment \(path): \(error.localizedDescription)")
        }
        report("segment", ["kind": "system", "day": day, "path": path, "start": round3(startMs),
                           "end": round3(startMs + Double(frames) / sampleRate * 1000), "peak": Double(peak)])
    }

    private func begin(at startMs: Double) -> Open {
        let (day, file) = Run.dayAndFile(Date(timeIntervalSince1970: startMs / 1000), prefix: "sys", ext: "m4a")
        let dir = URL(fileURLWithPath: "\(root)/\(day)")
        // Hidden while partial: never announced, and never matches a stored path's shape
        // (convex/lib/dayRecorder.ts FILE_RE refuses a leading dot).
        let partial = dir.appendingPathComponent(".partial-\(file)")
        let final = dir.appendingPathComponent(file)
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: sampleRate,
                                       AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: SegmentWriter.aacBitRate]
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let audio = try AVAudioFile(forWriting: partial, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            return Open(file: audio, partial: partial, final: final, day: day, path: "\(day)/\(file)",
                        startMs: startMs, frames: 0, peak: 0)
        } catch {
            fail("cannot start segment \(day)/\(file): \(error.localizedDescription)")
        }
    }
}

/// System audio for `run`: the shared tap loop feeding a PCM hold feeding the segment writer,
/// driven by a timer on one control queue so ticks, drops and shutdown never interleave.
final class SystemAudioRecorder {
    // The PR 3a proven pair: poll every 100 ms, hold 500 ms (at least two polls).
    static let rebuildMs = 100.0
    static let holdMs = 500.0

    private let queue = DispatchQueue(label: "gs-capture.audio-control")
    private var timer: DispatchSourceTimer?
    private var runner: TapRunner?
    private var writer: SegmentWriter?
    private var hold: PCMHold?
    private var watcher: AudioUseWatcher?

    /// Starts capturing. `report` receives `segment`, `tapRebuilt`, `tailDropped`,
    /// `sessionUnverified`, `sampleRateChanged` and `audioUse`.
    init(root: String, denylist: [String], segmentSec: Double, report: @escaping (String, [String: Any]) -> Void) {
        queue.sync {
            // Bundle IDs (each plus "<id>.helper") AND live process objects: bundle IDs alone
            // silenced only one of two live instances (spike Q2). Bundle-ID taps need macOS 26.
            let bundleIDs = denylist.isEmpty ? nil : denylist.flatMap { [$0, "\($0).helper"] }
            // Nothing denylisted, nothing to protect: an unclassifiable arrival would only
            // cost audio.
            let arrivals = denylist.isEmpty ? nil : ProcessArrivals(identify: Tap.identity, judge: { Tap.judge($0, denylist) })
            let runner = TapRunner(objectsNow: { Tap.excludedObjects(denylist) }, bundleIDs: bundleIDs,
                                   rebuildMs: SystemAudioRecorder.rebuildMs, arrivals: arrivals, report: report) { [unowned self] format in
                if let hold = self.hold, let writer = self.writer {
                    // A rebuild: the drop has emptied the hold and closed the segment, so a
                    // new rate can take effect here without mixing rates in one file.
                    if format.mSampleRate != hold.rate {
                        report("sampleRateChanged", ["t": round3(nowMs()), "from": hold.rate, "to": format.mSampleRate])
                        hold.setSampleRate(format.mSampleRate)
                        writer.setSampleRate(format.mSampleRate)
                    }
                    return hold
                }
                let writer = SegmentWriter(root: root, segmentSec: segmentSec, sampleRate: format.mSampleRate, report: report)
                let hold = PCMHold(holdMs: SystemAudioRecorder.holdMs, sampleRate: format.mSampleRate,
                                   deliver: writer.append, onDrop: writer.close)
                self.writer = writer
                self.hold = hold
                return hold
            }
            self.runner = runner
            // On this queue too, so it reads the tap's exclusion (sticky, orphans included)
            // without a lock: F2's "a denylisted app is using audio" and the tap's exclusion
            // can never disagree (plan PR 3b-3).
            let watcher = AudioUseWatcher(denylist: denylist, report: report)
            self.watcher = watcher
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now(), repeating: .milliseconds(Int(Tap.releaseTickMs)))
            timer.setEventHandler {
                // tick returns the release limit, read before it checks arrivals and capped at
                // the last completed classification pass (Codex review of PR 3b-2, rounds 4-5).
                runner.sink.release(now: runner.tick(poll: true))
                watcher.tick(known: runner.knownDenied())
            }
            timer.resume()
            self.timer = timer
        }
    }

    /// Stop the tap, settle the held tail (dropped if a denylisted process appeared after the
    /// last poll) and finalize the open segment. Safe to call more than once.
    func stop() {
        queue.sync {
            guard let runner, let timer else { return }
            timer.cancel()
            runner.finish(tailCheck: true)
            writer?.close()
            self.timer = nil
            self.runner = nil
        }
    }
}
