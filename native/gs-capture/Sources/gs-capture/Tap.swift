// WHAT: system audio through a CoreAudio process tap (macOS 14.2+) that excludes every audio
// process belonging to a denylisted app, including its helper processes.
// WHY: the spike found ScreenCaptureKit's app filter does not remove audio that Chromium and
// Electron apps play from a windowless helper process (Q2, -15 dBFS leaked). CoreAudio sees
// those helpers as their own process objects, so a tap can name them for exclusion.
import AppKit
import AudioToolbox
import CoreAudio
import Foundation

enum Tap {
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
        ProcWatch.detachHALFromMainRunLoop()
        var excluded = excludedObjects(denylist)

        // --by bundle (macOS 26+): exclude by bundle ID instead of by process object, so a
        // process that starts AFTER the tap is excluded with no update (live updates to an
        // existing tap are refused with '!hog' on macOS 27.0, measured). Each denylist entry
        // also covers "<id>.helper", the bundle ID Chromium/Electron give their audio helper.
        // --by both: bundle IDs AND the process objects alive now. Measured: with two live
        // process objects under one bundle ID, bundle-only exclusion silenced just one of
        // them (spike-findings.md Q2).
        let byBoth = args.string("by") == "both"
        let byBundle = args.string("by") == "bundle" || byBoth
        if byBundle && !byBoth { excluded = [] }
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
        // --helpers 0 drops the expansion; the spike uses it to show the expansion is needed.
        let expandHelpers = args.string("helpers") != "0"
        let excludedBundleIDs = denylist.flatMap { expandHelpers ? [$0, "\($0).helper"] : [$0] }
        if byBundle {
            guard #available(macOS 26.0, *) else { fail("--by bundle needs macOS 26") }
            description.bundleIDs = excludedBundleIDs
            description.isProcessRestoreEnabled = true
        }
        // Set explicitly: the aggregate device finds the tap by this UUID.
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted
        var tapID = AudioObjectID(kAudioObjectUnknown)
        osCheck(AudioHardwareCreateProcessTap(description, &tapID), "AudioHardwareCreateProcessTap")
        defer { AudioHardwareDestroyProcessTap(tapID) }

        let outputUID = defaultOutputUID()
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
        osCheck(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &deviceID), "AudioHardwareCreateAggregateDevice")
        defer { AudioHardwareDestroyAggregateDevice(deviceID) }

        var formatAddr = ProcWatch.address(kAudioTapPropertyFormat)
        var format = AudioStreamBasicDescription()
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        osCheck(AudioObjectGetPropertyData(tapID, &formatAddr, 0, nil, &formatSize, &format), "tap format")

        let lock = NSLock()
        var squares = 0.0, count = 0, totalSquares = 0.0, total = 0, peak: Float = 0
        var callbacks = 0, bufferCount = 0
        let windowSize = Int(format.mSampleRate) / 10 * Int(max(format.mChannelsPerFrame, 1))
        var procID: AudioDeviceIOProcID?
        osCheck(AudioDeviceCreateIOProcIDWithBlock(&procID, deviceID, DispatchQueue(label: "gs-capture.tap")) { _, input, _, _, _ in
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
            lock.lock()
            defer { lock.unlock() }
            callbacks += 1
            bufferCount = buffers.count
            for buffer in buffers {
                guard let data = buffer.mData else { continue }
                let floats = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self),
                                                 count: Int(buffer.mDataByteSize) / MemoryLayout<Float>.size)
                for value in floats {
                    squares += Double(value * value)
                    totalSquares += Double(value * value)
                    peak = max(peak, abs(value))
                    count += 1
                    total += 1
                    if count == windowSize {
                        emit(["t": round3(nowMs()), "windowRms": sqrt(squares / Double(count))])
                        squares = 0
                        count = 0
                    }
                }
            }
        }, "AudioDeviceCreateIOProcIDWithBlock")
        osCheck(AudioDeviceStart(deviceID, procID), "AudioDeviceStart")
        if args.string("debug") == "1" {
            var streamsAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput,
                                                         mElement: kAudioObjectPropertyElementMain)
            var streamsSize: UInt32 = 0
            AudioObjectGetPropertyDataSize(deviceID, &streamsAddr, 0, nil, &streamsSize)
            try? await Task.sleep(nanoseconds: 300_000_000)
            emit(["debug": "aggregate", "deviceID": deviceID, "tapID": tapID,
                  "inputStreams": Int(streamsSize) / MemoryLayout<AudioStreamID>.size,
                  "running": ProcWatch.uint32(deviceID, kAudioDevicePropertyDeviceIsRunning) ?? 999,
                  "runningSomewhere": ProcWatch.uint32(deviceID, kAudioDevicePropertyDeviceIsRunningSomewhere) ?? 999,
                  "tapUID": description.uuid.uuidString])
        }
        emit(["event": "started", "t": round3(nowMs()), "excludedProcesses": excluded.count,
              "excludedBundles": byBundle ? excludedBundleIDs : excluded.map(ProcWatch.bundleID), "by": byBoth ? "both" : byBundle ? "bundle" : "process", "sampleRate": format.mSampleRate,
              "channels": format.mChannelsPerFrame])

        // --follow-ms: re-scan process objects and push an updated exclusion list to the
        // live tap, so a helper that starts playing mid-stream is excluded.
        let deadline = nowMs() + seconds * 1000
        while nowMs() < deadline {
            guard let followMs else {
                try? await Task.sleep(nanoseconds: UInt64((deadline - nowMs()) * 1_000_000))
                break
            }
            try? await Task.sleep(nanoseconds: UInt64(followMs * 1_000_000))
            let fresh = excludedObjects(denylist)
            if Set(fresh) != Set(excluded) {
                let updated = CATapDescription(stereoGlobalTapButExcludeProcesses: fresh)
                updated.uuid = description.uuid
                updated.isPrivate = true
                updated.muteBehavior = .unmuted
                var descAddr = ProcWatch.address(kAudioTapPropertyDescription)
                // The property value is the description object reference itself.
                var ref = Unmanaged.passUnretained(updated).toOpaque()
                let size = UInt32(MemoryLayout<UnsafeMutableRawPointer>.size)
                var status = AudioObjectSetPropertyData(tapID, &descAddr, 0, nil, size, &ref)
                var restarted = false
                if status != noErr {
                    // Measured: a live tap refuses the update ('!hog'); stop IO, update, restart.
                    osCheck(AudioDeviceStop(deviceID, procID), "AudioDeviceStop before tap update")
                    status = AudioObjectSetPropertyData(tapID, &descAddr, 0, nil, size, &ref)
                    osCheck(AudioDeviceStart(deviceID, procID), "AudioDeviceStart after tap update")
                    restarted = true
                }
                osCheck(status, "update tap exclusion list")
                excluded = fresh
                emit(["event": "tapUpdated", "t": round3(nowMs()), "excludedProcesses": fresh.count, "restartedIO": restarted,
                      "excludedBundles": fresh.map(ProcWatch.bundleID)])
            }
        }
        osCheck(AudioDeviceStop(deviceID, procID), "AudioDeviceStop")
        AudioDeviceDestroyIOProcID(deviceID, procID!)

        let (sampleCount, sumSquares, maxAbs, ioCallbacks, buffersPerCallback) = lock.withLock { (total, totalSquares, peak, callbacks, bufferCount) }
        guard sampleCount > 0 else {
            fail("the tap delivered no samples in \(seconds)s (\(ioCallbacks) IO callbacks, \(buffersPerCallback) buffers each)")
        }
        let rms = sqrt(sumSquares / Double(sampleCount))
        emit(["event": "summary", "samples": sampleCount, "rms": rms, "dbfs": rms > 0 ? round3(20 * log10(rms)) : -999,
              "peak": Double(maxAbs), "excludedProcesses": excluded.count])
    }
}
