// WHAT: the serial worker that runs OCR off `gs-capture run`'s capture loop.
// WHY: the first OCR in a process can take ~36 s, after a new build and again after time
// or idleness (plan.md, PR 3c). Inline, that held up every capture behind it. Here captures
// stay on schedule, and `shot` lines still go out in capture order, just later.
// The bound keeps memory flat: each pending job holds a frame, so the loop waits for a slot
// instead of queueing without limit (spec R2's flat-memory rule applies to frames too).
import Foundation

final class OCRQueue {
    let capacity: Int
    // Serial: shots are announced in the order they were taken, and Vision runs one
    // request at a time.
    private let queue = DispatchQueue(label: "gs-capture.ocr")
    private let lock = NSLock()
    private let group = DispatchGroup()
    private var reserved = 0

    init(capacity: Int) {
        precondition(capacity > 0, "OCRQueue capacity must be positive")
        self.capacity = capacity
    }

    /// Take a slot for one frame. False when `capacity` frames are already waiting or running.
    func tryReserve() -> Bool {
        lock.withLock {
            guard reserved < capacity else { return false }
            reserved += 1
            return true
        }
    }

    /// Give back a slot that was reserved but not used (the frame turned out unchanged).
    func release() {
        lock.withLock {
            precondition(reserved > 0, "OCRQueue.release without a reservation")
            reserved -= 1
        }
    }

    /// Run `job` on the worker, using a slot from `tryReserve()`. The slot frees when it ends.
    func submit(_ job: @escaping () -> Void) {
        group.enter()
        queue.async {
            job()
            self.release()
            self.group.leave()
        }
    }

    /// Wait up to `timeout` seconds for every submitted job. True when all of them finished.
    func drain(timeout: Double) -> Bool {
        group.wait(timeout: .now() + timeout) == .success
    }
}
