// WHAT: watches CoreAudio process objects (macOS 14.2+) and emits a JSON line whenever a
// process starts or stops using audio input or output.
// WHY: spike questions 3 and 4 (spec F2, F3). The mic pause and call detection both rest on
// these properties; listeners, not polling, give the real detection latency. Measured on
// macOS 27.0: IsRunningInput/IsRunningOutput listeners never fire, IsRunning does; the
// input/output flags are re-read whenever any listener fires. Each event also
// names the RESPONSIBLE app, because browsers and Electron apps do audio in helper processes
// whose own bundle ID is not the one on a denylist.
import AppKit
import CoreAudio
import Foundation

enum ProcWatch {
    struct State: Equatable { var input: Bool; var output: Bool }

    private static var states: [AudioObjectID: State] = [:]
    private static var watched: Set<AudioObjectID> = []
    private static let queue = DispatchQueue(label: "gs-capture.procwatch")
    private static var debug = false
    private static var names: [AudioObjectID: String] = [:]

    private typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
    // Private libquarantine/libsystem symbol; the spike uses it to map helper → app.
    private static let responsible: ResponsibleFn? = {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
        return unsafeBitCast(symbol, to: ResponsibleFn.self)
    }()

    static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    static func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var addr = address(selector)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
    }

    static func pid(_ object: AudioObjectID) -> pid_t {
        var addr = address(kAudioProcessPropertyPID)
        var value: pid_t = -1
        var size = UInt32(MemoryLayout<pid_t>.size)
        _ = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
        return value
    }

    /// nil when the property can't be read (the object is gone), unlike `pid`'s -1 default.
    static func checkedPid(_ object: AudioObjectID) -> pid_t? {
        var addr = address(kAudioProcessPropertyPID)
        var value: pid_t = -1
        var size = UInt32(MemoryLayout<pid_t>.size)
        return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
    }

    /// nil when the property can't be read; "" is a readable process with no bundle ID.
    static func checkedBundleID(_ object: AudioObjectID) -> String? {
        var addr = address(kAudioProcessPropertyBundleID)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr else { return nil }
        return value.map { $0.takeRetainedValue() as String } ?? ""
    }

    static func bundleID(_ object: AudioObjectID) -> String {
        var addr = address(kAudioProcessPropertyBundleID)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr, let string = value else { return "" }
        return string.takeRetainedValue() as String
    }

    static func processList() -> [AudioObjectID] {
        var addr = address(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else {
            fail("kAudioHardwarePropertyProcessObjectList unavailable on this macOS")
        }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else {
            fail("reading the process object list failed")
        }
        return ids
    }

    static func report(_ object: AudioObjectID, reason: String) {
        let state = State(input: uint32(object, kAudioProcessPropertyIsRunningInput) == 1,
                          output: uint32(object, kAudioProcessPropertyIsRunningOutput) == 1)
        if states[object] == state { return }
        let previous = states[object]
        states[object] = state
        // The first sighting of an idle process is noise; log only real activity changes.
        if previous == nil && !state.input && !state.output { return }
        let processID = pid(object)
        names[object] = bundleID(object)
        let responsiblePid = responsible?(processID) ?? processID
        emit(["t": round3(nowMs()), "reason": reason, "object": object, "pid": processID,
              "bundle": bundleID(object),
              "responsiblePid": responsiblePid,
              "responsibleBundle": NSRunningApplication(processIdentifier: responsiblePid)?.bundleIdentifier ?? "",
              "input": state.input, "output": state.output])
    }

    static func watch(_ object: AudioObjectID) {
        guard !watched.contains(object) else { return }
        watched.insert(object)
        for selector in [kAudioProcessPropertyIsRunningInput, kAudioProcessPropertyIsRunningOutput, kAudioProcessPropertyIsRunning,
                         kAudioProcessPropertyDevices] {
            var addr = address(selector)
            let status = AudioObjectAddPropertyListenerBlock(object, &addr, queue) { _, _ in
                if debug { emit(["debug": "listener", "object": object, "selector": String(format: "%08x", selector), "t": round3(nowMs())]) }
                report(object, reason: "listener")
            }
            if status != noErr { emit(["warning": "listener add failed", "object": object, "status": status]) }
        }
        report(object, reason: "initial")
    }

    /// The HAL delivers notifications (and drives some device work) on the MAIN run loop
    /// unless told otherwise, and an async main never spins it: every listener stayed silent
    /// until this was set (measured). NULL = the HAL's own notification thread.
    static func detachHALFromMainRunLoop() {
        var runLoopAddr = address(kAudioHardwarePropertyRunLoop)
        var noRunLoop: UnsafeRawPointer? = nil
        let runLoopStatus = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &runLoopAddr, 0, nil,
                                                       UInt32(MemoryLayout<UnsafeRawPointer?>.size), &noRunLoop)
        guard runLoopStatus == noErr else { fail("cannot detach HAL notifications from the main run loop, status \(runLoopStatus)") }
    }

    static func run(_ args: Args) async {
        let seconds = args.double("seconds", default: 60)
        debug = args.string("debug") == "1"
        detachHALFromMainRunLoop()
        queue.sync { processList().forEach(watch) }
        var listAddr = address(kAudioHardwarePropertyProcessObjectList)
        let status = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &listAddr, queue) { _, _ in
            if debug { emit(["debug": "process list changed", "t": round3(nowMs())]) }
            let current = processList()
            current.forEach(watch)
            // An exiting process drops out of the list without a final IsRunning change.
            for object in watched.subtracting(current) {
                if let last = states[object], last.input || last.output {
                    emit(["t": round3(nowMs()), "reason": "gone", "object": object, "input": false, "output": false,
                          "bundle": names[object] ?? ""])
                }
                watched.remove(object)
                states[object] = nil
            }
        }
        guard status == noErr else { fail("cannot listen for process list changes, status \(status)") }
        emit(["event": "watching", "t": round3(nowMs()), "processes": watched.count, "responsibleLookup": responsible != nil])
        // --poll-ms N re-reads every process on a timer as well, so the spike can tell a
        // listener that never fires from a property that never changes.
        if let pollMs = args.string("poll-ms").flatMap(Double.init) {
            let deadline = nowMs() + seconds * 1000
            while nowMs() < deadline {
                try? await Task.sleep(nanoseconds: UInt64(pollMs * 1_000_000))
                queue.sync { processList().forEach { object in watch(object); report(object, reason: "poll") } }
            }
        } else {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
        emit(["event": "done", "t": round3(nowMs())])
    }
}
