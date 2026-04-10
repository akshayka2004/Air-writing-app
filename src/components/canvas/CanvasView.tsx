"use client";

import { useImperativeHandle, forwardRef, useRef, useEffect, useState } from "react";
import { Stage, Layer, Line, Circle, Image as KonvaImage, Group } from "react-konva";
import { Stroke, FaceData } from "@/types";

// ─── Neon glow helpers ────────────────────────────────────────────────────────
function getNeonGlow(
  color: string,
  intensity: number
): { shadowColor: string; shadowBlur: number } {
  if (color === "#000000" || color === "#000")
    return { shadowColor: "rgba(255,255,255,0.45)", shadowBlur: intensity * 0.4 };
  return { shadowColor: color, shadowBlur: intensity };
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface CanvasViewProps {
  width:          number;
  height:         number;
  glowIntensity:  number;
  faceData:       FaceData | null;
  strokes:        Stroke[];
  backgroundDataUrl?: string;
  backgroundBounds?:  { x: number; y: number; width: number; height: number };
  hoveredStrokeId?:   string | null;
  draggedStrokeId?:   string | null;
}

export type CanvasHandle = {
  exportImage: () => Promise<string>;
  updateDragOffset: (id: string, dx: number, dy: number) => void;
  resetDragOffset: (id: string) => void;
};

// ─── Component ────────────────────────────────────────────────────────────────
export const CanvasView = forwardRef<CanvasHandle, CanvasViewProps>(
  (
    {
      width,
      height,
      glowIntensity,
      faceData,
      strokes,
      backgroundDataUrl,
      backgroundBounds,
      hoveredStrokeId,
      draggedStrokeId,
    },
    ref
  ) => {
    const stageRef       = useRef<any>(null);
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
    const groupsRef      = useRef<Record<string, any>>({});

    // ── Export & Imperative API ──────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      exportImage: async () => {
        if (!stageRef.current) return "";
        return stageRef.current.toDataURL({ pixelRatio: 2 });
      },
      updateDragOffset: (id: string, dx: number, dy: number) => {
        const node = groupsRef.current[id];
        if (node) {
          node.x(dx);
          node.y(dy);
        }
      },
      resetDragOffset: (id: string) => {
        const node = groupsRef.current[id];
        if (node) {
          node.x(0);
          node.y(0);
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }));

    // ── Background image loader ───────────────────────────────────────────────
    useEffect(() => {
      // eslint-disable-next-line
      if (!backgroundDataUrl) { setBgImage(null); return; }
      const img = new window.Image();
      img.crossOrigin = "anonymous";
      img.onload  = () => { setBgImage(img); };
      img.onerror = () => { setBgImage(null); };
      img.src = backgroundDataUrl;
    }, [backgroundDataUrl]);

    if (width === 0 || height === 0) return null;

    return (
      <div className="absolute inset-0 pointer-events-none z-10">
        {/* ── Committed strokes via Konva ── */}
        <Stage width={width} height={height} ref={stageRef} className="absolute inset-0">
          {/* Background (for composite export only) */}
          {bgImage && backgroundBounds && (
            <Layer listening={false}>
              <KonvaImage
                image={bgImage}
                x={backgroundBounds.x}
                y={backgroundBounds.y}
                width={backgroundBounds.width}
                height={backgroundBounds.height}
                listening={false}
              />
            </Layer>
          )}

          {/* Strokes layer */}
          <Layer listening={false}>
            {strokes.map((stroke) => {
              const isHovered = stroke.id === hoveredStrokeId;
              const isDragged = stroke.id === draggedStrokeId;
              const isHighlighter = stroke.tool === "highlighter";

              let glowC = stroke.color;
              let glowI = stroke.glowIntensity ?? glowIntensity;
              if (isDragged) { glowC = "#ffffff"; glowI = 25; }
              else if (isHovered) { glowC = "#ffffff"; glowI = 15; }

              const { shadowColor, shadowBlur } = getNeonGlow(glowC, glowI);
              
              let effectiveOpacity = isHighlighter ? 0.35 : 1;
              if (isDragged) effectiveOpacity = Math.max(0.8, effectiveOpacity);

              // Face-anchor OR Drag translation delta
              let dx = 0, dy = 0;
              if (stroke.faceAnchor && faceData && !isDragged) {
                dx = faceData.screenCx - stroke.faceAnchor.cx;
                dy = faceData.screenCy - stroke.faceAnchor.cy;
              }

              // Dot strokes render as a filled Circle
              if (stroke.isJustDot) {
                const cx = stroke.points[0];
                const cy = stroke.points[1];
                const r  = Math.max((stroke.width ?? 4) * 0.65, 2.5);
                return (
                  <Group key={stroke.id} x={dx} y={dy} ref={(node) => { if (node) groupsRef.current[stroke.id] = node; }}>
                    <Circle
                      x={cx} y={cy} radius={r}
                      fill={stroke.color}
                      shadowColor={shadowColor}
                      shadowBlur={shadowBlur}
                      shadowOpacity={0.85}
                      listening={false}
                      perfectDrawEnabled={false}
                    />
                  </Group>
                );
              }

              return (
                <Group key={stroke.id} x={dx} y={dy} ref={(node) => { if (node) groupsRef.current[stroke.id] = node; }}>
                  <Line
                    points={stroke.points}
                    stroke={isHovered || isDragged ? "#ffffff" : stroke.color}
                    strokeWidth={isHighlighter ? stroke.width * 3 : stroke.width}
                    tension={0.4}
                    lineCap="round"
                    lineJoin="round"
                    opacity={effectiveOpacity}
                    shadowColor={shadowColor}
                    shadowBlur={isHighlighter ? shadowBlur * 0.5 : shadowBlur}
                    shadowOpacity={isDragged ? 1 : 0.85}
                    shadowForStrokeEnabled
                    perfectDrawEnabled={false}
                    listening={false}
                  />
                </Group>
              );
            })}
          </Layer>
        </Stage>
      </div>
    );
  }
);

CanvasView.displayName = "CanvasView";
