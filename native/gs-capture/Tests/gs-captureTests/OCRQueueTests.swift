// WHAT: tests for OCRQueue, the worker that takes OCR off `gs-capture run`'s capture loop.
// WHY: the first OCR in a process can take ~36 s (plan.md, PR 3c), and while it ran inline
// no screenshot was taken. The queue must keep shot order, never hold more than its
// capacity, and let shutdown wait a bounded time for work in flight.
import Foundation
import XCTest
@testable import gs_capture

final class OCRQueueTests: XCTestCase {
    func testJobsRunInOrderOffTheCallingThread() {
        let queue = OCRQueue(capacity: 4)
        let lock = NSLock()
        var order: [Int] = []
        var onCaller = false
        let caller = Thread.current
        for i in 0..<4 {
            XCTAssertTrue(queue.tryReserve())
            queue.submit {
                if Thread.current == caller { onCaller = true }
                lock.withLock { order.append(i) }
            }
        }
        XCTAssertTrue(queue.drain(timeout: 5))
        XCTAssertEqual(order, [0, 1, 2, 3])
        XCTAssertFalse(onCaller)
    }

    func testSubmitReturnsWhileASlowJobRuns() {
        // The point of the queue: a slow OCR must not hold up the next capture.
        let queue = OCRQueue(capacity: 2)
        let release = DispatchSemaphore(value: 0)
        XCTAssertTrue(queue.tryReserve())
        let started = Date()
        queue.submit { release.wait() }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.5)
        release.signal()
        XCTAssertTrue(queue.drain(timeout: 5))
    }

    func testCapacityBoundsWaitingAndRunningJobs() {
        let queue = OCRQueue(capacity: 2)
        let release = DispatchSemaphore(value: 0)
        for _ in 0..<2 {
            XCTAssertTrue(queue.tryReserve())
            queue.submit { release.wait() }
        }
        XCTAssertFalse(queue.tryReserve(), "a third frame must wait, not queue without bound")
        release.signal()
        let deadline = Date().addingTimeInterval(5)
        while !queue.tryReserve() && Date() < deadline { usleep(10_000) }
        XCTAssertLessThan(Date(), deadline, "a finished job must free its slot")
        queue.release()
        release.signal()
        XCTAssertTrue(queue.drain(timeout: 5))
    }

    func testReleaseReturnsAnUnusedSlot() {
        // An unchanged frame reserved a slot before it was known to be unchanged.
        let queue = OCRQueue(capacity: 1)
        XCTAssertTrue(queue.tryReserve())
        XCTAssertFalse(queue.tryReserve())
        queue.release()
        XCTAssertTrue(queue.tryReserve())
        queue.release()
    }

    func testDrainGivesUpAfterItsTimeout() {
        let queue = OCRQueue(capacity: 1)
        let release = DispatchSemaphore(value: 0)
        XCTAssertTrue(queue.tryReserve())
        queue.submit { release.wait() }
        let started = Date()
        XCTAssertFalse(queue.drain(timeout: 0.2))
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        release.signal()
        XCTAssertTrue(queue.drain(timeout: 5))
    }

    func testDrainHonoursADeadlineThatShrinksWhileItWaits() {
        // Codex #82 r1: a SIGTERM during a 60 s --duration drain must cut it to the 2 s
        // signal allowance, without taking the lock the draining caller holds.
        let queue = OCRQueue(capacity: 1)
        let release = DispatchSemaphore(value: 0)
        XCTAssertTrue(queue.tryReserve())
        queue.submit { release.wait() }
        let started = Date()
        let lock = NSLock()
        var deadline = started.addingTimeInterval(60)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) {
            lock.withLock { deadline = Date().addingTimeInterval(0.2) }
        }
        XCTAssertFalse(queue.drain(until: { lock.withLock { deadline } }))
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        release.signal()
        XCTAssertTrue(queue.drain(timeout: 5))
    }
}
