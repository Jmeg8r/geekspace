// WHAT: ScreenCaptureKit system-audio capture with a denylist filter, reporting RMS per
// window and overall, optionally writing a float32 WAV.
// WHY: spike question 2. A filter that excludes an app's windows is only half of F1; the
// app's audio must be excluded too, and the only honest proof is a measured level against a
// control run that captures the same tone unfiltered.
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

final class AudioCollector: NSObject, SCStreamOutput, SCStreamDelegate {
    private let lock = NSLock()
    private(set) var samples: [Float] = []
    private var windowSquares = 0.0
    private var windowCount = 0
    private let windowSize: Int
    var stopError: Error?

    init(windowSize: Int) { self.windowSize = windowSize }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, buffer.isValid else { return }
        var blockBuffer: CMBlockBuffer?
        var listSize = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: &listSize,
            bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: 0, blockBufferOut: nil)
        let rawList = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { rawList.deallocate() }
        let list = rawList.bindMemory(to: AudioBufferList.self, capacity: 1)
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: nil,
            bufferListOut: list, bufferListSize: listSize, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer)
        guard status == noErr else {
            FileHandle.standardError.write("gs-capture: dropped audio buffer, status \(status)\n".data(using: .utf8)!)
            return
        }
        // SCK delivers non-interleaved float32; channel 0 is enough to measure level.
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        guard let first = buffers.first, let data = first.mData else { return }
        let count = Int(first.mDataByteSize) / MemoryLayout<Float>.size
        let floats = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: count)
        lock.lock()
        defer { lock.unlock() }
        for value in floats {
            samples.append(value)
            windowSquares += Double(value * value)
            windowCount += 1
            if windowCount == windowSize {
                emit(["t": round3(nowMs()), "windowRms": sqrt(windowSquares / Double(windowCount))])
                windowSquares = 0
                windowCount = 0
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { stopError = error }

    func snapshot() -> [Float] {
        lock.lock()
        defer { lock.unlock() }
        return samples
    }
}

enum SystemAudio {
    static let sampleRate = 48_000

    static func capture(_ args: Args) async {
        let seconds = args.double("seconds", default: 10)
        let exclude = args.list("exclude")
        let content = await Screen.content()
        let (filter, _, excludedCount) = Screen.filter(content, excluding: exclude)
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = sampleRate
        config.channelCount = 2
        // SCK always runs a video pipeline; keep it as small and slow as it allows.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        // 100 ms RMS windows: fine enough to time a leak.
        let collector = AudioCollector(windowSize: sampleRate / 10)
        let stream = SCStream(filter: filter, configuration: config, delegate: collector)
        do {
            try stream.addStreamOutput(collector, type: .audio, sampleHandlerQueue: DispatchQueue(label: "gs-capture.audio"))
            try await withTimeout(seconds: Screen.captureTimeoutSec, what: "startCapture") { try await stream.startCapture() }
        } catch {
            fail("SCStream audio start failed: \(error.localizedDescription)")
        }
        emit(["event": "started", "t": round3(nowMs()), "excludedApps": excludedCount, "exclude": exclude])
        // --follow-ms N: re-list apps every N ms and push a new filter when the set of
        // denylisted apps changes, so an app launched mid-stream is excluded. Measures the
        // leak window production has to accept (or cover another way).
        let followMs = args.string("follow-ms").flatMap(Double.init)
        let deadline = nowMs() + seconds * 1000
        var currentCount = excludedCount
        while nowMs() < deadline {
            guard let followMs else {
                try? await Task.sleep(nanoseconds: UInt64((deadline - nowMs()) * 1_000_000))
                break
            }
            try? await Task.sleep(nanoseconds: UInt64(followMs * 1_000_000))
            let (fresh, _, count) = Screen.filter(await Screen.content(), excluding: exclude)
            if count != currentCount {
                do {
                    try await stream.updateContentFilter(fresh)
                    emit(["event": "filterUpdated", "t": round3(nowMs()), "excludedApps": count])
                    currentCount = count
                } catch {
                    fail("updateContentFilter failed: \(error.localizedDescription)")
                }
            }
        }
        do {
            try await withTimeout(seconds: Screen.captureTimeoutSec, what: "stopCapture") { try await stream.stopCapture() }
        } catch {
            fail("SCStream audio stop failed: \(error.localizedDescription)")
        }
        if let error = collector.stopError { fail("SCStream stopped early: \(error.localizedDescription)") }

        let samples = collector.snapshot()
        guard !samples.isEmpty else { fail("no audio buffers arrived in \(seconds)s") }
        let rms = sqrt(samples.reduce(0.0) { $0 + Double($1 * $1) } / Double(samples.count))
        let peak = samples.reduce(Float(0)) { max($0, abs($1)) }
        if let out = args.string("out") { writeWav(samples, to: out) }
        emit(["event": "summary", "samples": samples.count, "seconds": round3(Double(samples.count) / Double(sampleRate)),
              "rms": rms, "dbfs": rms > 0 ? round3(20 * log10(rms)) : -999, "peak": Double(peak),
              "excludedApps": excludedCount])
    }

    static func writeWav(_ samples: [Float], to path: String) {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else {
            fail("cannot allocate wav buffer")
        }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            buffer.floatChannelData![0].update(from: source.baseAddress!, count: samples.count)
        }
        do {
            let file = try AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: format.settings)
            try file.write(from: buffer)
        } catch {
            fail("cannot write \(path): \(error.localizedDescription)")
        }
    }
}
