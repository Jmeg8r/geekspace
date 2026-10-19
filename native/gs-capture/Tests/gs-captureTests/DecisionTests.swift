// WHAT: tests for gs-capture's pure decisions: menu-bar masking across an app switch, and
// the position-based OCR merge. Run with `swift test` in native/gs-capture.
// WHY pure functions: the races they guard against (a switch while a capture is in flight)
// can't be hit on demand in a live run. See Codex review of PR 3b-1.
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

    func testDenylistedBundleAndHelper() {
        XCTAssertEqual(Tap.classify(bundle: "com.example.work", parent: 1, parentBundle: noApps, denylist), .denylisted("com.example.work"))
        XCTAssertEqual(Tap.classify(bundle: "com.example.work.helper", parent: 1, parentBundle: noApps, denylist),
                       .denylisted("com.example.work.helper"))
    }

    func testChildOfADenylistedAppIsDenylisted() {
        let parentIsWork: (pid_t) -> String? = { $0 == 42 ? "com.example.work" : nil }
        XCTAssertEqual(Tap.classify(bundle: "", parent: 42, parentBundle: parentIsWork, denylist), .denylisted("com.example.work"))
    }

    func testAnUnreadableParentIsUnreadableNotAllowed() {
        // The process exited between reading its bundle and reading its parent.
        XCTAssertEqual(Tap.classify(bundle: "", parent: -1, parentBundle: noApps, denylist), .unreadable)
    }

    func testAParentThatIsNotAnAppIsAllowed() {
        XCTAssertEqual(Tap.classify(bundle: "com.apple.TextEdit", parent: 1, parentBundle: noApps, denylist), .allowed)
    }
}
