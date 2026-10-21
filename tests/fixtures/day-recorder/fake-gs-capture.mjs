// SYNTHETIC: a stand-in for `gs-capture run`, so the supervisor is tested against a real
// child process on every platform (CI is ubuntu and cannot build the Swift helper).
// It speaks protocol v1 (docs/changes/2026-10-18-day-recorder/protocol.md) and acts out the
// scenario named in FAKE_SCENARIO. Every captured value in here is invented.
const scenario = process.env.FAKE_SCENARIO ?? "healthy";
const args = process.argv.slice(2);

function arg(name) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

function line(event, fields = {}) {
  const obj = { event, v: 1, ...fields };
  const sorted = Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
  process.stdout.write(`${JSON.stringify(sorted)}\n`);
}

const denylist = (arg("--denylist") ?? "").split(",").filter(Boolean);
let beat = null;

function ready() {
  line("ready", {
    denylist,
    pid: process.pid,
    segmentSec: Number(arg("--segment-sec") ?? 300),
    shotSec: Number(arg("--shot-sec") ?? 30),
  });
}

function stopOnSignal() {
  const stop = () => {
    clearInterval(beat);
    line("stopped", { reason: "signal" });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

switch (scenario) {
  case "healthy":
    stopOnSignal();
    ready();
    beat = setInterval(() => line("heartbeat", { t: Date.now() }), 50);
    break;
  case "capture":
    stopOnSignal();
    ready();
    line("shot", {
      appBundleId: null,
      day: "2026-10-20",
      menuBarBlanked: true,
      ocrText: "SYNTHETIC-OCR-SECRET",
      ocrMs: 420,
      path: "2026-10-20/shot-101500-000.heic",
      takenAt: 1_760_969_700_000,
    });
    line("shot", {
      appBundleId: "com.example.editor",
      day: "2026-10-20",
      menuBarBlanked: false,
      ocrText: "SYNTHETIC-OCR-TWO",
      ocrMs: 400,
      path: "2026-10-20/shot-101530-000.heic",
      takenAt: 1_760_969_730_000,
    });
    line("segment", {
      day: "2026-10-20",
      end: 1_760_970_000_000,
      kind: "system",
      path: "2026-10-20/sys-101500-000.m4a",
      peak: 0.4,
      start: 1_760_969_700_000,
    });
    line("tapRebuilt", {
      addedBundles: ["com.example.denied"],
      addedProcesses: 1,
      arrivedBundles: ["com.example.denied"],
      droppedMaxRms: 0.2,
      droppedWindows: 5,
      excludedProcesses: 2,
      rebuildMs: 80,
      t: 1_760_969_800_000,
      trigger: "listener",
    });
    beat = setInterval(() => line("heartbeat", { t: Date.now() }), 50);
    break;
  case "malformed":
    stopOnSignal();
    ready();
    process.stdout.write("not json SYNTHETIC-MALFORMED-SECRET\n");
    process.stdout.write(`${JSON.stringify({ event: "heartbeat", t: 1, v: 2, note: "SYNTHETIC-V2-SECRET" })}\n`);
    process.stdout.write(`${JSON.stringify({ event: "mystery", v: 1, note: "SYNTHETIC-UNKNOWN-SECRET" })}\n`);
    beat = setInterval(() => line("heartbeat", { t: Date.now() }), 50);
    break;
  case "fail":
    // Protocol "Failure": a message on stderr and a non-zero exit, no error event.
    ready();
    setTimeout(() => {
      process.stderr.write("gs-capture: Screen Recording permission was revoked\n");
      process.exit(3);
    }, 30);
    break;
  case "exit0":
    // An exit 0 that is not preceded by `stopped` still means capture ended unexpectedly.
    ready();
    setTimeout(() => process.exit(0), 30);
    break;
  case "silent":
    // Alive but saying nothing: a wedged capture.
    ready();
    setInterval(() => {}, 1000);
    break;
  case "stubborn":
    // Ignores SIGTERM, so the supervisor must escalate.
    process.on("SIGTERM", () => {});
    ready();
    beat = setInterval(() => line("heartbeat", { t: Date.now() }), 50);
    break;
  default:
    process.stderr.write(`gs-capture: unknown FAKE_SCENARIO ${scenario}\n`);
    process.exit(2);
}
