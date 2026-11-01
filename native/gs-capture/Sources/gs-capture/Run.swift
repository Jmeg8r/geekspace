// WHAT: `gs-capture run`, the production capture process the Electron supervisor spawns.
// It takes a screenshot every --shot-sec, keeps only frames that changed, writes them as HEIC
// under <media-root>/<day>/, runs OCR on them off the capture loop (OCRQueue.swift), and
// reports each one as a protocol-v1 JSON line
// (docs/changes/2026-10-18-day-recorder/protocol.md). System audio is written alongside as
// segments (Segments.swift, PR 3b-2).
// WHY one long-lived process: TCC grants, the SCK watchdog and the denylist apply to one
// signed binary, and the supervisor only has to watch one child (spec R3).
import AppKit
import CoreGraphics
import Foundation

enum Run {
    static let protocolVersion = 1
    // The supervisor treats a silent helper as hung (spec R3: an error within 10 s), so the
    // heartbeat comes well inside that.
    static let heartbeatSec = 5.0
    // Settled in the spike (Q6): a 32-wide dHash and a Hamming distance of 8 skip unchanged
    // screens without dropping a changed paragraph.
    static let hashGrid = 32
    static let skipHamming = 8
    static let heicQuality = 0.6
    // Point resolution (scale 1) was settled for OCR in the spike (Q5).
    static let captureScale = 1.0
    // The menu bar is a Window Server window at this layer (kCGMainMenuWindowLevel). Measured
    // on macOS 27.0: one window, 0,0 1920x30 points on the main display.
    static let menuBarLayer = 24
    // Same shape the Convex boundary accepts (convex/lib/dayRecorder.ts).
    static let bundleIDPattern = #"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$"#
    static let defaultSegmentSec = 300.0
    // Below this a segment is mostly AAC priming and container overhead.
    static let minSegmentSec = 2.0
    // Frames waiting for or in OCR. At 1920x1080 points a frame is ~8 MB, so this bounds the
    // backlog at ~32 MB while still riding out a ~36 s first OCR at the default 30 s interval.
    static let ocrBacklog = 4
    // On SIGTERM: the supervisor's stop grace is 8 s and the audio tail can take 5 s, so OCR
    // in flight gets 2 s. A shot not announced by then is an orphan file the purge sweeps.
    static let ocrDrainOnSignalSec = 2.0
    // A proof's --duration run waits for every shot, as the inline OCR used to.
    static let ocrDrainOnDurationSec = 60.0
    static let ocr = OCRQueue(capacity: ocrBacklog)

    static func line(_ event: String, _ fields: [String: Any] = [:], terminal: Bool = false) {
        var object = fields
        object["v"] = protocolVersion
        object["event"] = event
        emit(object, terminal: terminal)
    }

    /// The denylist rule the tap uses too: the app itself or any "<app>." helper bundle.
    static func denylisted(_ bundle: String?, _ denylist: [String]) -> Bool {
        guard let bundle else { return false }
        return denylist.contains { bundle == $0 || bundle.hasPrefix($0 + ".") }
    }

    /// What to do with a frame's menu bar. Blank it whenever ANY app is denylisted.
    /// WHY always, not only when a denylisted app owns it (Codex review of PR 3b-1, rounds 1
    /// and 2): ownership can only be sampled around a capture, never during it, so a switch
    /// allowed → denylisted → allowed while the capture is in flight puts the denylisted app's
    /// menus in the frame with both samples saying "allowed". The menu bar has no owning app,
    /// so the SCK filter can't remove it. Blanking every frame closes that whole class; the
    /// cost is the menu-bar strip (app menus, clock, status icons), not window content.
    /// The app is named only when both samples agree on it and neither is denylisted.
    static func menuBarDecision(before: String?, after: String?, denylist: [String]) -> (blank: Bool, appBundleId: String?) {
        let named = denylisted(before, denylist) || denylisted(after, denylist) || before != after ? nil : before
        return (!denylist.isEmpty, named)
    }

    /// The menu bar's on-screen rects in global points. Excluding an app cannot remove them:
    /// the menu bar has no owning app (spike Q1), so while a denylisted app owns it, it is
    /// blanked instead.
    static func menuBarRects() -> [CGRect] {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        return windows.compactMap { window in
            guard (window[kCGWindowLayer as String] as? Int) == menuBarLayer,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds) else { return nil }
            return rect
        }
    }

    /// `image` with every rect (global points, top-left origin, main display at 0,0) painted
    /// black. Fails rather than returning the unblanked frame.
    static func blank(_ image: CGImage, rects: [CGRect], scale: Double) -> CGImage {
        let width = image.width, height = image.height
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            fail("cannot create blanking context \(width)x\(height)")
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        for rect in rects {
            // CoreGraphics draws bottom-up; window bounds are top-down.
            let pixels = CGRect(x: rect.minX * scale, y: Double(height) - rect.maxY * scale,
                                width: rect.width * scale, height: rect.height * scale)
            context.fill(pixels)
        }
        guard let blanked = context.makeImage() else { fail("cannot read back the blanked frame") }
        return blanked
    }

    static func dayAndFile(_ date: Date, prefix: String = "shot", ext: String = "heic",
                           timeZone: TimeZone = .current) -> (day: String, file: String) {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        let day = formatter.string(from: date)
        formatter.dateFormat = "HHmmss-SSS"
        // The local part is for people; the epoch makes the name unique, because local time
        // repeats in the DST fall-back hour. Truncated, as SSS is.
        let epochMs = Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
        return (day, "\(prefix)-\(formatter.string(from: date))-\(epochMs).\(ext)")
    }

    /// The supervisor's commands, one per line on stdin (protocol.md "Commands"). An unknown
    /// or out-of-order command is a supervisor bug, so it fails the run rather than guess.
    static func readCommands(_ audio: SystemAudioRecorder) {
        Thread.detachNewThread {
            while let command = readLine() {
                switch command {
                case "call hold": audio.holdCall()
                case "call release": audio.releaseCall()
                case "call discard": audio.discardCall()
                case "call clear": audio.clearCall()
                default: fail("unknown command on stdin: \(command.prefix(40))")
                }
            }
        }
    }

    static func run(_ args: Args) async {
        let root = args.required("media-root")
        var isDir: ObjCBool = false
        guard root.hasPrefix("/"), FileManager.default.fileExists(atPath: root, isDirectory: &isDir), isDir.boolValue else {
            fail("--media-root must be an existing absolute directory, got \(root)")
        }
        let denylist = args.list("denylist")
        for id in denylist where id.range(of: bundleIDPattern, options: .regularExpression) == nil {
            fail("--denylist entry is not a bundle id: \(id)")
        }
        let shotSec = args.double("shot-sec", default: 30)
        // SEGMENT_SEC (spec R2). A smaller value is for proofs.
        let segmentSec = args.double("segment-sec", default: defaultSegmentSec)
        guard segmentSec >= minSegmentSec else { fail("--segment-sec must be at least \(minSegmentSec), got \(segmentSec)") }
        // --duration is for proofs; the supervisor runs the helper until it stops it.
        let duration = args.optionalDouble("duration")

        // The supervisor stops the helper with SIGTERM (a denylist change is a restart), so a
        // signal must finalize the open segment, not lose it. Default handlers are replaced
        // first, or the signal would kill the process before the source sees it. Installed
        // BEFORE `ready`: the supervisor may stop the helper the moment it is ready (Codex
        // review of PR 3b-2, round 5).
        let signals = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler {
                // Noted before taking shutdownLock: a --duration stop may already hold it while
                // draining OCR, and this shortens that drain to the signal allowance.
                noteSignal()
                shutdown(reason: "signal")
            }
            source.resume()
            return source
        }
        line("ready", ["pid": Int(getpid()), "shotSec": shotSec, "segmentSec": segmentSec, "denylist": denylist])
        ProcWatch.detachHALFromMainRunLoop()
        // How long a call may wait for its notice (CallHold.swift); the supervisor sets it.
        let maxCallSec = args.double("call-hold-max-sec", default: CallHold.defaultMaxSec)
        // A helper started while a call waits for its notice or was declined holds from its first
        // sample, so the call never reaches a sys- file (plan PR 4b).
        let startHeld: Bool
        switch args.string("start-held") {
        case nil: startHeld = false
        case "yes": startHeld = true
        // A malformed value must never read as "don't hold" (the --rebuild-ms lesson, PR 3a).
        case let other?: fail("--start-held takes yes, got \(other)")
        }
        let audio = SystemAudioRecorder(root: root, denylist: denylist, segmentSec: segmentSec, maxCallSec: maxCallSec,
                                        startHeld: startHeld) { event, fields in
            line(event, fields)
        }
        adopt(audio)
        readCommands(audio)
        Task.detached {
            while true {
                try? await Task.sleep(nanoseconds: UInt64(heartbeatSec * 1_000_000_000))
                // A heartbeat means "capture still authorised", not just "process alive": a
                // permission revoked just after a shot would otherwise go unnoticed until the
                // next one, up to --shot-sec later (Codex review of PR 3b-1; spec R3 wants an
                // error within 10 s). Screen.content() is the call every capture depends on,
                // and it exits non-zero on failure or after its 10 s watchdog. UNVERIFIED: that
                // it fails promptly after a live revocation is PR 3c's R3 proof.
                _ = await Screen.content()
                line("heartbeat", ["t": round3(nowMs())])
            }
        }

        let started = nowMs()
        let expired = { duration.map { nowMs() - started >= $0 * 1000 } ?? false }
        var lastKept: [Bool]?
        capture: while !expired() {
            let tickStart = nowMs()
            // A slot first, so a frame is never taken without room to read it. Normally free;
            // while the backlog is full the loop waits rather than dropping a frame, but never
            // past a proof's --duration (Codex #82 r1).
            while !ocr.tryReserve() {
                if expired() { break capture }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            if expired() {
                ocr.release()
                break
            }
            let takenAt = Date()
            let ownerBefore = NSWorkspace.shared.menuBarOwningApplication?.bundleIdentifier
            var (image, _, _) = await Screen.capture(excluding: denylist, scale: captureScale)
            let ownerAfter = NSWorkspace.shared.menuBarOwningApplication?.bundleIdentifier
            let decision = menuBarDecision(before: ownerBefore, after: ownerAfter, denylist: denylist)
            if decision.blank {
                let rects = menuBarRects()
                // Never keep a frame whose menu bar could not be found to blank.
                guard !rects.isEmpty else { fail("an app is denylisted, but no menu-bar window was found to blank") }
                image = blank(image, rects: rects, scale: captureScale)
            }
            let hash = Screen.dHash(image, grid: hashGrid)
            if let lastKept, Screen.hamming(lastKept, hash) <= skipHamming {
                // Unchanged: nothing to report, and no OCR to queue.
                ocr.release()
            } else {
                let (day, file) = dayAndFile(takenAt)
                let dir = "\(root)/\(day)"
                do {
                    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
                    // A kill mid-write must never leave a truncated image behind, and a
                    // repeated name must never replace an earlier shot.
                    try writeWithoutReplacing(Screen.encode(image, heic: true, quality: heicQuality),
                                              to: URL(fileURLWithPath: "\(dir)/\(file)"))
                } catch {
                    fail("cannot write \(day)/\(file): \(error.localizedDescription)")
                }
                lastKept = hash
                let frame = image
                let fields: [String: Any] = [
                    "day": day, "path": "\(day)/\(file)", "takenAt": round3(takenAt.timeIntervalSince1970 * 1000),
                    // A denylisted app's id is not recorded either: when it was in use is
                    // information too (plan.md, PR 3b-1). Null also when the owner changed.
                    "appBundleId": decision.appBundleId.map { $0 as Any } ?? NSNull(),
                    "menuBarBlanked": decision.blank,
                ]
                ocr.submit {
                    let text = OCR.recognizeMerged(frame)
                    line("shot", fields.merging(["ocrText": text.text, "ocrMs": round3(text.ms)]) { $1 })
                }
            }
            var wait = shotSec * 1000 - (nowMs() - tickStart)
            // A proof's --duration must not overrun by up to a whole --shot-sec.
            if let duration { wait = min(wait, duration * 1000 - (nowMs() - started)) }
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000)) }
        }
        // The signal sources must outlive the loop; shutdown never returns.
        withExtendedLifetime(signals) { shutdown(reason: "duration") }
    }

    /// Once only: a signal can arrive while --duration is finishing. The second caller blocks
    /// here until the first one exits the process. Guards `recorder` too.
    private static let shutdownLock = NSLock()
    private static var recorder: SystemAudioRecorder?
    // When a stop signal arrived; its own lock, never shutdownLock.
    private static let signalLock = NSLock()
    private static var signalledAt: Date?

    static func noteSignal() { signalLock.withLock { signalledAt = signalledAt ?? Date() } }

    /// Hand the started recorder to shutdown. If a stop is already in progress, this blocks
    /// until that stop exits the process.
    static func adopt(_ audio: SystemAudioRecorder) { shutdownLock.withLock { recorder = audio } }

    /// A stop before `adopt` (during startup) has no recorder to stop, and nothing to lose:
    /// the first segment needs the 500 ms hold to pass before anything is written.
    static func shutdown(reason: String) -> Never {
        shutdownLock.lock()
        recorder?.stop()
        // After the audio, which matters more: shots still in OCR get a bounded wait.
        let base = Date().addingTimeInterval(reason == "signal" ? ocrDrainOnSignalSec : ocrDrainOnDurationSec)
        let deadline = {
            signalLock.withLock { signalledAt.map { min(base, $0.addingTimeInterval(ocrDrainOnSignalSec)) } ?? base }
        }
        if !ocr.drain(until: deadline) {
            FileHandle.standardError.write("gs-capture: OCR still running at stop; its shots stay unannounced\n".data(using: .utf8)!)
        }
        line("stopped", ["reason": reason], terminal: true)
        exit(0)
    }
}
