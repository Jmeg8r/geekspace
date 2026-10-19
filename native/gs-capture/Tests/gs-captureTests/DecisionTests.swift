// WHAT: tests for gs-capture's pure decisions: menu-bar masking across an app switch, and
// the position-based OCR merge. Run with `swift test` in native/gs-capture.
// WHY pure functions: the races they guard against (a switch while a capture is in flight)
// can't be hit on demand in a live run. See Codex review of PR 3b-1.
import CoreGraphics
import XCTest
@testable import gs_capture

final class MenuBarDecisionTests: XCTestCase {
    let denylist = ["com.example.work"]

    func testAllowedThroughoutNamesTheApp() {
        let d = Run.menuBarDecision(before: "com.apple.TextEdit", after: "com.apple.TextEdit", denylist: denylist)
        XCTAssertFalse(d.blank)
        XCTAssertEqual(d.appBundleId, "com.apple.TextEdit")
    }

    func testSwitchToDenylistedDuringCaptureBlanks() {
        // The case the stale before-sample missed: allowed, then denylisted.
        let d = Run.menuBarDecision(before: "com.apple.TextEdit", after: "com.example.work", denylist: denylist)
        XCTAssertTrue(d.blank)
        XCTAssertNil(d.appBundleId)
    }

    func testSwitchAwayFromDenylistedBlanks() {
        let d = Run.menuBarDecision(before: "com.example.work", after: "com.apple.TextEdit", denylist: denylist)
        XCTAssertTrue(d.blank)
        XCTAssertNil(d.appBundleId)
    }

    func testDenylistedHelperBundleCounts() {
        let d = Run.menuBarDecision(before: "com.example.work.helper", after: "com.example.work.helper", denylist: denylist)
        XCTAssertTrue(d.blank)
    }

    func testSwitchBetweenAllowedAppsNamesNeither() {
        let d = Run.menuBarDecision(before: "com.apple.TextEdit", after: "com.apple.finder", denylist: denylist)
        XCTAssertFalse(d.blank)
        XCTAssertNil(d.appBundleId)
    }

    func testPrefixWithoutDotIsNotTheApp() {
        // "com.example.workshop" is a different app, not a helper of com.example.work.
        let d = Run.menuBarDecision(before: "com.example.workshop", after: "com.example.workshop", denylist: denylist)
        XCTAssertFalse(d.blank)
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
