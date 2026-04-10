"use client";

import { useImperativeHandle, forwardRef, useRef, useEffect } from "react";
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
  // Background for composite export
  backgroundDataUrl?: string;
  backgroundBounds?:  { x: number; y: number; width: number; height: number };
}

export type CanvasHandle = {
  exportImage: () => Promise<string>;
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
    },
    ref
  ) => {
    const stageRef       = useRef<any>(null);
    const bgImageRef     = useRef<HTMLImageElement | null>(null);

    // ── Export ───────────────────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      exportImage: async () => {
        if (!stageRef.current) return "";
        return stageRef.current.toDataURL({ pixelRatio: 2 });
      },
    }));

    // ── Background image loader ───────────────────────────────────────────────
    useEffect(() => {
      if (!backgroundDataUrl) { bgImageRef.current = null; return; }
      const img = new window.Image();
      img.crossOrigin = "anonymous";
      img.onload  = () => { bgImageRef.current = img; };
      img.onerror = () => { bgImageRef.current = null; };
      img.src = backgroundDataUrl;
    }, [backgroundDataUrl]);

    if (width === 0 || height === 0) return null;

    return (
      <div className="absolute inset-0 pointer-events-none z-10">
        {/* ── Committed strokes via Konva ── */}
        <Stage width={width} height={height} ref={stageRef} className="absolute inset-0">
          {/* Background (for composite export only) */}
          {bgImageRef.current && backgroundBounds && (
            <Layer listening={false}>
              <KonvaImage
                image={bgImageRef.current}
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
              const { shadowColor, shadowBlur } = getNeonGlow(
                stroke.color,
                stroke.glowIntensity ?? glowIntensity
              );
              const isHighlighter = stroke.tool === "highlighter";

              // Face-anchor delta
              let dx = 0, dy = 0;
              if (stroke.faceAnchor && faceData) {
                dx = faceData.screenCx - stroke.faceAnchor.cx;
                dy = faceData.screenCy - stroke.faceAnchor.cy;
              }

              // Dot strokes render as a filled Circle
              if (stroke.isJustDot) {
                const cx = stroke.points[0];
                const cy = stroke.points[1];
                const r  = Math.max((stroke.width ?? 4) * 0.65, 2.5);
                return (
                  <Group key={stroke.id} x={dx} y={dy}>
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
                <Group key={stroke.id} x={dx} y={dy}>
                  <Line
                    points={stroke.points}
                    stroke={stroke.color}
                    strokeWidth={isHighlighter ? stroke.width * 3 : stroke.width}
                    tension={0.4}
                    lineCap="round"
                    lineJoin="round"
                    opacity={isHighlighter ? 0.35 : 1}
                    shadowColor={shadowColor}
                    shadowBlur={isHighlighter ? shadowBlur * 0.5 : shadowBlur}
                    shadowOpacity={0.85}
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
