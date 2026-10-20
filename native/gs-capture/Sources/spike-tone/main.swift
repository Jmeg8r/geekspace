// WHAT: spike-only stand-in for a denylisted app: plays a sine tone, holds the mic open, or
// shows a synthetic backdrop window.
// WHY: spike questions 2 and 3 need an app with a known bundle ID whose audio output and
// input start at a known instant. The driver wraps this binary in an .app bundle
// (dev.geekspace.spike.tone) and launches it with `open --stdout`, so it is its own
// responsible process and its timestamps can be compared with gs-capture's. The backdrop
// gives the exclusion screenshots a synthetic scene to show instead of real windows.
import AppKit
import AVFoundation
import Foundation

func say(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

func now() -> Double { Date().timeIntervalSince1970 * 1000 }

let arguments = CommandLine.arguments
guard arguments.count >= 3, let seconds = Double(arguments[2]), seconds > 0 else {
    FileHandle.standardError.write("usage: spike-tone play|listen[-windowless] <seconds> [hz] [linger-s] | backdrop <seconds> x y w h | spawn-child <child-seconds> <hz> <child-path>\n".data(using: .utf8)!)
    exit(2)
}
NSApplication.shared.setActivationPolicy(.accessory)

final class Backdrop: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let tile: CGFloat = 40
        for row in 0...Int(bounds.height / tile) {
            for col in 0...Int(bounds.width / tile) {
                ((row + col) % 2 == 0 ? NSColor.systemTeal : NSColor.white).setFill()
                NSRect(x: CGFloat(col) * tile, y: CGFloat(row) * tile, width: tile, height: tile).fill()
            }
        }
        NSAttributedString(string: "SYNTHETIC BACKDROP", attributes: [
            .font: NSFont.boldSystemFont(ofSize: 48), .foregroundColor: NSColor.black,
            .backgroundColor: NSColor.white,
        ]).draw(at: NSPoint(x: 40, y: 40))
    }
}

if arguments[1] == "backdrop" {
    let numbers = arguments.dropFirst(3).compactMap { Double($0) }
    guard numbers.count == 4, let screen = NSScreen.main else {
        FileHandle.standardError.write("backdrop needs x y w h in top-left screen points\n".data(using: .utf8)!)
        exit(2)
    }
    // Callers pass ScreenCaptureKit's top-left coordinates; AppKit frames are bottom-left.
    let frame = NSRect(x: numbers[0], y: screen.frame.height - numbers[1] - numbers[3], width: numbers[2], height: numbers[3])
    let window = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "SYNTHETIC BACKDROP"
    window.contentView = Backdrop(frame: NSRect(origin: .zero, size: frame.size))
    window.orderFrontRegardless()
    say(["event": "started", "mode": "backdrop", "t": now(), "pid": ProcessInfo.processInfo.processIdentifier])
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
    NSApplication.shared.run()
}
// `spawn-child`: the (denylisted) app starts a bare child tone, which has no bundle ID, waits
// until the child is playing, then exits. The child plays on as an orphan whose parent is now
// launchd, so nothing ties it to the denylist any more (PR #78, Codex round 2).
if arguments[1] == "spawn-child" {
    guard arguments.count >= 5, Double(arguments[3]) != nil else {
        FileHandle.standardError.write("spawn-child needs <child-seconds> <hz> <child-path>\n".data(using: .utf8)!)
        exit(2)
    }
    // Long enough for the child's audio engine to start, measured at about 100-300 ms.
    let childStartWait = 0.8
    let child = Process()
    child.executableURL = URL(fileURLWithPath: arguments[4])
    // Linger 0; the child's lines go to the same stdout as ours.
    child.arguments = ["play", arguments[2], arguments[3], "0"]
    do {
        try child.run()
    } catch {
        say(["event": "error", "t": now(), "message": error.localizedDescription])
        exit(1)
    }
    say(["event": "spawned", "t": now(), "pid": ProcessInfo.processInfo.processIdentifier, "childPid": child.processIdentifier])
    DispatchQueue.main.asyncAfter(deadline: .now() + childStartWait) {
        say(["event": "exiting", "t": now(), "pid": ProcessInfo.processInfo.processIdentifier])
        exit(0)
    }
    NSApplication.shared.run()
}
// ScreenCaptureKit lists only apps that own a window, so by default the stand-in shows one,
// as every call app does. The -windowless modes reproduce the gap that leaves out.
let windowless = arguments[1].hasSuffix("-windowless")
let mode = windowless ? String(arguments[1].dropLast("-windowless".count)) : arguments[1]
if !windowless {
    let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 240, height: 80), styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "SpikeTone \(mode)"
    window.orderFrontRegardless()
}
let engine = AVAudioEngine()

switch mode {
case "play":
    let hz = arguments.count > 3 ? Double(arguments[3]) ?? 440 : 440
    let format = engine.outputNode.inputFormat(forBus: 0)
    let rate = format.sampleRate
    var phase = 0.0
    let amplitude: Float = 0.25
    let source = AVAudioSourceNode { _, _, frameCount, bufferList -> OSStatus in
        let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
        for frame in 0..<Int(frameCount) {
            let value = amplitude * Float(sin(phase))
            phase += 2 * .pi * hz / rate
            for buffer in buffers { buffer.mData!.assumingMemoryBound(to: Float.self)[frame] = value }
        }
        return noErr
    }
    engine.attach(source)
    engine.connect(source, to: engine.mainMixerNode, format: AVAudioFormat(standardFormatWithSampleRate: rate, channels: format.channelCount))
case "listen":
    let input = engine.inputNode
    input.installTap(onBus: 0, bufferSize: 4096, format: input.outputFormat(forBus: 0)) { _, _ in }
default:
    FileHandle.standardError.write("unknown mode \(mode)\n".data(using: .utf8)!)
    exit(2)
}

do {
    try engine.start()
} catch {
    say(["event": "error", "t": now(), "message": error.localizedDescription])
    exit(1)
}
say(["event": "started", "mode": arguments[1], "windowless": windowless, "t": now(), "pid": ProcessInfo.processInfo.processIdentifier])
// Run a real AppKit event loop, as any call app does. Without one the process never checks
// in with WindowServer and ScreenCaptureKit does not list it as an application at all.
// Stop audio, then stay alive a while, so "stopped using audio" and "process exited" are
// separate events for the watcher (a call app usually stays open after a call ends).
// `play <s> <hz> 0` exits right away instead: a process that starts and exits between two
// tap polls (PR 3b-2 transient-instance proof).
let lingerSeconds = mode == "play" && arguments.count > 4 ? Double(arguments[4]) ?? 2.0 : 2.0
DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
    engine.stop()
    say(["event": "stopped", "mode": arguments[1], "t": now()])
    DispatchQueue.main.asyncAfter(deadline: .now() + lingerSeconds) {
        say(["event": "exiting", "t": now()])
        exit(0)
    }
}
NSApplication.shared.run()
