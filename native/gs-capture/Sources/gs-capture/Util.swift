// WHAT: shared output, argument and timing helpers for the gs-capture subcommands.
// WHY: every subcommand speaks JSON lines on stdout so the Node driver (and later the
// Electron supervisor) can parse it line by line; errors go to stderr AND exit non-zero,
// so a failed capture can never look like an empty-but-successful one.
import Foundation

// WHY a lock: `run` emits from a heartbeat task and the capture loop at once, and a write
// longer than PIPE_BUF (512 bytes; an OCR line easily is) is not atomic on a pipe, so two
// lines could interleave and the supervisor would parse neither.
private let emitLock = NSLock()

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else {
        fail("could not encode output line for keys \(object.keys.sorted())")
    }
    emitLock.withLock { FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!) }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("gs-capture: \(message)\n".data(using: .utf8)!)
    exit(1)
}

struct Args {
    private var values: [String: String] = [:]
    private(set) var positional: [String] = []

    init(_ raw: ArraySlice<String>) {
        var iterator = raw.makeIterator()
        while let token = iterator.next() {
            if token.hasPrefix("--") {
                let key = String(token.dropFirst(2))
                guard let value = iterator.next() else { fail("--\(key) needs a value") }
                values[key] = value
            } else {
                positional.append(token)
            }
        }
    }

    func string(_ key: String) -> String? { values[key] }

    func required(_ key: String) -> String {
        guard let value = values[key] else { fail("missing --\(key)") }
        return value
    }

    func double(_ key: String, default fallback: Double) -> Double {
        guard let raw = values[key] else { return fallback }
        guard let value = Double(raw), value.isFinite, value > 0 else {
            fail("--\(key) must be a positive number, got \(raw)")
        }
        return value
    }

    /// An optional positive number: nil when absent, a failure when present but invalid. A
    /// malformed value must never read as "not asked for" (Codex review, PR 3a: a bad
    /// --rebuild-ms silently turned the leak protection off).
    func optionalDouble(_ key: String) -> Double? {
        guard values[key] != nil else { return nil }
        return double(key, default: 0)
    }

    /// Comma-separated bundle IDs; an empty string means "exclude nothing" (the control run).
    func list(_ key: String) -> [String] {
        (values[key] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}

/// Wall-clock milliseconds since the epoch, so helper and driver timestamps compare directly.
func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// User + system CPU seconds consumed by this process so far.
func cpuSeconds() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1_000_000
    let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1_000_000
    return user + system
}

func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }

/// Runs `operation` under a watchdog that EXITS THE PROCESS if it has not returned within
/// `seconds`. A task-group race is not enough: ScreenCaptureKit calls hang without
/// honouring cancellation, and a task group still waits for its hung child (Codex review of
/// PR 71). Exiting non-zero is what lets the supervisor show "Not recording" (spec R3).
func withTimeout<T>(seconds: Double, what: String, _ operation: () async throws -> T) async rethrows -> T {
    let watchdog = DispatchWorkItem {
        fail("\(what) did not return within \(seconds)s (ScreenCaptureKit hung)")
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: watchdog)
    defer { watchdog.cancel() }
    return try await operation()
}
