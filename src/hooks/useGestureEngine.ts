"use client";

import { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { GestureType, HandLandmark, HandInfo, TrackingResults } from "@/types";
import { useRef } from "react";

// ─── Tuning ───────────────────────────────────────────────────────────────────
const HISTORY_SIZE      = 3;   // was 5 — faster gesture response
const SWIPE_WINDOW_MS   = 350;
const SWIPE_THRESHOLD   = 0.18;
const SWIPE_COOLDOWN_MS = 1100;
const FINGER_Y_MARGIN   = 0.022;
const THUMB_X_THRESH    = 0.065;
const DRAW_MIN_FRAMES   = 1;   // was 2 — instant draw response
const ERASE_MIN_FRAMES  = 1;
const CLEAR_HOLD_MS     = 1400;
const CLEAR_COOLDOWN_MS = 2200;
const COMMAND_SHOW_MS   = 700;

// ─── Finger helpers ───────────────────────────────────────────────────────────
function isFingerExtended(
  tip: HandLandmark, pip: HandLandmark, mcp: HandLandmark, isThumb = false
): boolean {
  if (isThumb) return Math.abs(tip.x - mcp.x) > THUMB_X_THRESH;
  return tip.y < pip.y - FINGER_Y_MARGIN;
}

function getFingers(lms: HandLandmark[]) {
  return {
    thumb:  isFingerExtended(lms[4],  lms[3],  lms[2],  true),
    index:  isFingerExtended(lms[8],  lms[7],  lms[5]),
    middle: isFingerExtended(lms[12], lms[11], lms[9]),
    ring:   isFingerExtended(lms[16], lms[15], lms[13]),
    pinky:  isFingerExtended(lms[20], lms[19], lms[17]),
  };
}

function classifyRaw(lms: HandLandmark[]): GestureType {
  const f = getFingers(lms);
  
  // GRAB / FIST: all fingers closed
  if (!f.index && !f.middle && !f.ring && !f.pinky) return "GRAB";

  // PINCH
  const pinchDist = Math.hypot(lms[4].x - lms[8].x, lms[4].y - lms[8].y);
  if (pinchDist < 0.06) return "PINCH"; 


  // DRAW: only index extended
  if (f.index && !f.middle && !f.ring && !f.pinky)  return "DRAW";
  // ERASE: index + middle extended
  if (f.index && f.middle  && !f.ring && !f.pinky)  return "ERASE";
  // CLEAR: 4 fingers (index + middle + ring + pinky)
  if (f.index && f.middle  &&  f.ring &&  f.pinky)  return "CLEAR_HOLD";
  
  return "IDLE";
}

// ─── Engine state (lives outside React — mutated in-place, never cloned) ──────
interface EngineState {
  gestureHists: GestureType[][];
  palmHists:    { x: number; t: number }[][];
  lastSwipeMs:  number;
  lastClearMs:  number;
  clearStartMs: number | null;
  clearDone:    boolean;
  consec:       Record<string, number>;
  prevGesture:  GestureType;
  // Outputs (read by consumers each frame)
  gesture:       GestureType;
  tracking:      TrackingResults;
  progress:      number;
  command:       string | null;
  commandSetMs:  number;
}

export function makeEngine(): EngineState {
  return {
    gestureHists: [[], []],
    palmHists:    [[], []],
    lastSwipeMs:  0,
    lastClearMs:  0,
    clearStartMs: null,
    clearDone:    false,
    consec:       {},
    prevGesture:  "IDLE",
    gesture:      "IDLE",
    tracking:     { hands: [], primaryHandIndex: 0 },
    progress:     0,
    command:      null,
    commandSetMs: 0,
  };
}

/** Process one detection frame — mutates engine in-place, returns whether UI needs update */
export function processFrame(
  eng: EngineState,
  results: HandLandmarkerResult,
  dominantPref: "auto" | "left" | "right"
): boolean {
  const now = performance.now();

  if (!results.landmarks?.length) {
    const changed =
      eng.gesture !== "IDLE" || eng.tracking.hands.length > 0 || eng.progress > 0;
    if (changed) {
      eng.gesture      = "IDLE";
      eng.tracking     = { hands: [], primaryHandIndex: 0 };
      eng.progress     = 0;
      eng.clearStartMs = null;
      eng.clearDone    = false;
      eng.palmHists    = [[], []];
      eng.gestureHists = [[], []];
    }
    if (eng.command && now - eng.commandSetMs > COMMAND_SHOW_MS) {
      eng.command = null;
      return true;
    }
    return changed;
  }

  const hands: HandInfo[] = results.landmarks.map((lms, i) => ({
    landmarks: lms as unknown as HandLandmark[],
    handedness: (results.handedness?.[i]?.[0]?.categoryName ?? "Right") as "Left" | "Right",
    index: i,
  }));

  let primaryIdx = 0;
  if (dominantPref !== "auto" && hands.length > 1) {
    const want  = dominantPref === "right" ? "Right" : "Left";
    const found = hands.findIndex((h) => h.handedness === want);
    if (found !== -1) primaryIdx = found;
  }

  const lms  = hands[primaryIdx].landmarks;
  const f    = getFingers(lms);
  const all5 = f.thumb && f.index && f.middle && f.ring && f.pinky;

  let rawGesture: GestureType;

  if (all5) {
    const palmX = lms[0].x;
    const ph    = eng.palmHists[primaryIdx];
    ph.push({ x: palmX, t: now });
    eng.palmHists[primaryIdx] = ph.filter((p) => now - p.t <= SWIPE_WINDOW_MS);

    const arr = eng.palmHists[primaryIdx];
    if (arr.length >= 4 && now - eng.lastSwipeMs > SWIPE_COOLDOWN_MS) {
      const dx = palmX - arr[0].x;
      if (Math.abs(dx) > SWIPE_THRESHOLD) {
        eng.lastSwipeMs = now;
        eng.palmHists[primaryIdx] = [];
        eng.command      = dx > 0 ? "UNDO" : "REDO";
        eng.commandSetMs = now;
        rawGesture = dx > 0 ? "UNDO" : "REDO";
      } else {
        rawGesture = "IDLE";
      }
    } else {
      rawGesture = "IDLE";
    }
    eng.clearStartMs = null;
    eng.clearDone    = false;
    eng.progress     = 0;
  } else {
    eng.palmHists[primaryIdx] = [];
    rawGesture = classifyRaw(lms);
  }

  // CLEAR_HOLD progress
  if (rawGesture === "CLEAR_HOLD") {
    if (eng.clearStartMs === null) eng.clearStartMs = now;
    const prog = Math.min(1, (now - eng.clearStartMs) / CLEAR_HOLD_MS);
    eng.progress = prog;
    if (prog >= 1 && !eng.clearDone && now - eng.lastClearMs > CLEAR_COOLDOWN_MS) {
      eng.clearDone    = true;
      eng.lastClearMs  = now;
      eng.command      = "CLEAR";
      eng.commandSetMs = now;
    }
  } else {
    if (eng.clearStartMs !== null) {
      eng.clearStartMs = null;
      eng.clearDone    = false;
      eng.progress     = 0;
    }
  }

  // Majority-vote history
  const hist = eng.gestureHists[primaryIdx];
  hist.push(rawGesture);
  if (hist.length > HISTORY_SIZE) hist.shift();
  const cnts: Record<string, number> = {};
  for (const g of hist) cnts[g] = (cnts[g] ?? 0) + 1;
  const voted = Object.entries(cnts).reduce((a, b) =>
    b[1] > a[1] ? b : a
  )[0] as GestureType;

  // Stability guard
  const minF = voted === "DRAW" ? DRAW_MIN_FRAMES : voted === "ERASE" ? ERASE_MIN_FRAMES : 1;
  eng.consec[voted] = (eng.consec[voted] ?? 0) + 1;
  Object.keys(eng.consec)
    .filter((k) => k !== voted)
    .forEach((k) => { eng.consec[k] = 0; });
  const finalGesture = eng.consec[voted] >= minF ? voted : eng.prevGesture;
  eng.prevGesture    = finalGesture;

  // Expire command display
  if (eng.command && now - eng.commandSetMs > COMMAND_SHOW_MS) eng.command = null;

  const prevGesture  = eng.gesture;
  const prevTrackLen = eng.tracking.hands.length;
  eng.gesture  = finalGesture;
  eng.tracking = { hands, primaryHandIndex: primaryIdx };

  return prevGesture !== finalGesture || prevTrackLen !== hands.length;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useGestureEngine(
  resultsRef: React.RefObject<import("@mediapipe/tasks-vision").HandLandmarkerResult | null>,
  dominantHandPref: "auto" | "left" | "right" = "auto"
) {
  // Mutable engine — never triggers re-renders on its own
  const engRef = useRef<EngineState>(makeEngine());

  /**
   * Call this each rAF frame to process the latest detection result.
   * Returns true if gesture or hand count changed (UI should update).
   */
  const tick = (): boolean => {
    const results = resultsRef.current;
    if (!results) {
      const eng = engRef.current;
      if (eng.gesture !== "IDLE" || eng.tracking.hands.length > 0) {
        eng.gesture  = "IDLE";
        eng.tracking = { hands: [], primaryHandIndex: 0 };
        eng.progress = 0;
        return true;
      }
      return false;
    }
    return processFrame(engRef.current, results, dominantHandPref);
  };

  return {
    engRef,
    tick,
    getGesture:   () => engRef.current.gesture,
    getTracking:  () => engRef.current.tracking,
    getProgress:  () => engRef.current.progress,
    getCommand:   () => engRef.current.command,
  };
}
