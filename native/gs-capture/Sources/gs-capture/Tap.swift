// WHAT: system audio through a CoreAudio process tap (macOS 14.2+) that excludes every audio
// process belonging to a denylisted app, including its helper processes.
// WHY: the spike found ScreenCaptureKit's app filter does not remove audio that Chromium and
// Electron apps play from a windowless helper process (Q2, -15 dBFS leaked). CoreAudio sees
// those helpers as their own process objects, so a tap can name them for exclusion.
//
// PR 3a: a second instance of a denylisted app that starts audio after the tap exists still
// leaked (bundle-ID exclusion binds one process per ID; a live tap refuses updates with
// '!hog'). --rebuild-ms polls for new denylisted process objects and REBUILDS the tap around
// them, and --hold-ms holds every window back that long before releasing it. A rebuild drops
// whatever is held, so audio captured between the new process starting and the rebuild is
// never released. See docs/changes/2026-10-18-day-recorder/plan.md (PR 3, first obligation).
import AppKit
import AudioToolbox
import CoreAudio
import Foundation

/// RMS per 100 ms window, held back `holdMs` before release. Shared by every tap session of
/// one run, so totals span rebuilds.
final class TapMeter: @unchecked Sendable {
    private let lock = NSLock()
    private let holdMs: Double
    private let windowSize: Int
    private var pending: [(t: Double, rms: Double)] = []
    private var squares = 0.0, count = 0
    private var totalSquares = 0.0, total = 0, peak: Float = 0
    private var callbacks = 0, bufferCount = 0
    private var channelMismatch: UInt32?
    private var dropped = 0

    init(holdMs: Double, sampleRate: Double, channels: Int) {
        self.holdMs = holdMs
        windowSize = Int(sampleRate) / 10 * channels
    }

    func ingest(_ buffers: UnsafeMutableAudioBufferListPointer, tapChannels: Int) {
        lock.lock()
        defer { lock.unlock() }
        callbacks += 1
        bufferCount = buffers.count
        // Interleaved tap stream: one buffer carrying exactly the tap's channels.
        guard buffers.count == 1, let buffer = buffers.first, Int(buffer.mNumberChannels) == tapChannels else {
            channelMismatch = buffers.first?.mNumberChannels ?? 0
            return
        }
        guard let data = buffer.mData else { return }
        let floats = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self),
                                         count: Int(buffer.mDataByteSize) / MemoryLayout<Float>.size)
        for value in floats {
            squares += Double(value * value)
            totalSquares += Double(value * value)
            peak = max(peak, abs(value))
            count += 1
            total += 1
            if count == windowSize {
                let window = (t: round3(nowMs()), rms: sqrt(squares / Double(count)))
                if holdMs > 0 { pending.append(window) } else { emit(["t": window.t, "windowRms": window.rms]) }
                squares = 0
                count = 0
            }
        }
    }

    /// Emit every held window captured at least `holdMs` before `now`.
    func release(now: Double) {
        lock.lock()
        defer { lock.unlock() }
        let ready = pending.prefix { $0.t <= now - holdMs }
        for window in ready { emit(["t": window.t, "windowRms": window.rms]) }
        pending.removeFirst(ready.count)
    }

    /// Discard everything held, including the window in progress. Returns how many full
    /// windows were dropped.
    func drop() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let count = pending.count
        dropped += count
        pending.removeAll()
        squares = 0
        self.count = 0
        return count
    }

    func releaseAll() { release(now: .infinity) }

    func totals() -> (samples: Int, squares: Double, peak: Float, callbacks: Int, buffers: Int, mismatch: UInt32?, dropped: Int) {
        lock.withLock { (total, totalSquares, peak, callbacks, bufferCount, channelMismatch, dropped) }
    }
}

/// One process tap plus the private aggregate device that reads it.
struct TapSession {
    let tapID: AudioObjectID
    let deviceID: AudioObjectID
    let procID: AudioDeviceIOProcID
    let description: CATapDescription
    let excluded: [AudioObjectID]
    let format: AudioStreamBasicDescription

    /// `meterFor` returns the run's meter, creating it from the first session's format.
    static func make(excluding excluded: [AudioObjectID], bundleIDs: [String]?,
                     meterFor: (AudioStreamBasicDescription) -> TapMeter) -> TapSession {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
        if let bundleIDs {
            guard #available(macOS 26.0, *) else { fail("--by bundle needs macOS 26") }
            description.bundleIDs = bundleIDs
            description.isProcessRestoreEnabled = true
        }
        // Set explicitly: the aggregate device finds the tap by this UUID.
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted
        var tapID = AudioObjectID(kAudioObjectUnknown)
        Tap.osCheck(AudioHardwareCreateProcessTap(description, &tapID), "AudioHardwareCreateProcessTap")

        let outputUID = Tap.defaultOutputUID()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "gs-capture tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            // Must be false. Measured on macOS 27.0: with true, AudioDeviceStart returns noErr
            // but the IO proc is never called: zero samples, no error, no TCC request.
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true,
                                               kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        Tap.osCheck(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &deviceID), "AudioHardwareCreateAggregateDevice")

        var formatAddr = ProcWatch.address(kAudioTapPropertyFormat)
        var format = AudioStreamBasicDescription()
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        Tap.osCheck(AudioObjectGetPropertyData(tapID, &formatAddr, 0, nil, &formatSize, &format), "tap format")

        // Measure the tap and nothing else. The aggregate also carries the output
        // sub-device, and an output device with inputs (a USB interface) would add its
        // hardware input streams, so a mic could pass for leaked app audio. Refuse to
        // measure unless the tap is the aggregate's only input stream (Codex review, PR 71).
        var streamsAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput,
                                                     mElement: kAudioObjectPropertyElementMain)
        var streamsSize: UInt32 = 0
        Tap.osCheck(AudioObjectGetPropertyDataSize(deviceID, &streamsAddr, 0, nil, &streamsSize), "aggregate input streams")
        let inputStreams = Int(streamsSize) / MemoryLayout<AudioStreamID>.size
        guard inputStreams == 1 else {
            fail("aggregate has \(inputStreams) input streams; the output device adds inputs, so the tap can't be measured alone")
        }
        let meter = meterFor(format)
        let tapChannels = Int(max(format.mChannelsPerFrame, 1))
        var procID: AudioDeviceIOProcID?
        Tap.osCheck(AudioDeviceCreateIOProcIDWithBlock(&procID, deviceID, DispatchQueue(label: "gs-capture.tap")) { _, input, _, _, _ in
            meter.ingest(UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input)), tapChannels: tapChannels)
        }, "AudioDeviceCreateIOProcIDWithBlock")
        guard let procID else { fail("AudioDeviceCreateIOProcIDWithBlock returned no IO proc") }
        return TapSession(tapID: tapID, deviceID: deviceID, procID: procID, description: description,
                          excluded: excluded, format: format)
    }

    func start() { Tap.osCheck(AudioDeviceStart(deviceID, procID), "AudioDeviceStart") }
    func stop() { Tap.osCheck(AudioDeviceStop(deviceID, procID), "AudioDeviceStop") }

    /// Call after stop(): destroying a running device would tear it down mid-callback.
    func destroy() {
        AudioDeviceDestroyIOProcID(deviceID, procID)
        AudioHardwareDestroyAggregateDevice(deviceID)
        AudioHardwareDestroyProcessTap(tapID)
    }
}

enum Tap {
    // How often held windows are released and the rebuild poll is due-checked.
    static let releaseTickMs = 20.0

    static func osCheck(_ status: OSStatus, _ what: String) {
        if status != noErr { fail("\(what) failed, OSStatus \(status)") }
    }

    static func parentPid(_ pid: pid_t) -> pid_t {
        var info = proc_bsdinfo()
        let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        return size == MemoryLayout<proc_bsdinfo>.size ? pid_t(info.pbi_ppid) : -1
    }

    /// A process belongs to a denylisted app if its bundle ID is the app's or starts with
    /// "<app>." (com.github.Electron.helper, com.google.Chrome.helper.renderer), or if its
    /// parent process is the app. Either signal alone has gaps; together they cover both
    /// helper naming conventions seen so far.
    static func denylisted(_ object: AudioObjectID, _ denylist: [String]) -> Bool {
        let bundle = ProcWatch.bundleID(object)
        if denylist.contains(where: { bundle == $0 || bundle.hasPrefix($0 + ".") }) { return true }
        let parent = NSRunningApplication(processIdentifier: parentPid(ProcWatch.pid(object)))?.bundleIdentifier ?? ""
        return denylist.contains(parent)
    }

    static func excludedObjects(_ denylist: [String]) -> [AudioObjectID] {
        ProcWatch.processList().filter { denylisted($0, denylist) }
    }

    static func defaultOutputUID() -> String {
        var addr = ProcWatch.address(kAudioHardwarePropertyDefaultSystemOutputDevice)
        var device = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        osCheck(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device), "default output device")
        var uidAddr = ProcWatch.address(kAudioDevicePropertyDeviceUID)
        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        osCheck(AudioObjectGetPropertyData(device, &uidAddr, 0, nil, &size, &uid), "output device UID")
        return uid!.takeRetainedValue() as String
    }

    static func run(_ args: Args) async {
        let seconds = args.double("seconds", default: 4)
        let denylist = args.list("exclude")
        let followMs = args.string("follow-ms").flatMap(Double.init)
        let rebuildMs = args.string("rebuild-ms").flatMap(Double.init)
        let holdMs = args.double("hold-ms", default: 0)
        // --poll-stop-ms N: no rebuild polls in the last N ms, so a process starting then can
        // only be caught by the shutdown check. A proof control that widens the race on
        // purpose; never used in production.
        let pollStopMs = args.double("poll-stop-ms", default: 0)
        if followMs != nil && rebuildMs != nil { fail("--follow-ms and --rebuild-ms are alternatives; pass one") }
        // Rebuilds are driven by process objects; bundle-only mode tracks none, so a rebuild
        // would never fire and the second-instance leak would stay (Codex review, PR 3a).
        if rebuildMs != nil && args.string("by") == "bundle" { fail("--rebuild-ms needs process objects: use --by both") }
        // A rebuild can only drop what is still held: holding less than two polls would let
        // audio from a new process out before the poll that finds it has run.
        if let rebuildMs, holdMs < rebuildMs * 2 {
            fail("--hold-ms (\(holdMs)) must be at least twice --rebuild-ms (\(rebuildMs))")
        }
        ProcWatch.detachHALFromMainRunLoop()

        // --by bundle (macOS 26+): exclude by bundle ID instead of by process object, so a
        // process that starts AFTER the tap is excluded with no update (live updates to an
        // existing tap are refused with '!hog' on macOS 27.0, measured). Each denylist entry
        // also covers "<id>.helper", the bundle ID Chromium/Electron give their audio helper.
        // --by both: bundle IDs AND the process objects alive now. Measured: with two live
        // process objects under one bundle ID, bundle-only exclusion silenced just one of
        // them (spike-findings.md Q2).
        let byBoth = args.string("by") == "both"
        let byBundle = args.string("by") == "bundle" || byBoth
        // --helpers 0 drops the expansion; the spike uses it to show the expansion is needed.
        let expandHelpers = args.string("helpers") != "0"
        let excludedBundleIDs = denylist.flatMap { expandHelpers ? [$0, "\($0).helper"] : [$0] }
        let objectsNow = { byBundle && !byBoth ? [] : excludedObjects(denylist) }

        var shared: TapMeter?
        let makeSession = { (excluded: [AudioObjectID]) -> TapSession in
            TapSession.make(excluding: excluded, bundleIDs: byBundle ? excludedBundleIDs : nil) { format in
                if let shared { return shared }
                let made = TapMeter(holdMs: holdMs, sampleRate: format.mSampleRate, channels: Int(max(format.mChannelsPerFrame, 1)))
                shared = made
                return made
            }
        }
        var session = makeSession(objectsNow())
        guard let meter = shared else { fail("tap meter was not created") }
        session.start()
        emit(["event": "started", "t": round3(nowMs()), "excludedProcesses": session.excluded.count,
              "excludedBundles": byBundle ? excludedBundleIDs : session.excluded.map(ProcWatch.bundleID),
              "by": byBoth ? "both" : byBundle ? "bundle" : "process", "sampleRate": session.format.mSampleRate,
              "channels": session.format.mChannelsPerFrame, "holdMs": holdMs, "rebuildMs": rebuildMs ?? -1])

        let deadline = nowMs() + seconds * 1000
        var nextCheck = nowMs()
        while nowMs() < deadline {
            if let followMs {
                try? await Task.sleep(nanoseconds: UInt64(followMs * 1_000_000))
                session = follow(session, denylist: denylist)
                meter.release(now: nowMs())
                continue
            }
            guard rebuildMs != nil || holdMs > 0 else {
                try? await Task.sleep(nanoseconds: UInt64((deadline - nowMs()) * 1_000_000))
                break
            }
            try? await Task.sleep(nanoseconds: UInt64(releaseTickMs * 1_000_000))
            if let rebuildMs, nowMs() >= nextCheck, nowMs() < deadline - pollStopMs {
                nextCheck = nowMs() + rebuildMs
                let fresh = objectsNow()
                let added = Set(fresh).subtracting(session.excluded)
                if !added.isEmpty {
                    // Order matters: stop IO first, so nothing reaches the meter after the
                    // drop; then drop what is held; then rebuild around the new processes.
                    let begun = nowMs()
                    session.stop()
                    let dropped = meter.drop()
                    session.destroy()
                    session = makeSession(fresh)
                    session.start()
                    emit(["event": "tapRebuilt", "t": round3(nowMs()), "droppedWindows": dropped,
                          "addedProcesses": added.count, "addedBundles": added.map(ProcWatch.bundleID),
                          "excludedProcesses": fresh.count, "rebuildMs": round3(nowMs() - begun)])
                }
            }
            meter.release(now: nowMs())
        }
        session.stop()
        // The held tail has not been checked yet: a denylisted process that started after the
        // last poll would be in it. Poll once more with IO stopped; release the tail only if
        // nothing new appeared, otherwise drop it (Codex review, PR 3a).
        // --tail-check 0 releases the tail unchecked: the proof's control, like --helpers 0.
        if rebuildMs != nil && args.string("tail-check") != "0" {
            let added = Set(objectsNow()).subtracting(session.excluded)
            if added.isEmpty {
                meter.releaseAll()
            } else {
                let dropped = meter.drop()
                emit(["event": "tailDropped", "t": round3(nowMs()), "droppedWindows": dropped,
                      "addedProcesses": added.count, "addedBundles": added.map(ProcWatch.bundleID)])
            }
        } else {
            meter.releaseAll()
        }
        session.destroy()

        let totals = meter.totals()
        if let mismatch = totals.mismatch {
            let tapChannels = Int(max(session.format.mChannelsPerFrame, 1))
            fail("tap IO delivered \(totals.buffers) buffer(s) with \(mismatch) channels; expected 1 buffer with \(tapChannels)")
        }
        guard totals.samples > 0 else {
            fail("the tap delivered no samples in \(seconds)s (\(totals.callbacks) IO callbacks, \(totals.buffers) buffers each)")
        }
        let rms = sqrt(totals.squares / Double(totals.samples))
        emit(["event": "summary", "samples": totals.samples, "rms": rms, "dbfs": rms > 0 ? round3(20 * log10(rms)) : -999,
              "peak": Double(totals.peak), "excludedProcesses": session.excluded.count, "droppedWindows": totals.dropped])
    }

    /// --follow-ms: re-scan process objects and push an updated exclusion list to the live
    /// tap, so a helper that starts playing mid-stream is excluded (spike Q2).
    static func follow(_ session: TapSession, denylist: [String]) -> TapSession {
        let fresh = excludedObjects(denylist)
        guard Set(fresh) != Set(session.excluded) else { return session }
        let updated = CATapDescription(stereoGlobalTapButExcludeProcesses: fresh)
        updated.uuid = session.description.uuid
        updated.isPrivate = true
        updated.muteBehavior = .unmuted
        var descAddr = ProcWatch.address(kAudioTapPropertyDescription)
        // The property value is the description object reference itself.
        var ref = Unmanaged.passUnretained(updated).toOpaque()
        let size = UInt32(MemoryLayout<UnsafeMutableRawPointer>.size)
        var status = AudioObjectSetPropertyData(session.tapID, &descAddr, 0, nil, size, &ref)
        var restarted = false
        if status != noErr {
            // Measured: a live tap refuses the update ('!hog'); stop IO, update, restart.
            session.stop()
            status = AudioObjectSetPropertyData(session.tapID, &descAddr, 0, nil, size, &ref)
            session.start()
            restarted = true
        }
        osCheck(status, "update tap exclusion list")
        emit(["event": "tapUpdated", "t": round3(nowMs()), "excludedProcesses": fresh.count, "restartedIO": restarted,
              "excludedBundles": fresh.map(ProcWatch.bundleID)])
        return TapSession(tapID: session.tapID, deviceID: session.deviceID, procID: session.procID,
                          description: updated, excluded: fresh, format: session.format)
    }
}
