"use client";

/**
 * useAirCanvas — THE SINGLE RAF LOOP
 *
 * Replaces: useHandTracking + useGestureEngine + useDrawingEngine + HandTraceLayer + CanvasView RAF
 * Architecture: ONE RAF loop owns all hot-path logic. React state only for committed strokes + UI labels.
 *
 * Key optimisations:
 *  1. Single RAF loop — no inter-loop timing races
 *  2. Incremental midpoint-bezier drawing — O(1) per frame instead of O(n)
 *  3. Pre-allocated Float32Array buffers — zero GC during stroke
 *  4. shadowBlur for fingertip glow (GPU) instead of createRadialGradient (CPU)
 *  5. setState only on actual value changes
 */

import { useRef, useEffect, useState, useCallback } from "react";
import { HandLandmarker, FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import {
  HandLandmark, HandInfo, Stroke, FaceData, FaceAnchor, AppSettings,
} from "@/types";
import { Tool } from "@/components/ui/Toolbar";
import { makeEngine, processFrame } from "@/hooks/useGestureEngine";

// ─── Kalman filter ────────────────────────────────────────────────────────────
class KF {
  private q: number; private r: number; private x: number; private p: number;
  constructor(q = 0.004, r = 0.018, x = 0) { this.q = q; this.r = r; this.x = x; this.p = 1; }
  update(m: number): number {
    this.p += this.q;
    const k = this.p / (this.p + this.r);
    this.x += k * (m - this.x);
    this.p *= 1 - k;
    return this.x;
  }
  reset(v: number) { this.x = v; this.p = 1; }
}

// ─── Hand skeleton ────────────────────────────────────────────────────────────
const CONNECTIONS: [number, number][] = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];
const TIPS       = [4, 8, 12, 16, 20];
const TIP_COLORS = ["#a78bfa", "#60a5fa", "#34d399", "#f472b6", "#fb923c"];

// ─── Distance helpers ─────────────────────────────────────────────────────────
function distToSegmentSquared(px: number, py: number, vx: number, vy: number, wx: number, wy: number) {
  const l2 = (wx - vx) ** 2 + (wy - vy) ** 2;
  if (l2 === 0) return (px - vx) ** 2 + (py - vy) ** 2;
  let t = ((px - vx) * (wx - vx) + (py - vy) * (wy - vy)) / l2;
  t = Math.max(0, Math.min(1, t));
  return (px - (vx + t * (wx - vx))) ** 2 + (py - (vy + t * (wy - vy))) ** 2;
}

function getClosestStroke(px: number, py: number, strokes: Stroke[]): { id: string, dist: number } | null {
  let closestId: string | null = null;
  let minDist = Infinity;
  for (let sIdx = strokes.length - 1; sIdx >= 0; sIdx--) {
    const s = strokes[sIdx];
    if (s.boundingBox) {
      const pad = 40;
      if (px < s.boundingBox.minX - pad || px > s.boundingBox.maxX + pad ||
          py < s.boundingBox.minY - pad || py > s.boundingBox.maxY + pad) continue;
    }
    const pts = s.points;
    if (s.isJustDot && pts.length >= 2) {
      const d2 = (px - pts[0]) ** 2 + (py - pts[1]) ** 2;
      if (d2 < minDist) { minDist = d2; closestId = s.id; }
    } else {
      for (let i = 0; i < pts.length - 2; i += 2) {
        const d2 = distToSegmentSquared(px, py, pts[i], pts[i+1], pts[i+2], pts[i+3]);
        if (d2 < minDist) { minDist = d2; closestId = s.id; }
      }
    }
  }
  return closestId ? { id: closestId, dist: Math.sqrt(minDist) } : null;
}

// ─── Public interface ─────────────────────────────────────────────────────────
export interface AirCanvasOptions {
  activeTool:       Tool;
  activeColor:      string;
  activeWidth:      number;
  glowIntensity:    number;
  settings:         AppSettings;
  dominantHandPref: "auto" | "left" | "right";
  faceAnchorEnabled: boolean;
  onColorSelect?:    (c: string) => void;
  onDragUpdate?:     (id: string, dx: number, dy: number) => void;
  onDragEnd?:        (id: string) => void;
}

export interface AirCanvasActions {
  undo:  () => void;
  redo:  () => void;
  clear: (silent?: boolean) => void;
}

export interface AirCanvasReturn {
  isReady:      boolean;
  error:        string | null;
  strokes:      Stroke[];
  gesture:      string;
  handCount:    number;
  clearProgress: number;
  lastCommand:  string | null;
  faceData:     FaceData | null;
  undoCount:    number;
  redoCount:    number;
  actions:      AirCanvasActions;
  colorBar:     { isOpen: boolean; hoveredColor: string | null };
  hoveredStrokeId: string | null;
  draggedStrokeId: string | null;
  isGrabbing: boolean;
  inWasteBin: boolean;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useAirCanvas(
  videoRef:      React.RefObject<HTMLVideoElement | null>,
  handCanvasRef: React.RefObject<HTMLCanvasElement | null>,
  strokeCanvasRef: React.RefObject<HTMLCanvasElement | null>,
  dims:          { w: number; h: number },
  options:       AirCanvasOptions
): AirCanvasReturn {

  // ── MediaPipe ───────────────────────────────────────────────────────────────
  const [isReady, setIsReady] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const landmarkerRef  = useRef<HandLandmarker | null>(null);
  const faceDetRef     = useRef<FaceDetector  | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );
        const [lm, fd] = await Promise.all([
          HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
              delegate: "GPU",
            },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.35,
            minHandPresenceConfidence:  0.35,
            minTrackingConfidence:      0.65,
          }),
          FaceDetector.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
              delegate: "GPU",
            },
            runningMode: "VIDEO",
            minDetectionConfidence: 0.5,
            minSuppressionThreshold: 0.3,
          }).catch(() => null),
        ]);
        if (!cancelled) {
          landmarkerRef.current = lm;
          faceDetRef.current    = fd;
          setIsReady(true);
        }
      } catch {
        // GPU failed — retry with CPU
        try {
          const vision2 = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
          );
          const lm2 = await HandLandmarker.createFromOptions(vision2, {
            baseOptions: {
              modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
              delegate: "CPU",
            },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.35,
            minHandPresenceConfidence:  0.35,
            minTrackingConfidence:      0.65,
          });
          if (!cancelled) { landmarkerRef.current = lm2; setIsReady(true); }
        } catch (e2) {
          if (!cancelled) setError("Hand tracking failed to initialize. Try reloading.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Committed strokes (React state — only changes on commit/undo/redo/clear) ─
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const strokesRef = useRef<Stroke[]>([]);
  useEffect(() => { strokesRef.current = strokes; }, [strokes]);

  // ── History ─────────────────────────────────────────────────────────────────
  const undoRef = useRef<Stroke[][]>([]);
  const redoRef = useRef<Stroke[][]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  // ── UI state (sparse updates) ────────────────────────────────────────────────
  const [gesture,      setGesture]      = useState("IDLE");
  const [handCount,    setHandCount]    = useState(0);
  const [clearProgress,setClearProgress]= useState(0);
  const [lastCommand,  setLastCommand]  = useState<string | null>(null);
  const [faceData,     setFaceData]     = useState<FaceData | null>(null);
  const faceDataRef = useRef<FaceData | null>(null);

  // ── Advanced interactions state ─────────────────────────────────────────────
  const [colorBar, setColorBar] = useState<{ isOpen: boolean; hoveredColor: string | null }>({ isOpen: false, hoveredColor: null });
  const [hoveredStrokeId, setHoveredStrokeId] = useState<string | null>(null);
  const [draggedStrokeId, setDraggedStrokeId] = useState<string | null>(null);
  
  const colorBarRef = useRef({ isOpen: false, hoveredColor: null as string | null, pinchStartMs: 0 });
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<{ id: string; lastX: number; lastY: number; offsetX: number; offsetY: number; inWasteBin: boolean } | null>(null);

  // ── Gesture engine (pure mutable object, never triggers re-render) ──────────
  const engineRef = useRef(makeEngine());

  // ── Kalman filters ───────────────────────────────────────────────────────────
  const kfX = useRef(new KF(0.004, 0.018));
  const kfY = useRef(new KF(0.004, 0.018));

  // ── Pre-allocated stroke point buffers (8k points, zero GC) ─────────────────
  const MAX_PTS = 8192;
  const ptsX    = useRef(new Float32Array(MAX_PTS));
  const ptsY    = useRef(new Float32Array(MAX_PTS));
  const ptCount = useRef(0);

  // ── Incremental bezier midpoint state ────────────────────────────────────────
  // lastMid: the midpoint we last drew TO (stroke endpoint)
  // lastCtrl: the last raw sample point (bezier control)
  const lastMidRef  = useRef<[number, number] | null>(null);
  const lastCtrlRef = useRef<[number, number] | null>(null);

  // ── Drawing state ────────────────────────────────────────────────────────────
  const isDrawingRef   = useRef(false);
  const drawStartMsRef = useRef(0);
  const drawStartPxRef = useRef<[number, number]>([0, 0]);
  const faceAnchorRef  = useRef<FaceAnchor | null>(null);
  const eraseSnapRef   = useRef(false);

  // ── Options ref (always current) ─────────────────────────────────────────────
  const optsRef = useRef(options);
  useEffect(() => { optsRef.current = options; }, [options]);

  // ── Dims ref ─────────────────────────────────────────────────────────────────
  const dimsRef = useRef(dims);
  useEffect(() => { dimsRef.current = dims; }, [dims]);

  // ── Prev UI values (change detection) ───────────────────────────────────────
  const prevGRef  = useRef("IDLE");
  const prevHCRef = useRef(0);
  const prevPrRef = useRef(0);
  const prevCmdRef = useRef<string | null>(null);

  // ── Actions (stable, exposed to toolbar / keyboard shortcuts) ────────────────
  const undo = useCallback(() => {
    const stack = undoRef.current;
    if (!stack.length) return;
    const snap = stack[stack.length - 1];
    redoRef.current = [...redoRef.current, strokesRef.current];
    undoRef.current = stack.slice(0, -1);
    strokesRef.current = snap;
    setStrokes(snap);
    setUndoCount(undoRef.current.length);
    setRedoCount(redoRef.current.length);
  }, []);

  const redo = useCallback(() => {
    const stack = redoRef.current;
    if (!stack.length) return;
    const snap = stack[stack.length - 1];
    undoRef.current = [...undoRef.current, strokesRef.current];
    redoRef.current = stack.slice(0, -1);
    strokesRef.current = snap;
    setStrokes(snap);
    setUndoCount(undoRef.current.length);
    setRedoCount(redoRef.current.length);
  }, []);

  const clear = useCallback((silent = false) => {
    if (!strokesRef.current.length) return;
    undoRef.current = [...undoRef.current, strokesRef.current];
    redoRef.current = [];
    strokesRef.current = [];
    setStrokes([]);
    setUndoCount(undoRef.current.length);
    setRedoCount(0);
    if (!silent) {
      import("canvas-confetti").then((m) =>
        m.default({ particleCount: 100, spread: 80, origin: { y: 0.7 }, colors: ["#3b82f6", "#a78bfa", "#10b981"] })
      );
    }
  }, []);

  // Stable refs so the RAF loop can call them without being in its deps
  const undoCbRef  = useRef(undo);
  const redoCbRef  = useRef(redo);
  const clearCbRef = useRef(clear);
  useEffect(() => { undoCbRef.current  = undo;  }, [undo]);
  useEffect(() => { redoCbRef.current  = redo;  }, [redo]);
  useEffect(() => { clearCbRef.current = clear; }, [clear]);

  // ── THE ONE AND ONLY RAF LOOP ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isReady) return;

    let raf: number;
    let lastVideoTime = -1;
    let faceFrameCount = 0;

    // ── Inline: clear the live stroke canvas ──────────────────────────────────
    function clearStrokeCanvas() {
      const c = strokeCanvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, c.width, c.height);
    }

    // ── Inline: commit current stroke to React state ──────────────────────────
    function commitCurrentStroke(now: number) {
      const count = ptCount.current;
      if (count === 0) return;

      const opts    = optsRef.current;
      const elapsed = now - drawStartMsRef.current;
      const [sx, sy] = drawStartPxRef.current;
      const lx = ptsX.current[count - 1];
      const ly = ptsY.current[count - 1];
      const moved = Math.hypot(lx - sx, ly - sy);
      const isDot = count <= 4 && elapsed < 220 && moved < 14;

      let flat: number[];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      
      if (isDot) {
        // Small tap → emit a filled dot circle
        const cx = ptsX.current[Math.floor(count / 2)];
        const cy = ptsY.current[Math.floor(count / 2)];
        const r  = Math.max(opts.activeWidth * 0.65, 2.5);
        flat = [];
        for (let i = 0; i <= 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const px = cx + Math.cos(a) * r;
          const py = cy + Math.sin(a) * r;
          flat.push(px, py);
          if (px < minX) minX = px; if (px > maxX) maxX = px;
          if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
      } else if (count < 2) {
        // Too short — discard
        clearStrokeCanvas();
        ptCount.current = 0;
        lastMidRef.current  = null;
        lastCtrlRef.current = null;
        return;
      } else {
        flat = [];
        for (let i = 0; i < count; i++) {
          const px = ptsX.current[i];
          const py = ptsY.current[i];
          flat.push(px, py);
          if (px < minX) minX = px; if (px > maxX) maxX = px;
          if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
      }

      const newStroke: Stroke = {
        id:           `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        points:       flat,
        color:        opts.activeColor,
        width:        opts.activeWidth,
        tool:         opts.activeTool === "eraser" ? "pen" : opts.activeTool,
        glowIntensity: opts.glowIntensity,
        isJustDot:    isDot,
        faceAnchor:   faceAnchorRef.current ?? undefined,
        boundingBox:  { minX, minY, maxX, maxY },
      };

      const cur  = strokesRef.current;
      undoRef.current = [...undoRef.current, cur];
      redoRef.current = [];
      const next = [...cur, newStroke];
      strokesRef.current = next;
      setStrokes(next);
      setUndoCount(undoRef.current.length);
      setRedoCount(0);

      clearStrokeCanvas();
      ptCount.current     = 0;
      lastMidRef.current  = null;
      lastCtrlRef.current = null;
      faceAnchorRef.current = null;
    }

    // ── Inline: draw hand skeleton + fingertips onto handCanvas ──────────────
    function drawHandTrace(hands: HandInfo[], gesture: string, W: number, H: number, settings: AppSettings) {
      const canvas = handCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, W, H);
      if (!settings.showFingerTrace || hands.length === 0) return;

      for (let hi = 0; hi < hands.length; hi++) {
        const hand      = hands[hi];
        const isPrimary = hi === 0;
        const alpha     = isPrimary ? settings.trailOpacity : settings.trailOpacity * 0.55;
        const lms       = hand.landmarks;

        // Pre-compute screen coordinates
        const xs = new Float32Array(21);
        const ys = new Float32Array(21);
        for (let i = 0; i < 21; i++) {
          xs[i] = (1 - lms[i].x) * W;
          ys[i] = lms[i].y * H;
        }

        // Skeleton lines
        if (settings.showSkeleton) {
          ctx.strokeStyle = isPrimary
            ? `rgba(147,197,253,${(alpha * 0.45).toFixed(2)})`
            : `rgba(147,197,253,${(alpha * 0.2).toFixed(2)})`;
          ctx.lineWidth = isPrimary ? 1.8 : 1.2;
          ctx.lineCap   = "round";
          for (const [a, b] of CONNECTIONS) {
            ctx.beginPath();
            ctx.moveTo(xs[a], ys[a]);
            ctx.lineTo(xs[b], ys[b]);
            ctx.stroke();
          }
        }

        // Non-fingertip joint dots
        ctx.fillStyle = `rgba(148,163,184,${(alpha * 0.6).toFixed(2)})`;
        for (let i = 0; i < 21; i++) {
          if (TIPS.includes(i)) continue;
          ctx.beginPath();
          ctx.arc(xs[i], ys[i], isPrimary ? 2.5 : 1.8, 0, Math.PI * 2);
          ctx.fill();
        }

        // Fingertip glows — shadowBlur is GPU-accelerated
        for (let fi = 0; fi < TIPS.length; fi++) {
          const ti   = TIPS[fi];
          const x    = xs[ti], y = ys[ti];
          const col  = TIP_COLORS[fi];
          const isIx = fi === 1; // index finger
          const isDr = gesture === "DRAW";
          const r    = isPrimary ? (isIx && isDr ? 9 : 6) : 4;

          ctx.save();
          ctx.globalAlpha  = alpha;
          ctx.shadowColor  = col;
          ctx.shadowBlur   = isPrimary ? (isIx && isDr ? 22 : 13) : 6;
          ctx.fillStyle    = col;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Hand label (when 2 hands present)
        if (hands.length > 1) {
          ctx.font      = "bold 9px monospace";
          ctx.fillStyle = isPrimary ? "#60a5fa" : "#94a3b8";
          ctx.textAlign = "center";
          ctx.fillText(isPrimary ? "✦ Primary" : hand.handedness, xs[0], ys[0] + 26);
        }
      }
    }

    // ── THE LOOP ──────────────────────────────────────────────────────────────
    const loop = () => {
      raf = requestAnimationFrame(loop);

      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      const { w: W, h: H } = dimsRef.current;
      if (W === 0 || H === 0) return;

      const opts = optsRef.current;
      const now  = performance.now();

      // ── Step 1: Hand detection — only on new video frames ─────────────────
      const isNewFrame = video.currentTime !== lastVideoTime;
      if (isNewFrame) {
        lastVideoTime = video.currentTime;
        const lm = landmarkerRef.current;
        if (lm) {
          try {
            const result = lm.detectForVideo(video, now);
            processFrame(engineRef.current, result, opts.dominantHandPref);
          } catch { /* skip corrupt frame */ }
        }

        // ── Step 2: Face detection — every 3 new video frames ───────────────
        faceFrameCount++;
        if (faceFrameCount % 3 === 0 && opts.faceAnchorEnabled) {
          const fd = faceDetRef.current;
          if (fd) {
            try {
              const res = fd.detectForVideo(video, now);
              if (res.detections?.length > 0) {
                const bbox = res.detections[0].boundingBox;
                if (bbox) {
                  const vw = video.videoWidth, vh = video.videoHeight;
                  const rx = bbox.originX / vw, ry = bbox.originY / vh;
                  const rw = bbox.width   / vw, rh = bbox.height  / vh;
                  const nf: FaceData = {
                    screenCx: (1 - (rx + rw / 2)) * W,
                    screenCy: (ry + rh / 2) * H,
                    screenW: rw * W, screenH: rh * H,
                    rawNormX: rx, rawNormY: ry, rawNormW: rw, rawNormH: rh,
                  };
                  const pf = faceDataRef.current;
                  // Only trigger React re-render if face moved significantly
                  if (!pf || Math.abs(pf.screenCx - nf.screenCx) > 2 || Math.abs(pf.screenCy - nf.screenCy) > 2) {
                    faceDataRef.current = nf;
                    setFaceData(nf);
                  } else {
                    // Keep fresh coords in ref even if we don't re-render
                    faceDataRef.current = nf;
                  }
                }
              } else if (faceDataRef.current !== null) {
                faceDataRef.current = null;
                setFaceData(null);
              }
            } catch { /* ignore */ }
          }
        }
      }

      const eng      = engineRef.current;
      const g        = eng.gesture;
      const tracking = eng.tracking;
      const progress = eng.progress;
      const command  = eng.command;

      // ── Step 3: Hand trace ────────────────────────────────────────────────
      drawHandTrace(tracking.hands, g, W, H, opts.settings);

      // ── Step 4: Interactions (Drawing, Erasing, Grabbing, Pinching) ──────────
      const primary     = tracking.hands[tracking.primaryHandIndex];
      const hasHand     = tracking.hands.length > 0;
      let isDrawing     = g === "DRAW"; // Restored strictly back to optimal 1-finger trace mapping for pristine framerates!
      const isErasing   = g === "ERASE" || opts.activeTool === "eraser";
      const isPenOrHL   = opts.activeTool === "pen" || opts.activeTool === "highlighter";
      const isGrab      = g === "GRAB";
      const isPinchNow  = g === "PINCH";

      if (primary) {
        const tip    = primary.landmarks[8]; // Index fingertip
        const smoothX = kfX.current.update((1 - tip.x) * W);
        const smoothY = kfY.current.update(tip.y * H);

        // ── PINCH (Color Bar) ──────────────────────────────────────────────
        const cb = colorBarRef.current;
        if (cb.isOpen) {
          // Slide to pick color
          const tX = Math.max(0, Math.min(1, smoothX / W));
          const colorOpts = ["#000000", "#ef4444", "#3b82f6", "#22c55e", "#eab308", "#ffffff", "#a78bfa"];
          const colIdx = Math.min(colorOpts.length - 1, Math.floor(tX * colorOpts.length));
          const hCol = colorOpts[colIdx];
          
          if (cb.hoveredColor !== hCol) {
            cb.hoveredColor = hCol;
            setColorBar({ isOpen: true, hoveredColor: hCol });
          }
          
          cb.pinchStartMs = isPinchNow ? now : cb.pinchStartMs;
          // Selection confirmed on release (add 150ms debounce for flicker)
          if (!isPinchNow && (now - cb.pinchStartMs > 150)) {
            if (opts.onColorSelect) opts.onColorSelect(hCol);
            cb.isOpen = false;
            cb.hoveredColor = null;
            setColorBar({ isOpen: false, hoveredColor: null });
          }
          isDrawing = false;
        } else {
          // Determine if pinch should open color bar or draw
          if (isPinchNow) {
            if (tip.y < 0.35 && !isDrawingRef.current) {
              if (cb.pinchStartMs === 0) cb.pinchStartMs = now;
              else if (now - cb.pinchStartMs > 100) {
                cb.isOpen = true;
                setColorBar({ isOpen: true, hoveredColor: null });
              }
              isDrawing = false;
            } else {
              isDrawing = true; // Canvas pinch = draw
              cb.pinchStartMs = 0;
            }
          } else {
            // Only reset if they clearly dropped the pinch for a bit, or just instantly
            cb.pinchStartMs = 0;
          }
        }

        // ── HOVER ──────────────────────────────────────────────────────────
        // Only show hover if not drawing/grabbing
        if (g === "IDLE" && !cb.isOpen && !dragRef.current && !isDrawingRef.current) {
          const closest = getClosestStroke(smoothX, smoothY, strokesRef.current);
          const newHoverId = (closest && closest.dist < 50) ? closest.id : null;
          if (newHoverId !== hoverRef.current) {
            hoverRef.current = newHoverId;
            setHoveredStrokeId(newHoverId);
          }
        } else {
          if (hoverRef.current !== null) {
            hoverRef.current = null;
            setHoveredStrokeId(null);
          }
        }

        // ── GRAB AND MOVE ──────────────────────────────────────────────────
        if (isGrab && !cb.isOpen && !isDrawingRef.current) {
          if (!dragRef.current) {
            // Initiate drag
            // A fist inherently retracts the index tip landmarks down to the palm, shifting coordinates downwards.
            // Therefore we lock onto the element that was hovered just BEFORE the fist was closed!
            let targetId = hoverRef.current;
            if (!targetId) {
              const closest = getClosestStroke(smoothX, smoothY, strokesRef.current);
              // Larger threshold fallback since their hand is now shifted into a fist
              if (closest && closest.dist < 120) targetId = closest.id; 
            }

            if (targetId) {
              const curStrokes = strokesRef.current;
              const targetStroke = curStrokes.find((s) => s.id === targetId);
              if (targetStroke) {
                undoRef.current = [...undoRef.current, curStrokes.map(s => ({...s, points: [...s.points], boundingBox: s.boundingBox ? {...s.boundingBox} : undefined}))];
                redoRef.current = [];
                setUndoCount(undoRef.current.length);
                setRedoCount(0);

                dragRef.current = { id: targetId, lastX: smoothX, lastY: smoothY, offsetX: 0, offsetY: 0, inWasteBin: false };
                setDraggedStrokeId(targetId);
                // Reset KF to avoid sudden jumps
                kfX.current.reset(smoothX);
                kfY.current.reset(smoothY);
              }
            }
          } else {
            // Continue drag (accumulate offset)
            const dx = smoothX - dragRef.current.lastX;
            const dy = smoothY - dragRef.current.lastY;
            dragRef.current.lastX = smoothX;
            dragRef.current.lastY = smoothY;
            dragRef.current.offsetX += dx;
            dragRef.current.offsetY += dy;

            // Check if inside Waste Bin (bottom-center area)
            const inWaste = smoothY > H - 150 && Math.abs(smoothX - W / 2) < 150;
            dragRef.current.inWasteBin = inWaste;
            
            // Native GPU Node update to bypass React
            if (opts.onDragUpdate) {
               opts.onDragUpdate(dragRef.current.id, dragRef.current.offsetX, dragRef.current.offsetY);
            }

            // INSTANT DELETE: if inside waste bin, delete immediately without waiting for drop release
            if (inWaste) {
              const curStrokes = [...strokesRef.current];
              const tIdx = curStrokes.findIndex((s) => s.id === dragRef.current!.id);
              if (tIdx !== -1) {
                curStrokes.splice(tIdx, 1);
                strokesRef.current = curStrokes;
                setStrokes(curStrokes);
              }
              if (opts.onDragEnd) opts.onDragEnd(dragRef.current.id);
              dragRef.current = null;
              setDraggedStrokeId(null);
            }
          }
        } else {
          // Release grab (if not already deleted)
          if (dragRef.current) {
            const curStrokes = [...strokesRef.current];
            const tIdx = curStrokes.findIndex((s) => s.id === dragRef.current!.id);

            if (opts.onDragEnd) {
              opts.onDragEnd(dragRef.current.id);
            }

            if (tIdx !== -1 && (Math.abs(dragRef.current.offsetX) > 0.1 || Math.abs(dragRef.current.offsetY) > 0.1)) {
              // Apply offset permanently upon drop
              const s = { ...curStrokes[tIdx] };
              const pts = new Float32Array(s.points);
              for (let i = 0; i < pts.length; i += 2) {
                pts[i] += dragRef.current.offsetX;
                pts[i+1] += dragRef.current.offsetY;
              }
              s.points = Array.from(pts);
              if (s.boundingBox) {
                s.boundingBox = { 
                  ...s.boundingBox, 
                  minX: s.boundingBox.minX + dragRef.current.offsetX, 
                  maxX: s.boundingBox.maxX + dragRef.current.offsetX, 
                  minY: s.boundingBox.minY + dragRef.current.offsetY, 
                  maxY: s.boundingBox.maxY + dragRef.current.offsetY 
                };
              }
              curStrokes[tIdx] = s;
              strokesRef.current = curStrokes;
              setStrokes(curStrokes);
            }
            dragRef.current = null;
            setDraggedStrokeId(null);
          }
        }

        // ── DRAW ──────────────────────────────────────────────────────────
        if (isDrawing && isPenOrHL && !cb.isOpen && !dragRef.current) {
          if (!isDrawingRef.current) {
            isDrawingRef.current   = true;
            drawStartMsRef.current = now;
            drawStartPxRef.current = [smoothX, smoothY];
            ptCount.current        = 0;
            lastMidRef.current     = null;
            lastCtrlRef.current    = null;
            eraseSnapRef.current   = false;
            kfX.current.reset((1 - tip.x) * W);
            kfY.current.reset(tip.y * H);

            const fd = faceDataRef.current;
            if (fd && opts.faceAnchorEnabled &&
              tip.x >= fd.rawNormX && tip.x <= fd.rawNormX + fd.rawNormW &&
              tip.y >= fd.rawNormY && tip.y <= fd.rawNormY + fd.rawNormH) {
              faceAnchorRef.current = { cx: fd.screenCx, cy: fd.screenCy };
            } else {
              faceAnchorRef.current = null;
            }
          }

          const cnt = ptCount.current;
          let skipPoint = false;
          if (cnt > 0) {
            const d = Math.hypot(smoothX - ptsX.current[cnt - 1], smoothY - ptsY.current[cnt - 1]);
            if (d < 1) skipPoint = true;
          }

          if (!skipPoint) {
            if (cnt < MAX_PTS) {
              ptsX.current[cnt] = smoothX;
              ptsY.current[cnt] = smoothY;
              ptCount.current   = cnt + 1;
            }
            const sctx = strokeCanvasRef.current?.getContext("2d");
            if (sctx) {
              const isHL = opts.activeTool === "highlighter";
              sctx.globalAlpha = isHL ? 0.38 : 1;
              sctx.strokeStyle = opts.activeColor;
              sctx.lineWidth   = isHL ? opts.activeWidth * 3 : opts.activeWidth;
              sctx.lineCap     = "round";
              sctx.lineJoin    = "round";

              if (opts.glowIntensity > 0 && !isHL) {
                sctx.shadowColor = opts.activeColor === "#000000"
                  ? "rgba(255,255,255,0.4)" : opts.activeColor;
                sctx.shadowBlur = opts.glowIntensity;
              } else { sctx.shadowBlur = 0; }

              if (lastCtrlRef.current === null) {
                sctx.beginPath();
                sctx.arc(smoothX, smoothY, Math.max(sctx.lineWidth / 2, 1.5), 0, Math.PI * 2);
                sctx.fillStyle   = opts.activeColor;
                sctx.globalAlpha = isHL ? 0.38 : 1;
                sctx.fill();
                lastMidRef.current  = [smoothX, smoothY];
                lastCtrlRef.current = [smoothX, smoothY];
              } else {
                const [cx, cy] = lastCtrlRef.current;
                const mx = (cx + smoothX) / 2;
                const my = (cy + smoothY) / 2;
                sctx.beginPath();
                sctx.moveTo(lastMidRef.current![0], lastMidRef.current![1]);
                sctx.quadraticCurveTo(cx, cy, mx, my);
                sctx.stroke();
                lastMidRef.current  = [mx, my];
                lastCtrlRef.current = [smoothX, smoothY];
              }
              sctx.shadowBlur  = 0;
              sctx.globalAlpha = 1;
            }
          }
        } else if (isErasing && !cb.isOpen && !dragRef.current) {
        // ── ERASE ─────────────────────────────────────────────────────────
          if (isDrawingRef.current) {
            isDrawingRef.current = false;
            ptCount.current      = 0;
            lastMidRef.current   = null;
            lastCtrlRef.current  = null;
            clearStrokeCanvas();
          }
          if (!eraseSnapRef.current) {
            eraseSnapRef.current = true;
            undoRef.current = [...undoRef.current, strokesRef.current];
            redoRef.current = [];
            setUndoCount(undoRef.current.length);
            setRedoCount(0);
          }
          const r   = opts.settings.eraserRadius;
          const cur = strokesRef.current;
          const next = cur.filter((s) => {
            if (s.boundingBox) {
              if (smoothX < s.boundingBox.minX - r || smoothX > s.boundingBox.maxX + r ||
                  smoothY < s.boundingBox.minY - r || smoothY > s.boundingBox.maxY + r) return true;
            }
            for (let i = 0; i < s.points.length; i += 2)
              if (Math.hypot(s.points[i] - smoothX, s.points[i + 1] - smoothY) < r) return false;
            return true;
          });
          if (next.length !== cur.length) {
            strokesRef.current = next;
            setStrokes(next);
          }
        }

      } else {
        // ── Gesture ended or no hand ─────────────────────────────────────
        if (isDrawingRef.current) {
          isDrawingRef.current = false;
          commitCurrentStroke(now);
        }
        if (eraseSnapRef.current) eraseSnapRef.current = false;
        
        if (colorBarRef.current.isOpen) {
          colorBarRef.current.isOpen = false;
          colorBarRef.current.hoveredColor = null;
          setColorBar({ isOpen: false, hoveredColor: null });
        }
        if (dragRef.current) {
          dragRef.current = null;
          setDraggedStrokeId(null);
        }
        
        if (!hasHand) {
          kfX.current.reset(W * 0.5);
          kfY.current.reset(H * 0.5);
          if (hoverRef.current !== null) {
            hoverRef.current = null;
            setHoveredStrokeId(null);
          }
        }
      }

      // ── Step 5: Command handling ──────────────────────────────────────────
      if (command && command !== prevCmdRef.current) {
        prevCmdRef.current = command;
        setLastCommand(command);
        if      (command === "UNDO")  undoCbRef.current();
        else if (command === "REDO")  redoCbRef.current();
        else if (command === "CLEAR") clearCbRef.current(false);
        eng.command = null;
      } else if (!command && prevCmdRef.current !== null) {
        prevCmdRef.current = null;
        setLastCommand(null);
      }

      // ── Step 6: Sparse UI state updates (only on change) ──────────────────
      if (g !== prevGRef.current) {
        prevGRef.current = g;
        setGesture(g);
      }
      const hc = tracking.hands.length;
      if (hc !== prevHCRef.current) {
        prevHCRef.current = hc;
        setHandCount(hc);
      }
      if (Math.abs(progress - prevPrRef.current) > 0.04) {
        prevPrRef.current = progress;
        setClearProgress(progress);
      }
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // Dependencies: only what triggers loop recreation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, videoRef, handCanvasRef, strokeCanvasRef]);

  return {
    isReady, error,
    strokes, gesture, handCount, clearProgress, lastCommand, faceData,
    undoCount, redoCount,
    colorBar, hoveredStrokeId, draggedStrokeId,
    isGrabbing: dragRef.current !== null,
    inWasteBin: dragRef.current?.inWasteBin ?? false,
    actions: { undo, redo, clear },
  };
}
