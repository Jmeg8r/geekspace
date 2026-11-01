// WHAT: tests for media file names and placing a finished file under its name.
// WHY: local time repeats in the DST fall-back hour, so two captures an hour apart used to
// get one name and the second replaced the first. The name now carries the epoch, and
// placing a file refuses to replace one already there.
import Foundation
import XCTest
@testable import gs_capture

final class NameTests: XCTestCase {
    // 2026-11-01 in America/New_York: 01:20:00.005 EDT, then the same wall-clock time in EST.
    static let newYork = TimeZone(identifier: "America/New_York")!
    static let firstPass = Date(timeIntervalSince1970: 1_793_510_400.005)
    static let secondPass = Date(timeIntervalSince1970: 1_793_514_000.005)

    func testTheFallBackHourPairIsOneWallClockTime() {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = Self.newYork
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        XCTAssertEqual(formatter.string(from: Self.firstPass), "2026-11-01 01:20:00.005")
        XCTAssertEqual(formatter.string(from: Self.secondPass), "2026-11-01 01:20:00.005")
    }

    func testShotsInTheRepeatedHourGetDistinctNames() {
        let first = Run.dayAndFile(Self.firstPass, timeZone: Self.newYork)
        let second = Run.dayAndFile(Self.secondPass, timeZone: Self.newYork)
        XCTAssertEqual(first.day, "2026-11-01")
        XCTAssertEqual(first.file, "shot-012000-005-1793510400005.heic")
        XCTAssertEqual(second.file, "shot-012000-005-1793514000005.heic")
    }

    func testSegmentsInTheRepeatedHourGetDistinctNames() {
        let first = Run.dayAndFile(Self.firstPass, prefix: "sys", ext: "m4a", timeZone: Self.newYork)
        let second = Run.dayAndFile(Self.secondPass, prefix: "sys", ext: "m4a", timeZone: Self.newYork)
        XCTAssertEqual(first.file, "sys-012000-005-1793510400005.m4a")
        XCTAssertEqual(second.file, "sys-012000-005-1793514000005.m4a")
    }

    // convex/lib/dayRecorder.ts and electron/dayRecorderMedia.mjs accept only this shape.
    func testNamesFitTheStoredPathShape() {
        let shape = #"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$"#
        for (prefix, ext) in [("shot", "heic"), ("sys", "m4a")] {
            let (_, file) = Run.dayAndFile(Date(timeIntervalSince1970: 4_102_444_799.999), prefix: prefix, ext: ext)
            XCTAssertNotNil(file.range(of: shape, options: .regularExpression), file)
        }
    }

    func makeDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("gs-names-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    func testPlaceMovesThePartialIntoPlace() throws {
        let dir = try makeDir()
        let partial = dir.appendingPathComponent(".partial-a"), final = dir.appendingPathComponent("a")
        try Data("new".utf8).write(to: partial)
        try placeWithoutReplacing(partial, at: final)
        XCTAssertEqual(try Data(contentsOf: final), Data("new".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
    }

    func testPlaceNeverReplacesAnExistingFile() throws {
        let dir = try makeDir()
        let partial = dir.appendingPathComponent(".partial-a"), final = dir.appendingPathComponent("a")
        try Data("first".utf8).write(to: final)
        try Data("second".utf8).write(to: partial)
        XCTAssertThrowsError(try placeWithoutReplacing(partial, at: final))
        XCTAssertEqual(try Data(contentsOf: final), Data("first".utf8))
    }

    func testWriteLeavesNoPartialBehind() throws {
        let dir = try makeDir()
        let final = dir.appendingPathComponent("a")
        try writeWithoutReplacing(Data("new".utf8), to: final)
        XCTAssertEqual(try Data(contentsOf: final), Data("new".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), ["a"])
    }

    func testWriteNeverReplacesAnExistingFile() throws {
        let dir = try makeDir()
        let final = dir.appendingPathComponent("a")
        try Data("first".utf8).write(to: final)
        XCTAssertThrowsError(try writeWithoutReplacing(Data("second".utf8), to: final))
        XCTAssertEqual(try Data(contentsOf: final), Data("first".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), ["a"])
    }
}
