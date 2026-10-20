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

/// Where a tap's samples go. One sink is shared by every tap session of a run, so a rebuild
/// changes the session, never the sink. `ingest` runs on the tap's IO queue; the rest run on
/// the caller's control queue.
protocol TapSink: AnyObject {
    func ingest(_ buffers: UnsafeMutableAudioBufferListPointer, tapChannels: Int)
    /// Samples delivered so far, across every session.
    func sampleCount() -> Int
    /// Release everything held at least the hold time before `now`.
    func release(now: Double)
    func releaseAll()
    /// Discard everything held. `windows` counts 100 ms windows and `maxRms` is the loudest,
    /// so a proof can tell a drop that discarded real audio from one that discarded silence.
    func drop() -> (windows: Int, maxRms: Double)
}

/// RMS per 100 ms window, held back `holdMs` before release. Shared by every tap session of
/// one run, so totals span rebuilds.
final class TapMeter: TapSink, @unchecked Sendable {
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

    /// Discard everything held, including the window in progress.
    func drop() -> (windows: Int, maxRms: Double) {
        lock.lock()
        defer { lock.unlock() }
        let count = pending.count
        let maxRms = pending.map(\.rms).max() ?? 0
        dropped += count
        pending.removeAll()
        squares = 0
        self.count = 0
        return (count, maxRms)
    }

    func releaseAll() { release(now: .infinity) }

    /// Samples delivered so far, across every session; a session's own count is the
    /// difference from its baseline.
    func sampleCount() -> Int { lock.withLock { total } }

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

    /// `sinkFor` returns the run's sink, creating it from the first session's format.
    static func make(excluding excluded: [AudioObjectID], bundleIDs: [String]?,
                     sinkFor: (AudioStreamBasicDescription) -> TapSink) -> TapSession {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
        if let bundleIDs {
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
        let sink = sinkFor(format)
        let tapChannels = Int(max(format.mChannelsPerFrame, 1))
        var procID: AudioDeviceIOProcID?
        Tap.osCheck(AudioDeviceCreateIOProcIDWithBlock(&procID, deviceID, DispatchQueue(label: "gs-capture.tap")) { _, input, _, _, _ in
            sink.ingest(UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input)), tapChannels: tapChannels)
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
    // A rebuilt tap must deliver samples this soon. AudioDeviceStart returning noErr is not
    // evidence of delivery (see TapAutoStart below), and the shared meter's totals would hide
    // a silent replacement behind the previous session's samples (Codex review, PR 3a).
    static let sessionDeliveryDeadlineMs = 1000.0
    // A session this short may end before its first IO cycle (about 10 ms each), so a
    // missing sample proves nothing; it is reported as unverified instead of passed.
    static let minVerifiableSessionMs = 200.0
    // A classifier this far behind means held audio can't be judged; the run fails rather
    // than holding (and buffering) without bound (spec R3 wants an error within 10 s).
    static let arrivalsStallMs = 5000.0

    static func osCheck(_ status: OSStatus, _ what: String) {
        if status != noErr { fail("\(what) failed, OSStatus \(status)") }
    }

    /// What `proc_pidinfo` says about a process. Measured on macOS 27.0: another user's
    /// daemon is refused with EPERM; an exited process, INCLUDING an unreaped zombie, fails
    /// with ESRCH. `kill(pid, 0)` can't tell these apart, because it succeeds for a zombie (Codex
    /// review of PR #79, round 3), so liveness and "another user's process" come from here.
    enum Lookup: Equatable {
        case parent(pid_t)
        case otherUser
        case gone
    }

    static func lookup(_ pid: pid_t) -> Lookup {
        var info = proc_bsdinfo()
        errno = 0
        let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        if size == MemoryLayout<proc_bsdinfo>.size { return .parent(pid_t(info.pbi_ppid)) }
        return errno == EPERM ? .otherUser : .gone
    }

    /// -1 when the parent can't be read (another user's process, or gone).
    static func parentPid(_ pid: pid_t) -> pid_t {
        if case .parent(let parent) = lookup(pid) { return parent }
        return -1
    }

    /// A process belongs to a denylisted app if its bundle ID is the app's or starts with
    /// "<app>." (com.github.Electron.helper, com.google.Chrome.helper.renderer), or if its
    /// parent process is the app. Either signal alone has gaps; together they cover both
    /// helper naming conventions seen so far.
    enum Classification: Equatable { case denylisted(String), allowed, unreadable }

    /// The arrivals listener's snapshot read. Unlike `denylisted`, every property read is
    /// status-checked: nil means the process is already gone (unreadable), never "allowed"
    /// (Codex review of PR 3b-2, round 4).
    static func identity(_ object: AudioObjectID) -> ProcessIdentity? {
        guard let pid = ProcWatch.checkedPid(object), pid > 0,
              let bundle = ProcWatch.checkedBundleID(object) else { return nil }
        // Gone (a zombie included) stays unreadable: fail closed. Only a positive EPERM marks
        // another user's process (measured: every such daemon here, 5-6 of 35-37 objects).
        switch lookup(pid) {
        case .parent(let parent): return ProcessIdentity(pid: pid, bundle: bundle, parent: parent)
        case .otherUser: return ProcessIdentity(pid: pid, bundle: bundle, parent: -1, otherUser: true)
        case .gone: return ProcessIdentity(pid: pid, bundle: bundle, parent: -1)
        }
    }

    /// The arrivals listener's judgement, on its judge queue: the same rule as `denylisted`.
    static func judge(_ identity: ProcessIdentity, _ denylist: [String]) -> Classification {
        classify(bundle: identity.bundle, parent: identity.parent, otherUser: identity.otherUser, parentBundle: { pid in
            NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        }, parentAlive: processAlive, denylist)
    }

    /// Alive and not a zombie (see `lookup`).
    static func processAlive(_ pid: pid_t) -> Bool { lookup(pid) != .gone }

    /// The pure half, testable: `parent` is -1 when the parent could not be read.
    static func classify(bundle: String, parent: pid_t, otherUser: Bool = false, parentBundle: (pid_t) -> String?,
                         parentAlive: (pid_t) -> Bool, _ denylist: [String]) -> Classification {
        if denylist.contains(where: { bundle == $0 || bundle.hasPrefix($0 + ".") }) { return .denylisted(bundle) }
        if otherUser { return .allowed }
        guard parent > 0 else { return .unreadable }
        if let parentID = parentBundle(parent) {
            return denylist.contains(parentID) ? .denylisted(parentID) : .allowed
        }
        // No bundle ID: a parent that is not an app (launchd, a shell), OR a denylisted
        // parent that exited before the lookup (Codex review of PR 3b-2, round 5). Checked
        // AFTER the lookup: a parent alive now was alive during it, so its nil is a real
        // "not an app". A gone parent proves nothing either way.
        return parentAlive(parent) ? .allowed : .unreadable
    }

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
        let followMs = args.optionalDouble("follow-ms")
        let rebuildMs = args.optionalDouble("rebuild-ms")
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
        // --listen 0 turns the arrivals listener off: the proof's control for a process that
        // starts and exits between polls (Codex review of PR 3b-2), like --helpers 0.
        // --classify-delay-ms N slows every classification on purpose, so the proof can make a
        // pass still be in flight when audio would be released (Codex review of PR 3b-2,
        // round 5). --release-cap 0 releases by the clock instead of the last completed pass:
        // the control for that proof. Both are proof-only.
        let classifyDelayMs = args.double("classify-delay-ms", default: 0)
        let arrivals = rebuildMs != nil && !denylist.isEmpty && args.string("listen") != "0"
            ? ProcessArrivals(identify: identity, judge: { identity in
                if classifyDelayMs > 0 { usleep(useconds_t(classifyDelayMs * 1000)) }
                return judge(identity, denylist)
            }) : nil
        let runner = TapRunner(objectsNow: objectsNow, bundleIDs: byBundle ? excludedBundleIDs : nil, rebuildMs: rebuildMs,
                               arrivals: arrivals, capRelease: args.string("release-cap") != "0", report: { event, fields in emit(fields.merging(["event": event]) { _, new in new }) }) { format in
            if let shared { return shared }
            let made = TapMeter(holdMs: holdMs, sampleRate: format.mSampleRate, channels: Int(max(format.mChannelsPerFrame, 1)))
            shared = made
            return made
        }
        guard let meter = shared else { fail("tap meter was not created") }
        emit(["event": "started", "t": round3(nowMs()), "excludedProcesses": runner.session.excluded.count,
              "excludedBundles": byBundle ? excludedBundleIDs : runner.session.excluded.map(ProcWatch.bundleID),
              "by": byBoth ? "both" : byBundle ? "bundle" : "process", "sampleRate": runner.session.format.mSampleRate,
              "channels": runner.session.format.mChannelsPerFrame, "holdMs": holdMs, "rebuildMs": rebuildMs ?? -1])

        let deadline = nowMs() + seconds * 1000
        while nowMs() < deadline {
            if let followMs {
                try? await Task.sleep(nanoseconds: UInt64(followMs * 1_000_000))
                runner.session = follow(runner.session, denylist: denylist)
                meter.release(now: nowMs())
                continue
            }
            guard rebuildMs != nil || holdMs > 0 else {
                try? await Task.sleep(nanoseconds: UInt64((deadline - nowMs()) * 1_000_000))
                break
            }
            try? await Task.sleep(nanoseconds: UInt64(releaseTickMs * 1_000_000))
            let polling = nowMs() < deadline - pollStopMs
            let limit = runner.tick(poll: polling)
            // While polls are suppressed (--poll-stop-ms), hold everything: the shutdown check
            // must judge the whole unpolled span, not just its last --hold-ms (Codex, PR 3a).
            if polling { meter.release(now: limit) }
        }
        // --tail-check 0 releases the tail unchecked: the proof's control, like --helpers 0.
        runner.finish(tailCheck: rebuildMs != nil && args.string("tail-check") != "0")
        let session = runner.session

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

/// What can be read about a process while it is alive: captured the moment it is observed,
/// so judging it later never depends on it still existing.
struct ProcessIdentity: Equatable {
    let pid: pid_t
    let bundle: String
    /// -1 when the parent could not be read.
    let parent: pid_t
    /// The parent could not be read but the process is alive: another user's process (a
    /// system daemon such as systemsoundserverd). It can't be a child of the user's denylisted
    /// app, so it is judged by its own bundle only (Codex review of PR #79, round 2).
    var otherUser = false
}

/// Observes every CoreAudio process object the moment the HAL reports it added, so a
/// denylisted process that starts, plays and exits between two polls is still caught.
/// WHY (Codex review of PR 3b-2, P1): a poll compares only the objects alive *now*, so a
/// helper that lives under one poll interval leaves both snapshots identical.
///
/// Two queues (Codex review of PR #78, round 1). The **snapshot** queue takes HAL
/// notifications and reads only what must be read while the process lives: the list, and each
/// new object's pid, bundle ID and parent. The **judge** queue does the slower part, the
/// parent's app lookup. A slow judgement can't stop the next arrival being observed.
///
/// Release is capped (round 5): every observed arrival is an outstanding ticket whose bound is
/// the *previous* snapshot's start, the last moment it provably was not in the list. Audio
/// may be released only up to the oldest outstanding bound, or the last snapshot's start when
/// none is outstanding. A ticket leaves under the same lock that publishes its flag.
///
/// Anything unreadable counts as denylisted: a wrong drop costs 0.5 s of audio, a wrong
/// release writes audio from an app the user excluded. Measured on macOS 27.0: the HAL sends
/// every list notification twice, about 1 ms apart, so a notification with no change is
/// normal. RESIDUAL: an object added and removed inside the snapshot's ~1 ms read latency
/// leaves no trace; it would have had to produce audio in that time.
final class ProcessArrivals: @unchecked Sendable {
    static let unclassified = "unclassified"

    /// A verdict that forces a drop: the object it is about, and a bundle ID or `unclassified`.
    struct Flag: Equatable {
        let object: AudioObjectID
        let label: String
    }

    private let snapshotQueue = DispatchQueue(label: "gs-capture.arrivals.snapshot")
    private let judgeQueue = DispatchQueue(label: "gs-capture.arrivals.judge")
    private let identify: (AudioObjectID) -> ProcessIdentity?
    private let judge: (ProcessIdentity) -> Tap.Classification
    private let list: () -> [AudioObjectID]
    // Touched only on the snapshot queue.
    private var known: Set<AudioObjectID> = []
    private var lastSnapshotStart: Double = 0
    // Guarded by `lock`.
    private let lock = NSLock()
    private var flagged: [Flag] = []
    // Objects judged denylisted or unreadable, while they are still in the list. A rebuild
    // must keep excluding them: a re-poll may no longer tie them to the denylist (a helper
    // whose denylisted parent exited), and the snapshot already counts them as known, so
    // nothing else would ever exclude them again (Codex review of PR #78, round 2).
    private var denied: Set<AudioObjectID> = []
    private var snapshotThrough: Double
    private var outstanding: [Int: Double] = [:]
    private var nextTicket = 0
    private var passRequested = false
    private var listener: AudioObjectPropertyListenerBlock?

    /// `list` and `listen` exist for tests: production reads the HAL and listens to it.
    init(identify: @escaping (AudioObjectID) -> ProcessIdentity?,
         judge: @escaping (ProcessIdentity) -> Tap.Classification,
         list: @escaping () -> [AudioObjectID] = ProcWatch.processList, listen: Bool = true) {
        self.identify = identify
        self.judge = judge
        self.list = list
        snapshotThrough = nowMs()
        if listen {
            let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.observe() }
            var addr = ProcWatch.address(kAudioHardwarePropertyProcessObjectList)
            let status = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, snapshotQueue, block)
            guard status == noErr else { fail("cannot listen for process list changes, status \(status)") }
            listener = block
        }
        // The baseline, taken after the listener is in place and on its queue, so no add
        // falls between.
        snapshotQueue.sync {
            let started = nowMs()
            known = Set(list())
            lastSnapshotStart = started
            lock.withLock { snapshotThrough = started }
        }
    }

    /// Ask for a snapshot without waiting, so the limit advances when nothing notifies. At
    /// most one is queued.
    func requestPass() {
        let enqueue = lock.withLock {
            defer { passRequested = true }
            return !passRequested
        }
        guard enqueue else { return }
        snapshotQueue.async { [self] in
            lock.withLock { passRequested = false }
            observe()
        }
    }

    /// Audio may be released only up to here: every process added earlier has been judged and
    /// its flag published.
    func checked() -> Double {
        lock.withLock { min(snapshotThrough, outstanding.values.min() ?? .infinity) }
    }

    /// Denied objects still alive at the last snapshot: always part of a rebuild's exclusion.
    func deniedLive() -> [AudioObjectID] { lock.withLock { Array(denied) } }

    /// What was flagged since the last call.
    func take() -> [Flag] {
        lock.withLock {
            defer { flagged = [] }
            return flagged
        }
    }

    /// One more snapshot, then wait until every judgement queued so far has finished. False
    /// when that takes longer than `timeoutMs`: the caller must treat what it holds as unjudged.
    func settle(timeoutMs: Double) -> Bool {
        let done = DispatchSemaphore(value: 0)
        snapshotQueue.async { [self] in
            observe()
            // The judge queue is serial: this runs after every judgement observe() queued.
            judgeQueue.async { done.signal() }
        }
        return done.wait(timeout: .now() + .milliseconds(Int(timeoutMs))) == .success
    }

    func stop() {
        guard let listener else { return }
        var addr = ProcWatch.address(kAudioHardwarePropertyProcessObjectList)
        AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, snapshotQueue, listener)
        self.listener = nil
    }

    /// On the snapshot queue.
    private func observe() {
        let started = nowMs()
        // Not in the previous snapshot's list, so added after that snapshot started.
        let notBefore = lastSnapshotStart
        let current = Set(list())
        let added = current.subtracting(known)
        known = current
        lastSnapshotStart = started
        // Read while the process is (probably) still alive. nil: it is already gone.
        let identities = added.map { (object: $0, identity: identify($0)) }
        var work: [(ticket: Int, object: AudioObjectID, identity: ProcessIdentity)] = []
        // Tickets are registered in the same critical section that advances the snapshot
        // limit, so the limit never passes an observed arrival that has no ticket yet.
        lock.withLock {
            // A denied object that left the list can't produce audio any more.
            denied.formIntersection(current)
            for (object, identity) in identities {
                guard let identity else {
                    flagged.append(Flag(object: object, label: ProcessArrivals.unclassified))
                    denied.insert(object)
                    continue
                }
                outstanding[nextTicket] = notBefore
                work.append((nextTicket, object, identity))
                nextTicket += 1
            }
            snapshotThrough = max(snapshotThrough, started)
        }
        for item in work {
            judgeQueue.async { [self] in
                let verdict = judge(item.identity)
                lock.withLock {
                    switch verdict {
                    case .denylisted(let bundle):
                        flagged.append(Flag(object: item.object, label: bundle))
                        denied.insert(item.object)
                    case .unreadable:
                        flagged.append(Flag(object: item.object, label: ProcessArrivals.unclassified))
                        denied.insert(item.object)
                    case .allowed: break
                    }
                    outstanding[item.ticket] = nil
                }
            }
        }
    }
}

/// The PR 3a rebuild loop, shared by `tap` (the proof command) and `run` (production), so the
/// second-instance fix and its proof cover one implementation. The caller owns timing: it
/// calls `tick` every `Tap.releaseTickMs`, releases its sink, and calls `finish` once.
/// Not thread-safe: call it from one queue.
final class TapRunner {
    private let objectsNow: () -> [AudioObjectID]
    private let makeSession: ([AudioObjectID]) -> TapSession
    private let rebuildMs: Double?
    private let report: (String, [String: Any]) -> Void
    private let arrivals: ProcessArrivals?
    private let capRelease: Bool
    // Arrivals taken while polling was suppressed; they still force a drop at finish.
    private var pendingArrivals: [ProcessArrivals.Flag] = []
    let sink: TapSink
    /// Settable only for the spike's --follow-ms path, which updates the tap in place.
    var session: TapSession
    // The current session's start and the sample count it started from.
    private var sessionStart: Double
    private var sessionBaseline: Int
    private var nextCheck: Double
    // When the sample count last moved. Delivery that stops after it started (an output
    // device unplugged) must fail too, not only a session that never delivered (Codex
    // review of PR 3b-2: the screenshot heartbeat would otherwise mask the loss).
    private var lastCount: Int
    private var lastAdvance: Double

    /// Builds and starts the first session. `sinkFor` is called once per session with the
    /// tap's format and must return the same sink every time.
    /// `arrivals`, when given, adds listener-driven rebuilds to the poll (see ProcessArrivals).
    init(objectsNow: @escaping () -> [AudioObjectID], bundleIDs: [String]?, rebuildMs: Double?,
         arrivals: ProcessArrivals? = nil, capRelease: Bool = true,
         report: @escaping (String, [String: Any]) -> Void,
         sinkFor: @escaping (AudioStreamBasicDescription) -> TapSink) {
        self.objectsNow = objectsNow
        self.rebuildMs = rebuildMs
        self.arrivals = arrivals
        self.capRelease = capRelease
        self.report = report
        var first: TapSink?
        makeSession = { excluded in
            TapSession.make(excluding: excluded, bundleIDs: bundleIDs) { format in
                let sink = sinkFor(format)
                if first == nil { first = sink }
                return sink
            }
        }
        session = makeSession(TapRunner.exclusion(polled: objectsNow(), denied: arrivals?.deniedLive() ?? []))
        guard let first else { fail("the tap sink was not created") }
        sink = first
        session.start()
        sessionStart = nowMs()
        sessionBaseline = sink.sampleCount()
        nextCheck = nowMs()
        lastCount = sessionBaseline
        lastAdvance = sessionStart
    }

    /// Rebuild around any new denylisted process (when `poll` and a poll is due), then fail
    /// if delivery has not advanced for `Tap.sessionDeliveryDeadlineMs`.
    /// What a (re)built tap must exclude: the polled denylisted processes, every object the
    /// arrivals listener denied, and everything the previous session excluded that is still
    /// alive. Once excluded by ANY path, an object stays excluded until it leaves the process
    /// list: a re-poll may no longer tie it to the denylist (a helper whose denylisted parent
    /// exited), and nothing else would exclude it again (Codex review of PR #78, rounds 2-3).
    static func exclusion(polled: [AudioObjectID], denied: [AudioObjectID],
                          previous: [AudioObjectID] = [], alive: Set<AudioObjectID> = []) -> [AudioObjectID] {
        Array(Set(polled).union(denied).union(Set(previous).intersection(alive))).sorted()
    }

    /// Every object this runner treats as denylisted right now: the session's exclusion and
    /// the listener's denied set (which can be ahead of the next rebuild). Control queue only.
    func knownDenied() -> Set<AudioObjectID> {
        Set(session.excluded).union(arrivals?.deniedLive() ?? [])
    }

    private func exclusionNow() -> [AudioObjectID] {
        TapRunner.exclusion(polled: objectsNow(), denied: arrivals?.deniedLive() ?? [],
                            previous: session.excluded, alive: Set(ProcWatch.processList()))
    }

    /// Returns the time the caller may release held audio up to. It is read at ENTRY, before
    /// any flag is taken: a flag published by a pass at or before this limit is then always
    /// taken (and dropped on) here, before the caller releases. Without arrivals it is simply
    /// now; with them it is capped at the last completed classification pass.
    @discardableResult
    func tick(poll: Bool) -> Double {
        let now = nowMs()
        var limit = now
        if let arrivals {
            let checked = arrivals.checked()
            if now - checked > Tap.arrivalsStallMs {
                fail("process arrivals have gone unjudged for \(Int(now - checked)) ms")
            }
            if capRelease { limit = min(now, checked) }
            arrivals.requestPass()
        }
        pendingArrivals += arrivals?.take() ?? []
        // An arrival forces the check now, not at the next due poll: its audio is already in
        // the hold and must be dropped before the caller's next release.
        // Recorded for the proofs: whether the scheduled poll was due at this check.
        let pollDue = poll && rebuildMs != nil && nowMs() >= nextCheck
        if poll, let rebuildMs, pollDue || !pendingArrivals.isEmpty {
            nextCheck = nowMs() + rebuildMs
            let fresh = exclusionNow()
            let added = Set(fresh).subtracting(session.excluded)
            let arrived = pendingArrivals
            pendingArrivals = []
            if !added.isEmpty || !arrived.isEmpty {
                // Read now, before the rebuild, while the new processes most likely live.
                let addedBundles = added.map(ProcWatch.bundleID)
                // Order matters: stop IO first, so nothing reaches the sink after the drop;
                // then drop what is held; then rebuild around the new processes.
                let begun = nowMs()
                session.stop()
                endSession("rebuild")
                let dropped = sink.drop()
                session.destroy()
                session = makeSession(fresh)
                session.start()
                sessionStart = nowMs()
                sessionBaseline = sink.sampleCount()
                lastCount = sessionBaseline
                lastAdvance = sessionStart
                report("tapRebuilt", ["t": round3(nowMs()), "droppedWindows": dropped.windows,
                                      "droppedMaxRms": dropped.maxRms, "trigger": arrived.isEmpty ? "poll" : "listener",
                                      "pollDue": pollDue, "arrivedBundles": arrived.map(\.label),
                                      "addedProcesses": added.count, "addedBundles": addedBundles,
                                      "excludedProcesses": fresh.count, "excludedPids": fresh.map { Int(ProcWatch.pid($0)) },
                                      "rebuildMs": round3(nowMs() - begun)])
            }
        }
        // AudioDeviceStart returning noErr is not evidence of delivery (see TapAutoStart), and
        // the shared sink's totals would hide a silent replacement behind the previous
        // session's samples (Codex review, PR 3a).
        let count = sink.sampleCount()
        if count != lastCount {
            lastCount = count
            lastAdvance = nowMs()
        } else if nowMs() - lastAdvance >= Tap.sessionDeliveryDeadlineMs {
            fail(count == sessionBaseline
                 ? "the tap delivered no samples in \(Int(Tap.sessionDeliveryDeadlineMs)) ms after it was (re)built"
                 : "the tap stopped delivering samples for \(Int(nowMs() - lastAdvance)) ms")
        }
        return limit
    }

    /// Stop IO and settle the held tail. The tail has not been checked yet: a denylisted
    /// process that started after the last poll would be in it. With `tailCheck`, poll once
    /// more with IO stopped and release the tail only if nothing new appeared, otherwise drop
    /// it (Codex review, PR 3a). Without it the tail is released unchecked.
    func finish(tailCheck: Bool) {
        session.stop()
        endSession("shutdown")
        // Settle the listener first: an arrival just before the stop must count. The tick (and
        // its stall check) has stopped, so the wait has its own deadline; past it the tail
        // is unjudged and is dropped, never released (Codex review of PR #78, round 1).
        var arrived = pendingArrivals
        var unjudged = false
        if let arrivals {
            unjudged = !arrivals.settle(timeoutMs: Tap.arrivalsStallMs)
            arrived += arrivals.take()
            arrivals.stop()
        }
        if tailCheck {
            let added = Set(exclusionNow()).subtracting(session.excluded)
            if added.isEmpty && arrived.isEmpty && !unjudged {
                sink.releaseAll()
            } else {
                let dropped = sink.drop()
                report("tailDropped", ["t": round3(nowMs()), "droppedWindows": dropped.windows,
                                       "droppedMaxRms": dropped.maxRms, "arrivedBundles": arrived.map(\.label), "unjudged": unjudged,
                                       "addedProcesses": added.count, "addedBundles": added.map(ProcWatch.bundleID)])
            }
        } else {
            sink.releaseAll()
        }
        session.destroy()
    }

    /// Every session is judged when it ends (a rebuild or shutdown), not only once it has
    /// lived a full deadline: a silent session in the last second would otherwise pass on
    /// the previous session's samples (Codex review, PR 3a, final check).
    private func endSession(_ why: String) {
        let lived = nowMs() - sessionStart
        guard sink.sampleCount() == sessionBaseline else { return }
        if lived >= Tap.minVerifiableSessionMs {
            fail("the tap delivered no samples in its \(Int(lived)) ms session (ended by \(why))")
        }
        report("sessionUnverified", ["t": round3(nowMs()), "livedMs": round3(lived), "endedBy": why])
    }
}
