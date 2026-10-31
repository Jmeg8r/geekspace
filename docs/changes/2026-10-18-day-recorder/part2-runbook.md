# PR 3c part 2: runbook for the signed-build proofs

**Who:** James, at the Mac Studio. **Time:** about 3½ hours, 2 of them the soak.

**What it proves** (plan.md "Proof", spec "Acceptance checks"):
- R2: memory stays flat over a 2-hour soak.
- R3: capture fails loudly when it breaks.
- The audio tap and its leak attribution hold up over a long run.
- Spike Q7: whether the system-audio tap needs its own grant on a fresh macOS user.

The tools are in the repo:
- `scripts/soak-rss.mjs` logs memory and media-file counts. It never reads content.
- `scripts/day-recorder-ctl.mjs` turns the recorder on and off and records moments in time.
- `scripts/spike-day-recorder.mjs` is the existing proof driver.

There is no UI until 3d/3e. Until then, the recorder log is the visible record:
`~/Library/Application Support/Geekspace/logs/day-recorder.log`. Every status change is a
timestamped `status:` line with its error and any pending retry.

## 0. Before you start

- [ ] Quit any `npm run dev`. The packaged app *attaches* to whatever backend is already on
  :3210, and the dev backend holds your dev data. Check that nothing is listening:
  ```bash
  lsof -nP -iTCP:3210 -sTCP:LISTEN
  ```
- [ ] Use the worktree with the PR checked out. All commands below run from its root.
  ```bash
  cd /Volumes/Projects/Repositories/.worktrees/geekspace-3c && git status -sb && git log --oneline -1
  ```
- [ ] Make an evidence folder. Every step writes into it.
  ```bash
  export GS_EVIDENCE_DIR="$HOME/gs-part2-evidence" && mkdir -p "$GS_EVIDENCE_DIR"
  ```
- [ ] FileVault must be on, or the recorder refuses to start. That refusal is the F7 gate, so
  it's a pass if FileVault is off.
  ```bash
  fdesetup status
  ```

## 1. Build and check the signed package

```bash
npm run package
```

This runs the web build, the prebaked seed, `build:gs-capture` (the release Swift build) and
`electron-builder --mac`. electron-builder signs with the `Developer ID Application: James
Cruce (Z4CHD4858S)` identity from your keychain. Output:
`release/mac-arm64/Geekspace.app`.

Check the app and the bundled helper:
```bash
APP=release/mac-arm64/Geekspace.app
codesign --verify --deep --strict "$APP" && echo "verify OK"
codesign -d --entitlements - --xml "$APP" | plutil -p - > "$GS_EVIDENCE_DIR/entitlements-app.txt"
codesign -d --entitlements - --xml "$APP/Contents/Resources/gs-capture" | plutil -p - > "$GS_EVIDENCE_DIR/entitlements-helper.txt"
codesign -dv "$APP/Contents/Resources/gs-capture" 2>&1 | grep -E "Identifier|TeamIdentifier|flags" | tee "$GS_EVIDENCE_DIR/helper-signature.txt"
diff "$GS_EVIDENCE_DIR/entitlements-app.txt" "$GS_EVIDENCE_DIR/entitlements-helper.txt" && echo "same entitlements"
```

**Pass:**
- `verify OK`.
- The helper shows `TeamIdentifier=Z4CHD4858S` and the runtime flag.
- `same entitlements`: the five keys spike Q7 settled.

## 2. Open the app and turn the recorder on

```bash
open release/mac-arm64/Geekspace.app
node scripts/day-recorder-ctl.mjs on --denylist com.apple.TextEdit
tail -f "$HOME/Library/Application Support/Geekspace/logs/day-recorder.log"
```

Leave the `tail` running in its own tab.

**Expect:** `status: starting`, `gs-capture ready (pid …)`, then `status: recording`. On first
use macOS asks for Screen & System Audio Recording for **Geekspace**. Grant it, take a
screenshot of the prompt, and save it as `$GS_EVIDENCE_DIR/tcc-prompt-main.png`. If macOS asks
you to quit and reopen, do that and run the `on` command again.

**If you see `status: blocked (...)`:** a gate refused (FileVault, or the Time Machine
exclusion). The copy says why. Record it, fix it, then `off` and `on` again.

Check that capture is landing on disk. This counts files only; it opens none of them:
```bash
ls "$HOME/Library/Application Support/Geekspace/day-recorder/$(date +%F)" | sed -E 's/[0-9]+/N/g' | sort | uniq -c
```

The first screenshot can take about 40 s to appear: the first OCR after a new build stalls.
Audio segments appear every 5 minutes.

## 3. R3 failure proofs

Run each proof while recording. Before each one, record the moment it starts:
`node scripts/day-recorder-ctl.mjs mark "<label>"`. **R3 passes when `status: notRecording` comes
within 10 s of the mark.** After each proof, save the log lines around it:
```bash
L="$HOME/Library/Application Support/Geekspace/logs/day-recorder.log"
grep -E "status:|Not recording|gs-capture ready" "$L" | tail -15 > "$GS_EVIDENCE_DIR/r3-<name>.log"
```

### 3a. The helper is killed

```bash
node scripts/day-recorder-ctl.mjs mark "kill helper"; pkill -9 -x gs-capture
```

**Expect:**
- `Not recording: exited: gs-capture exited without saying why (code null, signal SIGKILL)`.
- `status: notRecording (…); retry in 5 s`.
- About 5 s later, `status: starting` and then `status: recording`.

A crash is retried, up to 3 times. Save the log as `r3-kill.log`.

*Optional, to check the retry cap:* kill it 4 times, each time once it is recording again. The
4th time there is no retry, and the recorder stays at `notRecording`. Save as `r3-kill-cap.log`,
then run `off` and `on` to reset.

### 3b. Screen Recording is revoked

1. `node scripts/day-recorder-ctl.mjs mark "revoke screen recording"`
2. Go to System Settings → Privacy & Security → Screen & System Audio Recording, and switch
   **Geekspace** off. If macOS asks to quit the app, choose **Later**.

**Expect, within 10 s:** `status: notRecording (… permission …)` or `(… declined TCCs …)`, with
**no** `retry in` line. A permission failure is never retried.

Save the log as `r3-revoke.log`, plus a screenshot of the toggle as `r3-revoke-settings.png`.
This is the first live check that the helper's per-heartbeat authorization call fails promptly
(plan.md, PR 3b-1, marked "unverified").

**Restore:** switch Geekspace back on. If macOS needs it, quit and reopen the app. Then:
```bash
node scripts/day-recorder-ctl.mjs off && node scripts/day-recorder-ctl.mjs on --denylist com.apple.TextEdit
```
and wait for `status: recording`.

### 3c. The output device is unplugged

**Before turning the recorder on**, set the default output (System Settings → Sound → Output)
to a device you can unplug: USB headphones, a USB DAC or AirPods. Then run `off` and `on` so
the tap is built on that device.

1. Play something, then: `node scripts/day-recorder-ctl.mjs mark "unplug output"`
2. Unplug the device, or disconnect the AirPods.

**Expect (observed 2026-10-22):** no failure. The tap follows the new default output with
no gap, so the proof is about *no silent loss*, not about Not recording. Play a continuous
sound across the switch, which a 2 s tone file looped with `afplay` does well. Then measure
the closed segment's per-second loudness (`ffmpeg` to 16 kHz wav, then RMS per second),
and switch both ways: plug in and select, then unplug. **Pass:** no silent seconds at either
switch, with the same helper pid throughout. Save the levels as `r3-unplug-levels.txt`.

*Not part of this run:* "mic silent" (R3's first bullet) needs mic capture, which is PR 3d.

## 4. The 2-hour soak (R2)

Use the Mac normally: switch apps, play audio now and then, open TextEdit for a while (it's
denylisted). Keep the display awake.

```bash
caffeinate -dimsu -t 7800 &
node scripts/day-recorder-ctl.mjs mark "soak start"
node scripts/soak-rss.mjs --minutes 120 --interval-sec 30
```

It writes `soak-rss-<time>.csv` and `.summary.json` into `$GS_EVIDENCE_DIR`, and exits 1 if
it fails.

**Pass** (`"pass": true` in the summary):
- From the 10-minute mark on, each process grows **less than 50 MB**: `helper`, `main`,
  `renderer` and `gpu`.
- The helper is seen with **one** pid (no crash and restart during the soak).
- The `shots` and `segments` counts keep growing over the run.

Afterwards, count what happened in the log during the soak:
```bash
L="$HOME/Library/Application Support/Geekspace/logs/day-recorder.log"
for k in "tap rebuilt" "held tail dropped" "Not recording" "sample rate changed" "could not store"; do
  printf '%-22s %s\n' "$k" "$(grep -c "$k" "$L")"; done | tee "$GS_EVIDENCE_DIR/soak-log-counts.txt"
```

Any `Not recording` or `could not store` during the soak needs an explanation before 3c
counts as passed.

**First-launch OCR:** in the CSV, note the elapsed time when `shots` first goes above 0 after
the app starts. With OCR off the capture loop (#82), screenshots after that first one keep
their schedule even while it is still being read.

## 5. Leak attribution after the soak (plan.md, PR 3a)

PR 3a left one unexplained 100 ms leaked window in 15 runs. The tap's per-window detail
logging lives in the proof driver, not in the app, so the check runs right after the soak with
the **signed** helper. Turn the recorder off first so only one tap runs:

```bash
node scripts/day-recorder-ctl.mjs off
export GS_SPIKE_DIR="$GS_EVIDENCE_DIR/spike"
node scripts/spike-day-recorder.mjs build
for i in 1 2 3; do
  GS_CAPTURE_BIN="$PWD/release/mac-arm64/Geekspace.app/Contents/Resources/gs-capture" \
  GS_TAP_EXTRA="--rebuild-ms 100 --hold-ms 500" GS_SPIKE_LABEL="soak-after-$i" \
  node scripts/spike-day-recorder.mjs tap-second-instance
done
```

**Pass:** in each `$GS_SPIKE_DIR/pr3a-second-instance-soak-after-*.json`, either
`leakedWindows100ms` is 0, or every entry in `leakedDetail` has `msAfterSecondStart` inside
the control tone's measured 103–128 ms output tail. Any other leak means stop and report it.
v1 can't rely on the tap until it is explained.

## 6. Clean-TCC check on a fresh macOS user (spike Q7)

Question: on a Mac that has never granted Geekspace anything, which prompts appear? And does
system audio from the tap need its own grant beyond Screen & System Audio Recording?

**Prepare, in your own account:**
```bash
mkdir -p /Users/Shared/gs-part2
ditto release/mac-arm64/Geekspace.app /Users/Shared/gs-part2/Geekspace.app
cp scripts/spike/signed-run.cjs /Users/Shared/gs-part2/
```
Then **quit Geekspace in your account.** With Fast User Switching your session keeps running,
and a second Geekspace would attach to your backend on :3210, holding your data. Check it:
`lsof -nP -iTCP:3210 -sTCP:LISTEN` must print nothing.

**Create the user:** System Settings → Users & Groups → Add User, a standard account named
"GS Test". It needs your admin password. Log in to it.

**In the GS Test account,** run this in Terminal. It uses `signed-run.cjs`, the spike's Q7
method: it runs the **bundled** helper from inside the signed app, so Geekspace is the process
TCC attributes the capture to. No backend or repo is needed.
```bash
mkdir -p ~/gs-media && cd /Users/Shared/gs-part2
( for i in $(seq 12); do afplay /System/Library/Sounds/Submarine.aiff; done ) &
open -n -W --env ELECTRON_RUN_AS_NODE=1 Geekspace.app --args "$PWD/signed-run.cjs" ~/clean-tcc-1.json ~/gs-media com.example.none 20
```

1. Screenshot **every** prompt that appears (`tcc-clean-prompt-<n>.png`), then grant it.
2. Run the same commands again. Save the result as `~/clean-tcc-2.json`.
3. Screenshot System Settings → Privacy & Security → Screen & System Audio Recording,
   including any "System Audio Recording Only" section (`tcc-clean-settings.png`).

**Read the result** (`clean-tcc-2.json`):
- `exitCode` 0, and `last.event` is `"stopped"`.
- `shots` is non-empty.
- `segments` is non-empty.
- In `lines`, `segment` entries have `peak` above 0 while the sound played. That means system
  audio was captured.

If the screen grant alone gives `peak` > 0, the tap needs no grant of its own. If the
segments are silent until a second toggle is granted, record which one.

**Copy the results out**, then log back in to your account:
```bash
cp ~/clean-tcc-*.json /Users/Shared/gs-part2/
```
`signed-run.cjs` replaces OCR text with its length, so these files hold no screen content.
Deleting the GS Test user afterwards is up to you.

## 7. What to send back

Copy the evidence folder somewhere I can read it, or tell me where it is. That's
`$GS_EVIDENCE_DIR` plus `/Users/Shared/gs-part2/clean-tcc-*.json`.

| File | From |
|---|---|
| `entitlements-*.txt`, `helper-signature.txt` | step 1 |
| `tcc-prompt-main.png` | step 2 |
| `markers.log`, `r3-kill.log`, `r3-revoke.log` (+ `.png`), `r3-unplug.log` | step 3 |
| `soak-rss-*.csv`, `soak-rss-*.summary.json`, `soak-log-counts.txt` | step 4 |
| `spike/pr3a-second-instance-soak-after-*.json` | step 5 |
| `tcc-clean-*.png`, `clean-tcc-1.json`, `clean-tcc-2.json` | step 6 |

I'll turn these into the PR 3c part 2 entry in plan.md and commit the evidence, along with
any fix a failure calls for. Then #80 can come out of draft.

**Privacy:** every file above holds counts, times, pids, file names or helper messages; none
holds frames, audio or OCR text. Don't add screenshots of the media folder's contents or of
your screen. Screenshots of System Settings and of TCC prompts are fine to commit.
