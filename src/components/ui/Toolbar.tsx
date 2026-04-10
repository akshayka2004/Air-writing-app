"use client";

import { Pen, Eraser, Highlighter, Undo2, Redo2, Download, Trash2, Settings, Eye, EyeOff, Smile, CircleDashed, ChevronLeft, ChevronRight } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { AppSettings } from "@/types";

function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

export type Tool = "pen" | "eraser" | "highlighter";

// ─── Palettes ─────────────────────────────────────────────────────────────────
const COLORS = [
  { name: "Sky",     value: "#38bdf8" },
  { name: "Blue",    value: "#3b82f6" },
  { name: "Violet",  value: "#a78bfa" },
  { name: "Pink",    value: "#ec4899" },
  { name: "Red",     value: "#ef4444" },
  { name: "Orange",  value: "#f97316" },
  { name: "Yellow",  value: "#eab308" },
  { name: "Lime",    value: "#84cc16" },
  { name: "Green",   value: "#22c55e" },
  { name: "Teal",    value: "#14b8a6" },
  { name: "White",   value: "#ffffff" },
  { name: "Black",   value: "#000000" },
];

const WIDTHS = [
  { label: "Fine",   value: 2  },
  { label: "Medium", value: 5  },
  { label: "Thick",  value: 10 },
  { label: "Bold",   value: 18 },
];

// ─── Props ────────────────────────────────────────────────────────────────────
interface ToolbarProps {
  activeTool: Tool;         setActiveTool: (t: Tool) => void;
  activeColor: string;      setActiveColor: (c: string) => void;
  activeWidth: number;      setActiveWidth: (w: number) => void;
  settings: AppSettings;    onSettingsChange: (s: Partial<AppSettings>) => void;
  onUndo: () => void;       onRedo: () => void;
  onClear: () => void;      onExport: () => void;
  pdfPage?: number;         pdfNumPages?: number;
  onPdfPrev?: () => void;   onPdfNext?: () => void;
  showSettings?: boolean;   onToggleSettings?: () => void;
  clearHoldProgress?: number;
  undoCount?: number;       redoCount?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────
export const Toolbar = ({
  activeTool, setActiveTool,
  activeColor, setActiveColor,
  activeWidth, setActiveWidth,
  settings, onSettingsChange,
  onUndo, onRedo, onClear, onExport,
  pdfPage, pdfNumPages, onPdfPrev, onPdfNext,
  showSettings, onToggleSettings,
  clearHoldProgress = 0,
  undoCount = 0, redoCount = 0,
}: ToolbarProps) => {
  return (
    <div
      className="h-full flex flex-col"
      style={{ width: 80 }}
    >
      {/* ── Scrollable body ── */}
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin"
        style={{ scrollbarWidth: "none" }}
      >
        <div className="flex flex-col gap-5 py-4">

          {/* ═══ DRAWING TOOLS ═══ */}
          <Section label="Tools">
            <SideBtn
              icon={<Pen className="w-4 h-4" />}
              label="Pen"
              active={activeTool === "pen"}
              onClick={() => setActiveTool("pen")}
              color="#38bdf8"
            />
            <SideBtn
              icon={<Highlighter className="w-4 h-4" />}
              label="Marker"
              active={activeTool === "highlighter"}
              onClick={() => setActiveTool("highlighter")}
              color="#eab308"
            />
            <SideBtn
              icon={<Eraser className="w-4 h-4" />}
              label="Erase"
              active={activeTool === "eraser"}
              onClick={() => setActiveTool("eraser")}
              danger
            />
          </Section>

          {/* ═══ COLOR PALETTE ═══ */}
          <Section label="Color">
            <div className="flex flex-col gap-2.5 items-center px-1 py-1">
              {/* Active color preview */}
              <div
                className="w-8 h-8 rounded-xl border-2 border-white/20 shadow-lg flex-shrink-0"
                style={{ backgroundColor: activeColor, boxShadow: `0 0 10px ${activeColor}60` }}
              />
              {/* Grid of colors */}
              <div className="grid grid-cols-2 gap-1">
                {COLORS.map(c => (
                  <button
                    key={c.value}
                    title={c.name}
                    onClick={() => setActiveColor(c.value)}
                    className={cn(
                      "w-6 h-6 rounded-md transition-all duration-150",
                      activeColor === c.value
                        ? "scale-110 ring-2 ring-white/60 ring-offset-1 ring-offset-black/50"
                        : "hover:scale-110 ring-1 ring-black/20"
                    )}
                    style={{ backgroundColor: c.value }}
                  />
                ))}
              </div>
            </div>
          </Section>

          {/* ═══ STROKE WIDTH ═══ */}
          <Section label="Size">
            {WIDTHS.map(w => (
              <button
                key={w.value}
                title={w.label}
                onClick={() => setActiveWidth(w.value)}
                className={cn(
                  "flex items-center justify-center h-8 w-full rounded-lg transition-all",
                  activeWidth === w.value
                    ? "bg-white/15"
                    : "hover:bg-white/5"
                )}
              >
                <div
                  className="rounded-full bg-white transition-all"
                  style={{
                    width: Math.min(40, Math.max(4, w.value * 1.8)),
                    height: Math.min(14, Math.max(2, w.value * 0.8)),
                    opacity: activeWidth === w.value ? 1 : 0.35,
                    boxShadow: activeWidth === w.value ? `0 0 5px ${activeColor}` : undefined,
                  }}
                />
              </button>
            ))}
          </Section>

          {/* ═══ GLOW ═══ */}
          <Section label="Glow">
            <div className="flex flex-col items-center gap-2 px-1 pb-1 pt-1">
              <input
                type="range" min={0} max={25} step={1}
                value={settings.glowIntensity}
                onChange={e => onSettingsChange({ glowIntensity: +e.target.value })}
                className="w-full h-1 rounded-full cursor-pointer bg-white/10"
                style={{ accentColor: activeColor }}
              />
              <span className="text-[8px] font-black text-white/30 tracking-widest">{settings.glowIntensity}</span>
            </div>
          </Section>

          {/* ═══ HISTORY ═══ */}
          <Section label="History">
            <SideBtn
              icon={<Undo2 className="w-4 h-4" />}
              label={`Undo${undoCount > 0 ? ` (${undoCount})` : ""}`}
              onClick={onUndo}
              disabled={undoCount === 0}
            />
            <SideBtn
              icon={<Redo2 className="w-4 h-4" />}
              label={`Redo${redoCount > 0 ? ` (${redoCount})` : ""}`}
              onClick={onRedo}
              disabled={redoCount === 0}
            />
          </Section>

          {/* ═══ ACTIONS ═══ */}
          <Section label="Actions">
            <SideBtn icon={<Download className="w-4 h-4" />} label="Export" onClick={onExport} success />
            <SideBtn icon={<Trash2 className="w-4 h-4" />}   label="Clear"  onClick={onClear}  danger />
          </Section>

          {/* ═══ TOGGLES ═══ */}
          <Section label="View">
            <button
              title={settings.showFingerTrace ? "Hide trace" : "Show trace"}
              onClick={() => onSettingsChange({ showFingerTrace: !settings.showFingerTrace })}
              className={cn(
                "h-11 w-full flex items-center justify-center rounded-xl transition-all",
                settings.showFingerTrace ? "bg-violet-500/15 text-violet-400" : "text-white/20 hover:text-white/50 hover:bg-white/5"
              )}
            >
              {settings.showFingerTrace ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
            </button>
            <button
              title={settings.faceAnchorEnabled ? "Face anchor: ON" : "Face anchor: OFF"}
              onClick={() => onSettingsChange({ faceAnchorEnabled: !settings.faceAnchorEnabled })}
              className={cn(
                "h-11 w-full flex items-center justify-center rounded-xl transition-all",
                settings.faceAnchorEnabled ? "bg-emerald-500/15 text-emerald-400" : "text-white/20 hover:text-white/50 hover:bg-white/5"
              )}
            >
              {settings.faceAnchorEnabled ? <Smile className="w-5 h-5" /> : <CircleDashed className="w-5 h-5" />}
            </button>
            <button
              title="Settings"
              onClick={onToggleSettings}
              className={cn(
                "h-11 w-full flex items-center justify-center rounded-xl transition-all",
                showSettings ? "bg-amber-500/15 text-amber-400" : "text-white/20 hover:text-white/50 hover:bg-white/5"
              )}
            >
              <Settings className="w-5 h-5" />
            </button>
          </Section>

          {/* ═══ PDF NAVIGATION (conditional) ═══ */}
          {pdfNumPages && pdfNumPages > 1 && (
            <Section label={`PDF ${pdfPage}/${pdfNumPages}`}>
              <button
                onClick={onPdfPrev}
                disabled={pdfPage === 1}
                className="h-10 w-full flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/5 disabled:opacity-20 transition-all"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                onClick={onPdfNext}
                disabled={pdfPage === pdfNumPages}
                className="h-10 w-full flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/5 disabled:opacity-20 transition-all"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </Section>
          )}

          {/* ═══ CLEAR HOLD PROGRESS ═══ */}
          {clearHoldProgress > 0 && (
            <div className="mx-2 mt-1 flex flex-col gap-1 items-center">
              <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${clearHoldProgress * 100}%`,
                    background: "linear-gradient(90deg, #ef4444, #f97316)",
                    boxShadow: "0 0 6px #ef4444",
                  }}
                />
              </div>
              <span className="text-[8px] font-black text-red-400 uppercase tracking-widest">
                {clearHoldProgress >= 1 ? "✓ Cleared" : "Hold…"}
              </span>
            </div>
          )}

          {/* Bottom padding */}
          <div className="h-2" />
        </div>
      </div>
    </div>
  );
};

// ─── Section wrapper ──────────────────────────────────────────────────────────
const Section = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col mx-2">
    <span className="text-[7px] font-black text-white/20 uppercase tracking-[0.25em] px-1 mb-1 mt-1">
      {label}
    </span>
    <div className="flex flex-col gap-2.5 bg-white/4 rounded-xl p-2 border border-white/5">
      {children}
    </div>
  </div>
);

// ─── Sidebar button ───────────────────────────────────────────────────────────
const SideBtn = ({
  icon, label, active, onClick, danger, success, color, disabled,
}: {
  icon: React.ReactNode; label: string; active?: boolean; onClick: () => void;
  danger?: boolean; success?: boolean; color?: string; disabled?: boolean;
}) => {
  const base = "h-11 w-full flex flex-col pt-1.5 items-center justify-center rounded-xl transition-all duration-150 relative group";
  let cls = "";

  if (active && color) cls = `text-white shadow-lg`;
  else if (active && danger) cls = "bg-red-500/20 text-red-400";
  else if (active) cls = "bg-white/15 text-white";
  else if (danger) cls = "text-red-400/50 hover:bg-red-500/10 hover:text-red-400";
  else if (success) cls = "text-emerald-400/60 hover:bg-emerald-500/10 hover:text-emerald-400";
  else cls = "text-white/35 hover:bg-white/8 hover:text-white/80";
  if (disabled) cls += " opacity-30 cursor-not-allowed";

  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={label}
      className={cn(base, cls)}
      style={active && color ? {
        backgroundColor: `${color}25`,
        color,
        boxShadow: `0 0 12px ${color}30`,
      } : undefined}
    >
      {icon}
      {/* Tooltip */}
      <span className="absolute left-full ml-2 px-2 py-1 bg-black/90 text-white text-[10px] font-bold rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 border border-white/10">
        {label}
      </span>
    </button>
  );
};
