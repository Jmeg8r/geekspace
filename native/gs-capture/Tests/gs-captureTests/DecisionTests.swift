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

    func testAParentThatIsNotAnAppIsAllowed() {
        XCTAssertEqual(Tap.classify(bundle: "com.apple.TextEdit", parent: 1, parentBundle: noApps, parentAlive: alive, denylist), .allowed)
    }
}

/// The release cap (Codex review of PR 3b-2, round 5): audio may be released only up to the
/// start of the last COMPLETED classification pass, and a pass's flags are visible no later
/// than its limit.
final class ArrivalsReleaseCapTests: XCTestCase {
    func waitForPass(_ arrivals: ProcessArrivals, after before: Double) {
        let deadline = Date().addingTimeInterval(2)
        while arrivals.checked() <= before && Date() < deadline { usleep(1000) }
    }

    func testAPassAdvancesTheLimitAndPublishesItsFlagsWithIt() {
        var objects: [AudioObjectID] = [1]
        let arrivals = ProcessArrivals(classify: { $0 == 2 ? .denylisted("com.example.work") : .allowed },
                                       list: { objects }, listen: false)
        let before = arrivals.checked()
        objects = [1, 2]
        arrivals.requestPass()
        waitForPass(arrivals, after: before)
        XCTAssertGreaterThan(arrivals.checked(), before)
        XCTAssertEqual(arrivals.take(), ["com.example.work"])
    }

    func testAStalledPassHoldsTheLimitBack() {
        var objects: [AudioObjectID] = [1]
        let gate = DispatchSemaphore(value: 0)
        let arrivals = ProcessArrivals(classify: { _ in gate.wait(); return .denylisted("com.example.work") },
                                       list: { objects }, listen: false)
        let before = arrivals.checked()
        objects = [1, 2]
        arrivals.requestPass()
        usleep(100_000)
        // The pass is stuck inside classification: the limit must not move, and no flag
        // may appear yet.
        XCTAssertEqual(arrivals.checked(), before)
        XCTAssertEqual(arrivals.take(), [])
        gate.signal()
        waitForPass(arrivals, after: before)
        XCTAssertEqual(arrivals.take(), ["com.example.work"])
    }

    func testUnreadableArrivalsAreFlagged() {
        var objects: [AudioObjectID] = []
        let arrivals = ProcessArrivals(classify: { _ in .unreadable }, list: { objects }, listen: false)
        objects = [7]
        arrivals.refresh()
        XCTAssertEqual(arrivals.take(), [ProcessArrivals.unclassified])
    }
}
