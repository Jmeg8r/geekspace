// WHAT: `audioUse` events for `run` (plan PR 3b-3): which apps are using audio input or
// output, for PR 4's mic pause (spec F2) and call detection (spec F3).
// WHY polled: on macOS 27.0 the IsRunningInput/IsRunningOutput listeners never fire, and
// nothing fires for mic use at all; a 100 ms poll detects it in -26 to +125 ms for 1.2% of
// one core (spike-findings.md Q3).
// WHY denylisted apps are anonymous: F2 only needs to know that SOME denylisted app is using
// audio, and when a work app was in use is information too (the 3b-1 rule for screenshots).
// So allowed apps are reported by name, and every denylisted app is folded into one
// unnamed entry.
import AppKit
import CoreAudio
import Foundation

enum AudioUse {
    // Our own capture shows up as audio use: replayd reports input while an SCK audio stream
    // is open, and avconferenced reported input for a whole session with no call (Q3, Q4).
    static let ignoredBundles: Set<String> = ["com.apple.replayd", "com.apple.avconferenced"]
    /// The most a poll lags the start of audio use: detection took -26 to +125 ms (spike Q3).
    static let detectionLagMs = 125.0

    struct State: Equatable {
        var input = false
        var output = false
        var active: Bool { input || output }
    }

    enum Key: Hashable {
        case app(String)
        case denylisted
    }

    /// One audio process, as read in a poll.
    struct Process: Equatable {
        let pid: pid_t
        let parent: pid_t
        let bundle: String
        /// The owning app: the process's own app, else its parent's, else its bundle ID.
        let app: String
        let input: Bool
        let output: Bool
        /// In the tap's current exclusion, or matched by the denylist rule.
        let denylisted: Bool
    }

    /// Geekspace's own processes never count: the helper itself, and the supervisor (its
    /// parent) with everything the supervisor started (Electron's renderer records the mic).
    static func ignored(_ process: Process, ownPid: pid_t, supervisorPid: pid_t) -> Bool {
        ignoredBundles.contains(process.bundle) || process.pid == ownPid
            || process.pid == supervisorPid || process.parent == supervisorPid
    }

    /// Whether a process counts as denylisted: it is in the tap's exclusion or the arrivals
    /// listener's denied set, or its own bundle, its owning app, or its PARENT's app matches
    /// the denylist. The parent is checked even when the process is an app itself, as the
    /// tap's rule does (Codex review of PR #79: a child with its own bundle ID under a
    /// denylisted parent could otherwise be named before the tap's exclusion caught up).
    ///
    /// A parent that can't be read is NOT treated as denylisted. Measured on macOS 27.0: 6 of
    /// 37 process objects (systemsoundserverd, mediaremoted, audiomxd...) are other users'
    /// daemons whose parent is unreadable, and folding them in would pause the mic on every
    /// alert sound. A daemon can't be a child of a user's denylisted app. A process whose own
    /// info is unreadable because it exited is skipped in `poll`. A live child whose parent
    /// exited reads its new parent (launchd), and is covered by `known`.
    static func isDenylisted(bundle: String, app: String, parentApp: String?, known: Bool, denylist: [String]) -> Bool {
        known || Run.denylisted(bundle, denylist) || Run.denylisted(app, denylist) || Run.denylisted(parentApp, denylist)
    }

    /// Fold processes into one state per key. Apps with no name are dropped: they can be
    /// neither a call app nor denylisted (a denylisted orphan is caught by the tap's
    /// exclusion and folded into `.denylisted`).
    static func aggregate(_ processes: [Process]) -> [Key: State] {
        var states: [Key: State] = [:]
        for process in processes where process.input || process.output {
            let key: Key
            if process.denylisted {
                key = .denylisted
            } else if !process.app.isEmpty {
                key = .app(process.app)
            } else {
                continue
            }
            var state = states[key] ?? State()
            state.input = state.input || process.input
            state.output = state.output || process.output
            states[key] = state
        }
        return states
    }

    /// The changes between two polls, keys in a stable order. A key that disappeared is
    /// reported as no longer using audio.
    static func changes(from old: [Key: State], to new: [Key: State]) -> [(key: Key, state: State)] {
        let keys = Set(old.keys).union(new.keys).sorted { describe($0) < describe($1) }
        return keys.compactMap { key in
            let before = old[key] ?? State()
            let after = new[key] ?? State()
            return before == after ? nil : (key, after)
        }
    }

    /// Which call apps are in a call, by the supervisor's rule (electron/callDetector.mjs): a
    /// dedicated call app using audio in or out, a browser once it holds the mic. A call ends
    /// when the app uses neither. Never-record apps are folded into `.denylisted`, so they are
    /// no call (spec F2 pauses the mic for them instead).
    struct CallTracker {
        let apps: Set<String>
        let browsers: Set<String>
        private(set) var inCall: Set<String> = []

        init(apps: Set<String>, browsers: Set<String>) {
            self.apps = apps
            self.browsers = browsers
        }

        /// The apps that started a call since the last poll, sorted.
        mutating func update(_ current: [Key: State]) -> [String] {
            var started: [String] = []
            var now: Set<String> = []
            for (key, state) in current {
                guard case .app(let app) = key, apps.contains(app) || browsers.contains(app) else { continue }
                if inCall.contains(app) ? state.active : (state.input || (state.output && apps.contains(app))) {
                    now.insert(app)
                    if !inCall.contains(app) { started.append(app) }
                }
            }
            inCall = now
            return started.sorted()
        }
    }

    static func describe(_ key: Key) -> String {
        switch key {
        case .app(let app): return "app:\(app)"
        case .denylisted: return "denylisted"
        }
    }

    /// The protocol-v1 fields for one change.
    static func fields(_ key: Key, _ state: State, t: Double) -> [String: Any] {
        var fields: [String: Any] = ["t": round3(t), "input": state.input, "output": state.output]
        switch key {
        case .app(let app):
            fields["app"] = app
            fields["denylisted"] = false
        case .denylisted:
            fields["app"] = NSNull()
            fields["denylisted"] = true
        }
        return fields
    }

    /// Read every CoreAudio process object now. Objects that vanish mid-read are skipped:
    /// a process that is gone is not using audio.
    /// `known` is every object the tap excludes or the arrivals listener has denied.
    static func poll(denylist: [String], known: Set<AudioObjectID>) -> [Process] {
        ProcWatch.processList().compactMap { object in
            guard let pid = ProcWatch.checkedPid(object), pid > 0,
                  let bundle = ProcWatch.checkedBundleID(object) else { return nil }
            let input = ProcWatch.uint32(object, kAudioProcessPropertyIsRunningInput) == 1
            let output = ProcWatch.uint32(object, kAudioProcessPropertyIsRunningOutput) == 1
            // ONE lookup per process, and the parent comes from it: a second lookup could see
            // the process gone and throw away a readable denylisted parent (Codex review of
            // PR #79, round 4). Gone (a zombie included) has exited, so it is not using audio.
            let parent: pid_t
            switch Tap.lookup(pid) {
            case .parent(let readable): parent = readable
            case .otherUser: parent = -1
            case .gone: return nil
            }
            let parentApp = parent > 0 ? NSRunningApplication(processIdentifier: parent)?.bundleIdentifier : nil
            let app = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? parentApp ?? bundle
            let denylisted = isDenylisted(bundle: bundle, app: app, parentApp: parentApp,
                                          known: known.contains(object), denylist: denylist)
            return Process(pid: pid, parent: parent, bundle: bundle, app: app, input: input, output: output,
                           denylisted: denylisted)
        }
    }
}

/// Polls audio use and reports changes. Driven from the audio control queue, so it reads the
/// tap's exclusion without a lock.
final class AudioUseWatcher {
    static let pollMs = 100.0

    private let denylist: [String]
    private let ownPid = getpid()
    private let supervisorPid = getppid()
    private let report: (String, [String: Any]) -> Void
    private var last: [AudioUse.Key: AudioUse.State] = [:]
    private var nextPoll = 0.0
    private var announcedReady = false
    private var calls: AudioUse.CallTracker
    private let startHeld: Bool
    private let onCallStart: (String, Double) -> Void

    /// `onCallStart(app, t)`: a call app started using audio at or after `t` (plan PR 4b).
    /// With `startHeld`, calls already going on at the first poll are the startup hold's.
    init(denylist: [String], calls: AudioUse.CallTracker = AudioUse.CallTracker(apps: [], browsers: []),
         startHeld: Bool = false, onCallStart: @escaping (String, Double) -> Void = { _, _ in },
         report: @escaping (String, [String: Any]) -> Void) {
        self.denylist = denylist
        self.calls = calls
        self.startHeld = startHeld
        self.onCallStart = onCallStart
        self.report = report
    }

    /// Call often; polls at most every `pollMs`.
    func tick(known: Set<AudioObjectID>) {
        let now = nowMs()
        guard now >= nextPoll else { return }
        nextPoll = now + AudioUseWatcher.pollMs
        let processes = AudioUse.poll(denylist: denylist, known: known)
            .filter { !AudioUse.ignored($0, ownPid: ownPid, supervisorPid: supervisorPid) }
        let current = AudioUse.aggregate(processes)
        for change in AudioUse.changes(from: last, to: current) {
            report("audioUse", AudioUse.fields(change.key, change.state, t: now))
        }
        last = current
        // Held from before this poll saw the app, so none of the call's opening audio is
        // system audio (Codex review of PR 4b, round 3).
        let started = calls.update(current)
        if announcedReady || !startHeld {
            for app in started { onCallStart(app, now - SystemAudioRecorder.callLookbackMs) }
        }
        // Once: everything using audio at start has now been reported. Until this line the
        // supervisor treats any app as possibly in a call (plan PR 4b), so it is a count only.
        if !announcedReady {
            announcedReady = true
            report("audioUseReady", ["t": round3(now), "apps": current.count])
        }
    }
}
