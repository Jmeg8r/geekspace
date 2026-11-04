// WHAT: tests for gs-capture's pure decisions: menu-bar masking across an app switch, and
// the position-based OCR merge. Run with `swift test` in native/gs-capture.
// WHY pure functions: the races they guard against (a switch while a capture is in flight)
// can't be hit on demand in a live run. See Codex review of PR 3b-1.
import CoreAudio
import CoreGraphics
import XCTest
@testable import gs_capture

final class MenuBarDecisionTests: XCTestCase {
    let denylist = ["com.example.work"]

    func testAnyDenylistBlanksEveryFrame() {
        // Covers allowed -> denylisted -> allowed DURING a capture: both samples say
        // TextEdit, and the frame is still blanked (Codex review of PR 3b-1, round 2).
        let d = Run.menuBarDecision(before: "com.apple.TextEdit", after: "com.apple.TextEdit", denylist: denylist)
        XCTAssertTrue(d.blank)
        XCTAssertEqual(d.appBundleId, "com.apple.TextEdit")
    }

    func testEmptyDenylistBlanksNothing() {
        let d = Run.menuBarDecision(before: "com.apple.TextEdit", after: "com.apple.TextEdit", denylist: [])
        XCTAssertFalse(d.blank)
        XCTAssertEqual(d.appBundleId, "com.apple.TextEdit")
    }

    func testSwitchToDenylistedDuringCaptureNamesNoApp() {
        let d = Run.menuBarDecision(before: "com.apple.TextEdit", after: "com.example.work", denylist: denylist)
        XCTAssertTrue(d.blank)
        XCTAssertNil(d.appBundleId)
    }

    func testSwitchAwayFromDenylistedNamesNoApp() {
        let d = Run.menuBarDecision(before: "com.example.work", after: "com.apple.TextEdit", denylist: denylist)
        XCTAssertTrue(d.blank)
        XCTAssertNil(d.appBundleId)
    }

    func testDenylistedHelperBundleIsNotNamed() {
        let d = Run.menuBarDecision(before: "com.example.work.helper", after: "com.example.work.helper", denylist: denylist)
        XCTAssertTrue(d.blank)
        XCTAssertNil(d.appBundleId)
    }

    func testSwitchBetweenAllowedAppsNamesNeither() {
        let d = Run.menuBarDecision(before: "com.apple.TextEdit", after: "com.apple.finder", denylist: denylist)
        XCTAssertNil(d.appBundleId)
    }

    func testPrefixWithoutDotIsNotTheApp() {
        // "com.example.workshop" is a different app, not a helper of com.example.work.
        let d = Run.menuBarDecision(before: "com.example.workshop", after: "com.example.workshop", denylist: denylist)
        XCTAssertEqual(d.appBundleId, "com.example.workshop")
    }
}

final class OCRMergeTests: XCTestCase {
    // Normalised boxes, origin bottom-left: a higher y is nearer the top of the screen.
    func line(_ text: String, x: Double, y: Double, w: Double = 0.2, h: Double = 0.02) -> OCR.Line {
        OCR.Line(text: text, box: CGRect(x: x, y: y, width: w, height: h))
    }

    func testRepeatedTextAtDifferentPlacesIsKept() {
        let plain = [line("Task A", x: 0.1, y: 0.9), line("Pending", x: 0.1, y: 0.86),
                     line("Task B", x: 0.1, y: 0.8), line("Pending", x: 0.1, y: 0.76)]
        XCTAssertEqual(OCR.merge(plain, []).map(\.text), ["Task A", "Pending", "Task B", "Pending"])
    }

    func testSameLineFromBothPassesAppearsOnce() {
        let plain = [line("Allow notifications", x: 0.1, y: 0.9)]
        let extra = [line("Allow notifications", x: 0.101, y: 0.899)]
        XCTAssertEqual(OCR.merge(plain, extra).map(\.text), ["Allow notifications"])
    }

    func testSecondPassOnlyLineKeepsItsPlace() {
        // The grey secondary label sits between two black ones; it must not go to the end.
        let plain = [line("Allow time-sensitive alerts", x: 0.1, y: 0.9), line("Show previews", x: 0.1, y: 0.8)]
        let extra = [line("Stays on screen until you dismiss it", x: 0.12, y: 0.86)]
        XCTAssertEqual(OCR.merge(plain, extra).map(\.text),
                       ["Allow time-sensitive alerts", "Stays on screen until you dismiss it", "Show previews"])
    }

    func testRowReadsLeftToRight() {
        let plain = [line("Total", x: 0.6, y: 0.5), line("Revenue", x: 0.1, y: 0.505)]
        XCTAssertEqual(OCR.merge(plain, []).map(\.text), ["Revenue", "Total"])
    }

    func testDifferentTextAtTheSamePlaceIsTheSameLine() {
        // A second-pass misread of a line the first pass already has must not be added.
        let plain = [line("Inbox (12)", x: 0.1, y: 0.9)]
        let extra = [line("Inbox (l2)", x: 0.1, y: 0.9)]
        XCTAssertEqual(OCR.merge(plain, extra).map(\.text), ["Inbox (12)"])
    }
}

/// The arrivals listener's classification (Codex review of PR 3b-2, round 4): anything that
/// can't be read must come out `unreadable`, which the listener treats as denylisted.
final class ArrivalClassificationTests: XCTestCase {
    let denylist = ["com.example.work"]
    let noApps: (pid_t) -> String? = { _ in nil }
    let alive: (pid_t) -> Bool = { _ in true }

    func testDenylistedBundleAndHelper() {
        XCTAssertEqual(Tap.classify(bundle: "com.example.work", parent: 1, parentBundle: noApps, parentAlive: alive, denylist), .denylisted("com.example.work"))
        XCTAssertEqual(Tap.classify(bundle: "com.example.work.helper", parent: 1, parentBundle: noApps, parentAlive: alive, denylist),
                       .denylisted("com.example.work.helper"))
    }

    func testChildOfADenylistedAppIsDenylisted() {
        let parentIsWork: (pid_t) -> String? = { $0 == 42 ? "com.example.work" : nil }
        XCTAssertEqual(Tap.classify(bundle: "", parent: 42, parentBundle: parentIsWork, parentAlive: alive, denylist), .denylisted("com.example.work"))
    }

    func testAnUnreadableParentIsUnreadableNotAllowed() {
        // The process exited between reading its bundle and reading its parent.
        XCTAssertEqual(Tap.classify(bundle: "", parent: -1, parentBundle: noApps, parentAlive: alive, denylist), .unreadable)
    }

    func testAParentThatExitedBeforeItsLookupIsUnreadable() {
        // Codex review of PR 3b-2, round 5: a denylisted parent that exits between reading its
        // pid and resolving its app looks exactly like a non-app parent. Gone means unknown.
        XCTAssertEqual(Tap.classify(bundle: "", parent: 42, parentBundle: noApps, parentAlive: { _ in false }, denylist), .unreadable)
    }

    func testAnotherUsersDaemonIsJudgedByItsOwnBundle() {
        // Codex review of PR #79, round 2: a system daemon arriving after the baseline has an
        // unreadable parent but is alive. It must not be denied (the tap would exclude its
        // audio and audioUse would pause the mic), unless its own bundle is denylisted.
        XCTAssertEqual(Tap.classify(bundle: "systemsoundserverd", parent: -1, otherUser: true, parentBundle: noApps,
                                    parentAlive: alive, denylist), .allowed)
        XCTAssertEqual(Tap.classify(bundle: "com.example.work", parent: -1, otherUser: true, parentBundle: noApps,
                                    parentAlive: alive, denylist), .denylisted("com.example.work"))
        // Unreadable because it is gone: still fail-closed.
        XCTAssertEqual(Tap.classify(bundle: "", parent: -1, otherUser: false, parentBundle: noApps,
                                    parentAlive: alive, denylist), .unreadable)
    }

    func testAParentThatIsNotAnAppIsAllowed() {
        XCTAssertEqual(Tap.classify(bundle: "com.apple.TextEdit", parent: 1, parentBundle: noApps, parentAlive: alive, denylist), .allowed)
    }
}

/// The release cap and the snapshot/judge split (Codex review of PR 3b-2 round 5, and of
/// PR #78 round 1): audio may be released only up to the oldest unjudged arrival, and a slow
/// judgement must not stop the next arrival being observed.
final class ArrivalsReleaseCapTests: XCTestCase {
    /// Object 1 is always present. Object N > 1 is "com.example.work" when even, else allowed.
    func identify(_ object: AudioObjectID) -> ProcessIdentity? {
        ProcessIdentity(pid: pid_t(object), bundle: object % 2 == 0 ? "com.example.work" : "", parent: 1)
    }

    func verdict(_ identity: ProcessIdentity) -> Tap.Classification {
        identity.bundle.isEmpty ? .allowed : .denylisted(identity.bundle)
    }

    func waitFor(_ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(2)
        while !condition() && Date() < deadline { usleep(1000) }
    }

    func testAJudgedArrivalPublishesItsFlagAndFreesTheLimit() {
        var objects: [AudioObjectID] = [1]
        let arrivals = ProcessArrivals(identify: identify, judge: verdict, list: { objects }, listen: false)
        objects = [1, 2]
        XCTAssertTrue(arrivals.settle(timeoutMs: 1000))
        XCTAssertEqual(arrivals.take().map(\.label), ["com.example.work"])
        let limit = arrivals.checked()
        arrivals.requestPass()
        waitFor { arrivals.checked() > limit }
        XCTAssertGreaterThan(arrivals.checked(), limit)
    }

    func testASlowJudgementHoldsTheLimitAtItsArrivalsBound() {
        var objects: [AudioObjectID] = [1]
        let gate = DispatchSemaphore(value: 0)
        let arrivals = ProcessArrivals(identify: identify, judge: { [self] in gate.wait(); return verdict($0) },
                                       list: { objects }, listen: false)
        let baseline = arrivals.checked()
        objects = [1, 3]
        arrivals.requestPass()
        usleep(50_000)
        // Snapshots keep running while object 3 is judged, but the limit stays at 3's bound.
        for _ in 0..<5 { arrivals.requestPass(); usleep(10_000) }
        XCTAssertEqual(arrivals.checked(), baseline)
        gate.signal()
        waitFor { arrivals.checked() > baseline }
        XCTAssertGreaterThan(arrivals.checked(), baseline)
    }

    func testBLivingEntirelyDuringASlowJudgementOfAIsStillCaught() {
        // A (3, allowed) is slow to judge. B (4, denylisted) appears and is gone again before
        // A's judgement ends. With one queue for both, B was never observed (PR #78 round 1).
        var objects: [AudioObjectID] = [1]
        let gate = DispatchSemaphore(value: 0)
        let arrivals = ProcessArrivals(identify: identify, judge: { [self] identity in
            if identity.pid == 3 { gate.wait() }
            return verdict(identity)
        }, list: { objects }, listen: false)
        objects = [1, 3]
        arrivals.requestPass()
        usleep(30_000)
        objects = [1, 3, 4]
        arrivals.requestPass()
        usleep(30_000)
        objects = [1, 3]
        arrivals.requestPass()
        usleep(30_000)
        XCTAssertEqual(arrivals.take().map(\.label), [], "nothing is judged while A is stuck")
        gate.signal()
        XCTAssertTrue(arrivals.settle(timeoutMs: 1000))
        XCTAssertEqual(arrivals.take().map(\.label), ["com.example.work"])
    }

    func testSettleGivesUpOnAStuckJudgement() {
        var objects: [AudioObjectID] = [1]
        let gate = DispatchSemaphore(value: 0)
        let arrivals = ProcessArrivals(identify: identify, judge: { [self] in gate.wait(); return verdict($0) },
                                       list: { objects }, listen: false)
        objects = [1, 2]
        XCTAssertFalse(arrivals.settle(timeoutMs: 100), "shutdown must not wait forever on a stuck judgement")
        gate.signal()
    }

    func testAHelperWhoseDenylistedParentExitedStaysExcludedWhileItLives() {
        // Codex review of PR #78, round 2: helper 5 (no bundle ID) is observed while its
        // denylisted parent 99 lives, and judged after the parent exited: unreadable. A
        // re-poll can no longer tie it to the denylist, so the arrivals listener must keep it
        // in every rebuild's exclusion for as long as it stays in the list.
        var objects: [AudioObjectID] = [1]
        let arrivals = ProcessArrivals(
            identify: { ProcessIdentity(pid: pid_t($0), bundle: "", parent: $0 == 5 ? 99 : 1) },
            judge: { identity in
                Tap.classify(bundle: identity.bundle, parent: identity.parent, parentBundle: { _ in nil },
                             parentAlive: { $0 != 99 }, ["com.example.work"])
            }, list: { objects }, listen: false)
        objects = [1, 5]
        XCTAssertTrue(arrivals.settle(timeoutMs: 1000))
        XCTAssertEqual(arrivals.take(), [ProcessArrivals.Flag(object: 5, label: ProcessArrivals.unclassified)])
        // The poll sees nothing denylisted any more; the rebuild still excludes the helper.
        XCTAssertEqual(TapRunner.exclusion(polled: [], denied: arrivals.deniedLive()), [5])
        // Several snapshots later, still alive: still excluded.
        for _ in 0..<3 { XCTAssertTrue(arrivals.settle(timeoutMs: 1000)) }
        XCTAssertEqual(arrivals.deniedLive(), [5])
        // Gone from the list: no longer excluded (it can't produce audio).
        objects = [1]
        XCTAssertTrue(arrivals.settle(timeoutMs: 1000))
        XCTAssertEqual(arrivals.deniedLive(), [])
    }

    func testExclusionIsThePollPlusDeniedObjects() {
        XCTAssertEqual(TapRunner.exclusion(polled: [3, 1], denied: [5, 3]), [1, 3, 5])
    }

    func testAnythingExcludedBeforeStaysExcludedWhileAlive() {
        // Codex review of PR #78, round 3: helper 5 was excluded by the initial poll (its
        // denylisted parent lived), never judged by the listener, and orphaned since. A
        // rebuild for an unrelated arrival re-polls without it; it must stay excluded.
        XCTAssertEqual(TapRunner.exclusion(polled: [7], denied: [7], previous: [5], alive: [1, 5, 7]), [5, 7])
        // Gone from the process list: dropped from the exclusion.
        XCTAssertEqual(TapRunner.exclusion(polled: [7], denied: [7], previous: [5], alive: [1, 7]), [7])
    }

    func testADaemonArrivingAfterTheBaselineIsNotDenied() {
        // The end-to-end shape of the round-2 finding: object 9 arrives after the baseline,
        // alive, parent unreadable (another user's daemon). It must not reach the denied set,
        // which feeds both the tap's exclusion and audioUse.
        var objects: [AudioObjectID] = [1]
        let arrivals = ProcessArrivals(
            identify: { ProcessIdentity(pid: pid_t($0), bundle: $0 == 9 ? "systemsoundserverd" : "", parent: $0 == 9 ? -1 : 1,
                                        otherUser: $0 == 9) },
            judge: { Tap.classify(bundle: $0.bundle, parent: $0.parent, otherUser: $0.otherUser, parentBundle: { _ in nil },
                                  parentAlive: { _ in true }, ["com.example.work"]) },
            list: { objects }, listen: false)
        objects = [1, 9]
        XCTAssertTrue(arrivals.settle(timeoutMs: 1000))
        XCTAssertEqual(arrivals.take(), [])
        XCTAssertEqual(arrivals.deniedLive(), [])
    }

    func testAnArrivalAlreadyGoneIsFlaggedWithoutJudgement() {
        var objects: [AudioObjectID] = []
        let arrivals = ProcessArrivals(identify: { _ in nil }, judge: { _ in
            XCTFail("an unidentifiable arrival must not reach the judge")
            return .allowed
        }, list: { objects }, listen: false)
        objects = [7]
        XCTAssertTrue(arrivals.settle(timeoutMs: 1000))
        XCTAssertEqual(arrivals.take().map(\.label), [ProcessArrivals.unclassified])
    }
}

/// audioUse decisions (plan PR 3b-3): what counts, what is named, and what is a change.
final class AudioUseTests: XCTestCase {
    func process(_ app: String, bundle: String? = nil, pid: pid_t = 50, parent: pid_t = 1,
                 input: Bool = false, output: Bool = false, denylisted: Bool = false) -> AudioUse.Process {
        AudioUse.Process(pid: pid, parent: parent, bundle: bundle ?? app, app: app, input: input, output: output,
                         denylisted: denylisted)
    }

    func testOurOwnCaptureAndProcessesAreIgnored() {
        // replayd and avconferenced report input for our own SCK capture (spike Q3, Q4).
        XCTAssertTrue(AudioUse.ignored(process("com.apple.replayd", input: true), ownPid: 9, supervisorPid: 8))
        XCTAssertTrue(AudioUse.ignored(process("com.apple.avconferenced", input: true), ownPid: 9, supervisorPid: 8))
        XCTAssertTrue(AudioUse.ignored(process("x.helper", pid: 9), ownPid: 9, supervisorPid: 8))
        // The supervisor and everything it started (Electron's renderer records the mic).
        XCTAssertTrue(AudioUse.ignored(process("com.astgl.geekspace", pid: 8), ownPid: 9, supervisorPid: 8))
        XCTAssertTrue(AudioUse.ignored(process("com.github.Electron.helper", parent: 8), ownPid: 9, supervisorPid: 8))
        XCTAssertFalse(AudioUse.ignored(process("us.zoom.xos", input: true), ownPid: 9, supervisorPid: 8))
    }

    func testDenylistedAppsAreFoldedIntoOneUnnamedEntry() {
        let states = AudioUse.aggregate([
            process("com.example.work", input: true, denylisted: true),
            process("com.example.other", output: true, denylisted: true),
            process("us.zoom.xos", input: true, output: true),
        ])
        XCTAssertEqual(states[.denylisted], AudioUse.State(input: true, output: true))
        XCTAssertEqual(states[.app("us.zoom.xos")], AudioUse.State(input: true, output: true))
        XCTAssertNil(states[.app("com.example.work")], "a denylisted app is never named")
        let fields = AudioUse.fields(.denylisted, states[.denylisted]!, t: 1)
        XCTAssertTrue(fields["app"] is NSNull)
        XCTAssertEqual(fields["denylisted"] as? Bool, true)
    }

    func testHelpersMergeIntoTheirAppAndIdleOrUnnamedProcessesDrop() {
        let states = AudioUse.aggregate([
            process("com.google.Chrome", bundle: "com.google.Chrome.helper", input: true),
            process("com.google.Chrome", bundle: "com.google.Chrome.helper.renderer", output: true),
            process("com.apple.Music"),
            process("", bundle: "", output: true),
        ])
        XCTAssertEqual(states, [.app("com.google.Chrome"): AudioUse.State(input: true, output: true)])
    }

    func testAChildWithItsOwnBundleUnderADenylistedParentIsDenylisted() {
        // Codex review of PR #79: the child is an app of its own, so its owning app is its own
        // ID; the parent must still be checked.
        XCTAssertTrue(AudioUse.isDenylisted(bundle: "com.other.player", app: "com.other.player",
                                            parentApp: "com.example.work", known: false, denylist: ["com.example.work"]))
    }

    func testTheTapsKnowledgeCountsEvenWhenNothingElseMatches() {
        // An orphaned helper: parent now launchd, no bundle match, but the tap/listener denied it.
        XCTAssertTrue(AudioUse.isDenylisted(bundle: "", app: "", parentApp: nil, known: true, denylist: ["com.example.work"]))
    }

    func testASystemDaemonWithAnUnreadableParentIsNotDenylisted() {
        // Measured: systemsoundserverd and friends have an unreadable parent. Folding them in
        // would pause the mic on every alert sound.
        XCTAssertFalse(AudioUse.isDenylisted(bundle: "systemsoundserverd", app: "systemsoundserverd",
                                             parentApp: nil, known: false, denylist: ["com.example.work"]))
    }

    func testOnlyChangesAreReportedAndAnAppThatStopsReadsAsOff() {
        let zoomOn: [AudioUse.Key: AudioUse.State] = [.app("us.zoom.xos"): .init(input: true, output: true)]
        XCTAssertTrue(AudioUse.changes(from: zoomOn, to: zoomOn).isEmpty)
        let stopped = AudioUse.changes(from: zoomOn, to: [:])
        XCTAssertEqual(stopped.count, 1)
        XCTAssertEqual(stopped[0].key, .app("us.zoom.xos"))
        XCTAssertEqual(stopped[0].state, AudioUse.State())
        let started = AudioUse.changes(from: [:], to: [.denylisted: .init(input: false, output: true)])
        XCTAssertEqual(started.map(\.key), [.denylisted])
    }
}

/// Liveness from proc_pidinfo, not kill(pid, 0) (Codex review of PR #79, round 3): a zombie
/// must read as gone, or an exited denylisted child could be judged another user's process,
/// and an exited denylisted parent could make its orphan look allowed.
final class ProcessLookupTests: XCTestCase {
    func testAZombieIsGoneEvenThoughKillSucceeds() throws {
        var child: pid_t = 0
        var argv: [UnsafeMutablePointer<CChar>?] = [strdup("/usr/bin/true"), nil]
        defer { argv.compactMap { $0 }.forEach { free($0) } }
        XCTAssertEqual(posix_spawn(&child, "/usr/bin/true", nil, nil, &argv, nil), 0)
        // Exited and not reaped yet: a zombie.
        usleep(300_000)
        XCTAssertEqual(kill(child, 0), 0, "the trap: kill(pid, 0) succeeds for a zombie")
        XCTAssertEqual(Tap.lookup(child), .gone)
        XCTAssertFalse(Tap.processAlive(child))
        XCTAssertEqual(Tap.parentPid(child), -1)
        var status: Int32 = 0
        waitpid(child, &status, 0)
    }

    func testOurOwnProcessReadsItsParent() {
        XCTAssertEqual(Tap.lookup(getpid()), .parent(getppid()))
        XCTAssertTrue(Tap.processAlive(getpid()))
    }
}
