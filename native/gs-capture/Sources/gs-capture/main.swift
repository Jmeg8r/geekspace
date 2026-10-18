// WHAT: gs-capture entry point; dispatches spike subcommands.
// WHY: one binary, so the signed-build proof (spike question 7) covers every capability the
// Day Recorder needs from a single code signature and one set of entitlements.
import Foundation

let usage = """
usage: gs-capture <command> [options]
  windows        [--bundle id,id] [--title-contains s] [--layers all]
  apps                                                    apps SCK can exclude
  shot           --out f.png|f.heic [--exclude ids] [--scale s] [--crop x,y,w,h] [--keep-only ids]
  shots          --dir d [--interval s] [--duration s] [--exclude ids] [--ocr 1]
  audio          [--seconds s] [--exclude ids] [--out f.wav]
  procwatch      [--seconds s] [--poll-ms n]
  tap            [--seconds s] [--exclude ids] [--follow-ms n] [--by bundle]  CoreAudio tap
  ocr            [--level fast|accurate] [--text 1] image...
  render-fixtures --spec f.json --dir d
"""

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail(usage) }
let args = Args(arguments.dropFirst(2))

switch arguments[1] {
case "windows": await Screen.listWindows(args)
case "apps": await Screen.listApps(args)
case "shot": await Screen.shot(args)
case "shots": await Screen.shots(args)
case "audio": await SystemAudio.capture(args)
case "procwatch": await ProcWatch.run(args)
case "tap": await Tap.run(args)
case "ocr": OCR.run(args)
case "render-fixtures": OCR.renderFixtures(args)
default: fail("unknown command \(arguments[1])\n\(usage)")
}
