"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { Toolbar, Tool } from "@/components/ui/Toolbar";
import { AppSettings, DEFAULT_SETTINGS } from "@/types";
import { Camera, Monitor, ImageIcon, FileText, HelpCircle, X, Smile, Trash2 } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { BackgroundType } from "@/components/canvas/BackgroundLayer";
import type { CanvasHandle } from "@/components/canvas/CanvasView";
import { useAirCanvas } from "@/hooks/useAirCanvas";

const CanvasView      = dynamic(() => import("@/components/canvas/CanvasView").then((m) => m.CanvasView),      { ssr: false });
const BackgroundLayer = dynamic(() => import("@/components/canvas/BackgroundLayer").then((m) => m.BackgroundLayer), { ssr: false });

function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

export default function Home() {
  const containerRef    = useRef<HTMLDivElement>(null);
  const videoRef        = useRef<HTMLVideoElement>(null);
  const handCanvasRef   = useRef<HTMLCanvasElement>(null);
  const strokeCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef       = useRef<CanvasHandle>(null);
  
  const [dims, setDims] = useState({ w: 0, h: 0 });

  // ── Options State ────────────────────────────────────────────────────────
  const [activeTool,  setActiveTool]  = useState<Tool>("pen");
  const [activeColor, setActiveColor] = useState("#3b82f6");
  const [activeWidth, setActiveWidth] = useState(5);
  const [settings,    setSettings]    = useState<AppSettings>(DEFAULT_SETTINGS);

  const updateSettings = useCallback((patch: Partial<AppSettings>) =>
    setSettings((s) => ({ ...s, ...patch })), []);

  // ── Core Engine ──────────────────────────────────────────────────────────
  const engine = useAirCanvas(videoRef, handCanvasRef, strokeCanvasRef, dims, {
    activeTool,
    activeColor,
    activeWidth,
    glowIntensity: settings.glowIntensity,
    settings,
    dominantHandPref: settings.dominantHand,
    faceAnchorEnabled: settings.faceAnchorEnabled,
    onColorSelect: setActiveColor,
    onDragUpdate: (id, dx, dy) => canvasRef.current?.updateDragOffset(id, dx, dy),
    onDragEnd: (id) => canvasRef.current?.resetDragOffset(id),
  });

  // ── Camera Initialization ────────────────────────────────────────────────
  useEffect(() => {
    let stream: MediaStream | null = null;
    async function setupCamera() {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user", frameRate: { ideal: 60 } },
          audio: false,
        });
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        console.error("Camera access denied:", err);
      }
    }
    setupCamera();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  // ── Resize Observer ──────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setDims({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    setDims({ w: el.offsetWidth, h: el.offsetHeight });
    return () => ro.disconnect();
  }, []);

  // ── Keyboard Shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); e.shiftKey ? engine.actions.redo() : engine.actions.undo(); }
      if (e.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine.actions]);

  // ── UI State ─────────────────────────────────────────────────────────────
  const [showWebcam,    setShowWebcam]    = useState(true);
  const [webcamOpacity, setWebcamOpacity] = useState(0.45);
  const [showTips,      setShowTips]      = useState(true);
  const [showSettings,  setShowSettings]  = useState(false);

  // ── Background Mode ──────────────────────────────────────────────────────
  const [mode,        setMode]        = useState<BackgroundType>("whiteboard");
  const [source,      setSource]      = useState<string | undefined>();
  const [pdfPage,     setPdfPage]     = useState(1);
  const [pdfNumPages, setPdfNumPages] = useState(0);
  const [bgDataUrl,   setBgDataUrl]   = useState<string | undefined>();
  const [bgBounds,    setBgBounds]    = useState<{ x: number; y: number; width: number; height: number } | undefined>();

  // ── Callbacks ────────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!canvasRef.current?.exportImage) return;
    const url = await canvasRef.current.exportImage();
    Object.assign(document.createElement("a"), { download: `airwrite-${Date.now()}.png`, href: url }).click();
  }, []);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    if (file.type === "application/pdf") { setMode("pdf"); setSource(url); setPdfPage(1); setPdfNumPages(0); }
    else if (file.type.startsWith("image/")) { setMode("image"); setSource(url); }
    engine.actions.clear(true);
    e.target.value = "";
  }, [engine.actions]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    if (file.type === "application/pdf") { setMode("pdf"); setSource(url); setPdfPage(1); setPdfNumPages(0); }
    else if (file.type.startsWith("image/")) { setMode("image"); setSource(url); }
    engine.actions.clear(true);
  }, [engine.actions]);

  const faceStrokes = engine.strokes.filter((s) => s.faceAnchor).length;
  const hasFace = !!engine.faceData;

  return (
    <main ref={containerRef} className="relative w-screen h-screen overflow-hidden bg-[#080810]" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
      {/* Background Layer */}
      <BackgroundLayer
        type={mode} source={source} width={dims.w} height={dims.h}
        onBackgroundReady={(d, b) => { setBgDataUrl(d); setBgBounds(b); }}
        pdfPage={pdfPage} onPdfPagesLoaded={setPdfNumPages}
      />

      {/* Video Layer */}
      <div className="absolute inset-0 z-0 pointer-events-none" style={{ opacity: showWebcam ? webcamOpacity : 0, transition: "opacity 0.4s ease" }}>
        <video ref={videoRef} className="w-full h-full object-cover" autoPlay playsInline muted style={{ transform: "scaleX(-1)" }} />
        {/* Status indicator overlays over webcam */}
        <div className="absolute top-4 left-4 bg-black/70 px-4 py-2 rounded-full border border-white/15 backdrop-blur-md flex items-center gap-2 z-10">
          <span className={`w-2 h-2 rounded-full ${engine.isReady ? "bg-emerald-400 animate-pulse" : "bg-amber-400 animate-pulse"}`} />
          <span className="text-white text-[10px] font-black tracking-[0.2em] uppercase">
            {engine.isReady ? `AI · ${engine.handCount} Hand${engine.handCount !== 1 ? "s" : ""}${engine.faceData ? " · Face ✓" : ""}` : "Initializing AI…"}
          </span>
        </div>
        {engine.error && <div className="absolute top-4 left-4 right-4 text-center bg-red-900/80 text-red-300 text-xs font-bold px-4 py-2 rounded-xl border border-red-500/40 backdrop-blur-md z-10">⚠ {engine.error}</div>}
        {!engine.isReady && !engine.error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm z-10">
            <div className="w-14 h-14 rounded-full border-2 border-blue-500 border-t-transparent animate-spin mb-4" />
            <p className="text-white/70 text-sm font-black tracking-widest uppercase">Initializing Vision AI…</p>
            <p className="text-white/30 text-xs mt-2">Loading hand-tracking model</p>
          </div>
        )}
      </div>

      {/* Live Hand & Stroke Canvas (Managed by useAirCanvas) */}
      <canvas ref={handCanvasRef} width={dims.w} height={dims.h} className="absolute inset-0 pointer-events-none z-10" />
      <canvas ref={strokeCanvasRef} width={dims.w} height={dims.h} className="absolute inset-0 pointer-events-none z-20" />

      {/* Committed Strokes Canvas */}
      <CanvasView
        ref={canvasRef}
        width={dims.w}
        height={dims.h}
        glowIntensity={settings.glowIntensity}
        faceData={engine.faceData}
        strokes={engine.strokes}
        backgroundDataUrl={bgDataUrl}
        backgroundBounds={bgBounds}
        hoveredStrokeId={engine.hoveredStrokeId}
        draggedStrokeId={engine.draggedStrokeId}
      />

      {/* ── COLOR BAR OVERLAY ── */}
      {engine.colorBar.isOpen && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[60] flex gap-3 p-3 rounded-2xl bg-black/80 backdrop-blur-xl border border-white/20 shadow-2xl transition-all duration-300 pointer-events-none">
          {["#000000", "#ef4444", "#3b82f6", "#22c55e", "#eab308", "#ffffff", "#a78bfa"].map((c) => (
            <div
              key={c}
              className={cn(
                "w-12 h-12 rounded-xl border-2 flex items-center justify-center transition-all duration-150 relative",
                engine.colorBar.hoveredColor === c ? "scale-[1.3] border-white shadow-[0_0_20px_rgba(255,255,255,0.6)] z-10" : "border-white/10 scale-100 opacity-60"
              )}
              style={{ backgroundColor: c }}
            />
          ))}
          <div className="absolute -bottom-6 w-full text-center text-white/50 text-[10px] font-bold uppercase tracking-widest pointer-events-none">
            Release pinch to select
          </div>
        </div>
      )}

      {/* ── PINCH ZONE INDICATOR ── */}
      {engine.handCount > 0 && !engine.colorBar.isOpen && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center justify-center pointer-events-none opacity-40">
           <div className="h-1 w-24 bg-gradient-to-r from-transparent via-white/50 to-transparent rounded-full mb-1" />
           <span className="text-[8px] font-black uppercase tracking-[0.4em] text-white/50">Pinch For Color</span>
        </div>
      )}

      {/* ── WASTE BIN ── */}
      {engine.isGrabbing && (
        <div className={cn(
          "absolute bottom-8 left-1/2 -translate-x-1/2 z-40 transition-all duration-300 pointer-events-none flex flex-col items-center justify-center rounded-3xl border-2 px-10 py-6 backdrop-blur-md",
          engine.inWasteBin 
            ? "border-red-500 bg-red-500/20 scale-110 shadow-[0_0_40px_rgba(239,68,68,0.5)]" 
            : "border-white/20 bg-black/40 scale-100"
        )}>
          <Trash2 className={cn("w-8 h-8 mb-2 transition-colors", engine.inWasteBin ? "text-red-400" : "text-white/40")} />
          <span className={cn("text-xs font-black tracking-widest uppercase", engine.inWasteBin ? "text-red-300" : "text-white/30")}>
            {engine.inWasteBin ? "Release to Delete" : "Drop here to discard"}
          </span>
        </div>
      )}

      {/* ── COMMAND FLASH & HOLD RING ── */}
      {engine.clearProgress > 0 && engine.clearProgress < 1 && (
        <div className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center" style={{ boxShadow: `inset 0 0 ${80 * engine.clearProgress}px rgba(239,68,68,0.35)` }}>
          <div className="relative flex items-center justify-center">
            <svg width={100} height={100} className="-rotate-90">
              <circle cx={50} cy={50} r={42} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={6} />
              <circle cx={50} cy={50} r={42} fill="none" stroke="#ef4444" strokeWidth={6} strokeLinecap="round" strokeDasharray={`${262 * engine.clearProgress} 262`} style={{ filter: "drop-shadow(0 0 8px #ef4444)" }} />
            </svg>
            <div className="absolute flex flex-col items-center">
              <span className="text-3xl">🖐</span>
              <span className="text-[10px] font-black text-red-400 uppercase tracking-widest mt-1">HOLD</span>
            </div>
          </div>
        </div>
      )}
      {engine.lastCommand && engine.lastCommand !== "CLEAR" && (
        <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
          <div className="bg-white/10 backdrop-blur-xl border border-white/30 px-10 py-5 rounded-full shadow-2xl animate-pulse">
            <span className="text-3xl font-black text-white tracking-tight uppercase">{engine.lastCommand === "UNDO" ? "↩ Undo" : "Redo ↪"}</span>
          </div>
        </div>
      )}

      {/* ── TOP NAV ── */}
      <nav className="absolute top-0 left-0 right-0 z-50 flex flex-wrap sm:flex-nowrap items-start sm:items-center justify-between px-2 sm:px-4 py-2 sm:py-3 pointer-events-none gap-2">
        <div className="flex flex-wrap items-center gap-2 pointer-events-auto">
          <div className="flex items-center gap-2.5 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl bg-black/80 backdrop-blur-xl border border-white/10 shadow-lg mb-1 sm:mb-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center"><Camera className="w-4 h-4 text-white" /></div>
            <div className="leading-none">
              <p className="text-sm font-black text-white tracking-tight">AirWrite</p>
              <p className="text-[9px] text-blue-400/70 font-bold uppercase tracking-[0.2em]">v5 · RAW</p>
            </div>
          </div>
          <div className="flex items-center gap-0.5 p-1 rounded-xl bg-black/80 backdrop-blur-xl border border-white/10 shadow-lg">
            <ModeBtn active={mode === "whiteboard"} icon={<Monitor className="w-3.5 h-3.5" />} label="Board" onClick={() => { setMode("whiteboard"); setSource(undefined); setBgDataUrl(undefined); setBgBounds(undefined); }} />
            <UploadModeBtn mode="image" currentMode={mode} icon={<ImageIcon className="w-3.5 h-3.5" />} label="Image" accept="image/*" onChange={handleFileUpload} />
            <UploadModeBtn mode="pdf" currentMode={mode} icon={<FileText className="w-3.5 h-3.5" />} label="PDF" accept="application/pdf" onChange={handleFileUpload} />
          </div>
          {faceStrokes > 0 && <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-950/80 border border-emerald-500/30 backdrop-blur-md shadow-lg"><Smile className="w-3.5 h-3.5 text-emerald-400" /><span className="text-[10px] font-black text-emerald-400 uppercase tracking-wider">{faceStrokes} anchored</span></div>}
        </div>
        <div className="flex flex-wrap items-center gap-2 pointer-events-auto justify-end">
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-black/80 backdrop-blur-xl border border-white/10 shadow-lg">
            <span className={`w-1.5 h-1.5 rounded-full ${engine.gesture !== "IDLE" ? "bg-blue-400 animate-pulse" : engine.handCount > 0 ? "bg-emerald-400" : "bg-white/20"}`} />
            <span className="text-[9px] font-black text-white/60 uppercase tracking-[0.2em]">{engine.handCount > 0 ? `${engine.gesture} · ${engine.handCount}H${hasFace ? " · 😊" : ""}` : "No Hand Detected"}</span>
          </div>
          <NavIconBtn icon={<Camera className="w-4 h-4" />} active={showWebcam} onClick={() => setShowWebcam(!showWebcam)} label="Toggle Cam" />
          <NavIconBtn icon={<HelpCircle className="w-4 h-4" />} active={showTips} onClick={() => setShowTips(!showTips)} label="Tips" />
        </div>
      </nav>

      {/* ── LEFT TOOLBAR ── */}
      <aside className="absolute left-2 sm:left-3 top-20 sm:top-16 bottom-4 sm:bottom-10 z-50 flex items-start pointer-events-none">
        <div className="pointer-events-auto h-full rounded-2xl border border-white/8 overflow-hidden" style={{ background: "rgba(8,8,20,0.92)", backdropFilter: "blur(20px)", boxShadow: "0 0 0 1px rgba(255,255,255,0.05), 0 25px 60px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.07)" }}>
          <Toolbar
            activeTool={activeTool}       setActiveTool={setActiveTool}
            activeColor={activeColor}     setActiveColor={setActiveColor}
            activeWidth={activeWidth}     setActiveWidth={setActiveWidth}
            settings={settings}           onSettingsChange={updateSettings}
            onUndo={engine.actions.undo}  onRedo={engine.actions.redo}
            onClear={() => engine.actions.clear(false)} onExport={handleExport}
            pdfPage={pdfPage}             pdfNumPages={pdfNumPages}
            onPdfPrev={() => setPdfPage((p) => Math.max(1, p - 1))}
            onPdfNext={() => setPdfPage((p) => Math.min(pdfNumPages, p + 1))}
            showSettings={showSettings}   onToggleSettings={() => setShowSettings(!showSettings)}
            clearHoldProgress={engine.clearProgress}
            undoCount={engine.undoCount}  redoCount={engine.redoCount}
          />
        </div>
      </aside>

      {/* ── RIGHT PANEL: Camera opacity ── */}
      {showWebcam && (
        <aside className="absolute right-3 top-16 bottom-12 z-50 flex items-center pointer-events-auto">
          <div className="bg-black/80 backdrop-blur-xl border border-white/10 rounded-2xl px-2.5 py-4 flex flex-col items-center gap-3 shadow-xl">
            <span className="text-[8px] font-black text-white/30 uppercase tracking-[0.2em]" style={{ writingMode: "vertical-rl" }}>Opacity</span>
            <input type="range" min="0" max="1" step="0.05" value={webcamOpacity} onChange={(e) => setWebcamOpacity(+e.target.value)} className="h-32 cursor-pointer accent-blue-500" style={{ WebkitAppearance: "slider-vertical", width: 4, appearance: "slider-vertical" } as any} />
            <span className="text-[9px] font-black text-blue-400">{Math.round(webcamOpacity * 100)}</span>
          </div>
        </aside>
      )}

      {/* ── SETTINGS PANEL ── */}
      {showSettings && <SettingsPanel settings={settings} onSettingsChange={updateSettings} onClose={() => setShowSettings(false)} />}

      {/* ── GESTURE GUIDE ── */}
      {showTips && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-[60] pointer-events-auto">
          <div className="bg-black/90 backdrop-blur-xl border border-white/10 rounded-2xl px-4 py-3 shadow-2xl flex items-center gap-4 flex-wrap justify-center max-w-[min(92vw,760px)]">
            {[
              { e: "☝️", l: "Draw", s: "Index finger up", c: "#60a5fa" },
              { e: "✌️", l: "Erase", s: "2 fingers up", c: "#f87171" },
              { e: "●", l: "Dot", s: "Tap briefly", c: "#a78bfa" },
              { e: "🤚", l: "Undo", s: "Swipe ←", c: "#34d399" },
              { e: "🤚", l: "Redo", s: "Swipe →", c: "#a78bfa" },
              { e: "🖐", l: "Clear", s: "4 fingers hold", c: "#fb923c" },
              { e: "😊", l: "Anchor", s: "Draw on face", c: "#34d399" },
            ].map((g, i) => (
              <div key={i} className="flex items-center gap-1.5">
                {i > 0 && <div className="w-px h-6 bg-white/8 flex-shrink-0" />}
                <span className="text-lg">{g.e}</span><div><p className="text-[9px] font-black uppercase tracking-widest" style={{ color: g.c }}>{g.l}</p><p className="text-[8px] text-white/30">{g.s}</p></div>
              </div>
            ))}
            <button onClick={() => setShowTips(false)} className="ml-1 text-white/20 hover:text-white/60 transition-colors"><X className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      )}

      {/* ── STATUS BAR ── */}
      <footer className="absolute bottom-0 left-0 right-0 h-9 flex items-center justify-between px-5 z-40 border-t border-white/5 bg-black/60 backdrop-blur-md">
        <div className="flex items-center gap-5 text-[9px] font-bold tracking-[0.2em] text-white/25 uppercase">
          <span className={engine.gesture !== "IDLE" ? "text-blue-400" : ""}>{engine.gesture}</span>
          <span>✏ {engine.strokes.length}</span>
          <span>↩ {engine.undoCount}</span>
          <span>↪ {engine.redoCount}</span>
          {faceStrokes > 0 && <span className="text-emerald-600">😊 {faceStrokes}</span>}
          <span className="hidden md:block">Mode: {mode}</span>
        </div>
        <span className="text-[8px] font-black text-white/15 tracking-[0.3em] uppercase hidden md:block">AirWrite v5 · 100% Zero React Lag · O(1) Rendering</span>
      </footer>
    </main>
  );
}

// ─── Nav helpers ──────────────────────────────────────────────────────────────
const ModeBtn = ({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) => (
  <button onClick={onClick} className={cn("flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all", active ? "bg-blue-600/30 text-blue-400" : "text-white/40 hover:text-white hover:bg-white/8")}>
    {icon} <span className="hidden sm:inline">{label}</span>
  </button>
);
const UploadModeBtn = ({ mode, currentMode, icon, label, accept, onChange }: { mode: string; currentMode: string; icon: React.ReactNode; label: string; accept: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }) => (
  <label htmlFor={`upload-${mode}`} className={cn("flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all cursor-pointer", currentMode === mode ? "bg-blue-600/30 text-blue-400" : "text-white/40 hover:text-white hover:bg-white/8")}>
    {icon} <span className="hidden sm:inline">{label}</span>
    <input id={`upload-${mode}`} type="file" accept={accept} className="hidden" onChange={onChange} />
  </label>
);
const NavIconBtn = ({ icon, active, onClick, label }: { icon: React.ReactNode; active: boolean; onClick: () => void; label: string }) => (
  <button title={label} onClick={onClick} className={cn("p-2 rounded-xl bg-black/80 backdrop-blur-xl border transition-all shadow-lg", active ? "border-blue-500/40 text-blue-400 bg-blue-600/15" : "border-white/10 text-white/30 hover:text-white/70 hover:border-white/20")}>
    {icon}
  </button>
);

// ─── Settings panel ───────────────────────────────────────────────────────────
function SettingsPanel({ settings, onSettingsChange, onClose }: { settings: AppSettings; onSettingsChange: (s: Partial<AppSettings>) => void; onClose: () => void }) {
  return (
    <div className="absolute right-16 top-1/2 -translate-y-1/2 z-[60] pointer-events-auto">
      <div className="bg-[#0c0c18]/95 backdrop-blur-xl border border-white/10 rounded-2xl p-5 shadow-2xl w-60 flex flex-col gap-4">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-xs font-black text-white uppercase tracking-widest">Settings</h3>
          <button onClick={onClose} className="text-white/30 hover:text-white transition-colors p-0.5 rounded-lg hover:bg-white/5"><X className="w-3.5 h-3.5" /></button>
        </div>
        {([{ label: "Finger Trace", key: "showFingerTrace" as const }, { label: "Skeleton", key: "showSkeleton" as const }, { label: "Face Anchoring", key: "faceAnchorEnabled" as const }]).map(({ label, key }) => (
          <SettingRow key={key} label={label}><Toggle value={settings[key] as boolean} onChange={(v) => onSettingsChange({ [key]: v })} /></SettingRow>
        ))}
        <SettingRow label={`Trail Opacity ${Math.round(settings.trailOpacity * 100)}%`}><Slider min={0.1} max={1} step={0.05} value={settings.trailOpacity} accent="violet" onChange={(v) => onSettingsChange({ trailOpacity: v })} /></SettingRow>
        <SettingRow label={`Eraser Size ${settings.eraserRadius}px`}><Slider min={10} max={80} step={5} value={settings.eraserRadius} accent="red" onChange={(v) => onSettingsChange({ eraserRadius: v })} /></SettingRow>
        <SettingRow label="Dominant Hand">
          <div className="flex gap-1">{(["auto", "left", "right"] as const).map((opt) => (
            <button key={opt} onClick={() => onSettingsChange({ dominantHand: opt })} className={cn("px-2 py-1 rounded-md text-[9px] font-black uppercase tracking-wider transition-all", settings.dominantHand === opt ? "bg-blue-600 text-white" : "bg-white/5 text-white/40 hover:text-white")}>{opt}</button>
          ))}</div>
        </SettingRow>
      </div>
    </div>
  );
}

const SettingRow = ({ label, children }: { label: string; children: React.ReactNode }) => (<div className="flex flex-col gap-1.5"><span className="text-[9px] font-black text-white/35 uppercase tracking-widest">{label}</span>{children}</div>);
const Toggle = ({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) => (<button onClick={() => onChange(!value)} className={cn("w-9 h-5 rounded-full relative transition-colors duration-200", value ? "bg-blue-600" : "bg-white/10")}><div className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200", value ? "translate-x-4" : "translate-x-0.5")} /></button>);
const Slider = ({ min, max, step, value, accent, onChange }: { min: number; max: number; step: number; value: number; accent: string; onChange: (v: number) => void }) => (<input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} className={`w-full h-1 appearance-none bg-white/10 rounded-full cursor-pointer accent-${accent}-500`} />);
