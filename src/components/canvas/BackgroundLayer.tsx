"use client";

import { useState, useEffect, useRef } from "react";
import { Document, Page, pdfjs } from "react-pdf";

// Use local worker for better reliability
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

export type BackgroundType = 'whiteboard' | 'image' | 'pdf';

interface BackgroundLayerProps {
  type: BackgroundType;
  source?: string;
  width: number;
  height: number;
  // Callback to provide Konva-ready image URL + bounds for composite export
  onBackgroundReady?: (dataUrl: string, bounds: { x: number; y: number; width: number; height: number }) => void;
  // PDF page state managed externally when multi-page navigation is needed
  pdfPage?: number;
  onPdfPagesLoaded?: (numPages: number) => void;
}

export const BackgroundLayer = ({
  type,
  source,
  width,
  height,
  onBackgroundReady,
  pdfPage = 1,
  onPdfPagesLoaded,
}: BackgroundLayerProps) => {
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);

  // ── Whiteboard ──
  if (type === 'whiteboard' || !source) {
    return (
      <div className="absolute inset-0 bg-[#0a0a0f]">
        {/* Subtle grid lines for whiteboard feel */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(148,163,184,1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(148,163,184,1) 1px, transparent 1px)
            `,
            backgroundSize: '48px 48px',
          }}
        />
      </div>
    );
  }

  // ── Image ──
  if (type === 'image') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black">
        {loadState === 'error' && (
          <div className="text-red-400 text-sm font-bold bg-red-900/30 px-6 py-3 rounded-xl border border-red-500/30">
            ⚠ Failed to load image
          </div>
        )}
        {loadState === 'loading' && <LoadingSpinner />}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={source}
          alt="Annotation background"
          className="max-w-full max-h-full object-contain pointer-events-none select-none"
          style={{ display: loadState === 'loaded' ? 'block' : 'none' }}
          crossOrigin="anonymous"
          onLoadStart={() => setLoadState('loading')}
          onLoad={(e) => {
            setLoadState('loaded');
            if (onBackgroundReady && imgRef.current) {
              // Compute rendered bounds (object-contain layout)
              const el = imgRef.current;
              const rect = el.getBoundingClientRect();
              // rect.left/top relative to parent container
              const parentEl = el.parentElement?.getBoundingClientRect();
              if (parentEl) {
                onBackgroundReady(source, {
                  x: rect.left - parentEl.left,
                  y: rect.top - parentEl.top,
                  width: rect.width,
                  height: rect.height,
                });
              }
            }
          }}
          onError={() => {
            setLoadState('error');
            setErrorMsg('Could not load image');
          }}
        />
      </div>
    );
  }

  // ── PDF ──
  if (type === 'pdf') {
    const pageWidth = Math.min(width * 0.9, 900);

    return (
      <div className="absolute inset-0 flex items-center justify-center bg-neutral-900 overflow-hidden">
        {loadState === 'error' && (
          <div className="text-red-400 text-sm font-bold bg-red-900/30 px-6 py-3 rounded-xl border border-red-500/30">
            ⚠ {errorMsg || 'Failed to load PDF'}
          </div>
        )}
        {loadState === 'loading' && <LoadingSpinner label="Rendering PDF…" />}
        <Document
          file={source}
          onLoadStart={() => setLoadState('loading')}
          onLoadSuccess={({ numPages }) => {
            setLoadState('loaded');
            onPdfPagesLoaded?.(numPages);
          }}
          onLoadError={(err) => {
            setLoadState('error');
            setErrorMsg(err.message);
          }}
          className="shadow-2xl"
        >
          <Page
            key={`pdf-page-${pdfPage}`}
            pageNumber={pdfPage}
            width={pageWidth}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            onRenderSuccess={() => {
              // After PDF page renders, capture it as an image for Konva export
              if (onBackgroundReady) {
                // Use a short timeout to allow the canvas to flush
                setTimeout(() => {
                  const pdfCanvas = document.querySelector('.react-pdf__Page__canvas') as HTMLCanvasElement;
                  if (pdfCanvas) {
                    try {
                      const dUrl = pdfCanvas.toDataURL('image/png');
                      const rect = pdfCanvas.getBoundingClientRect();
                      const parentRect = pdfCanvas.parentElement?.parentElement?.getBoundingClientRect();
                      if (parentRect) {
                        onBackgroundReady(dUrl, {
                          x: rect.left - parentRect.left,
                          y: rect.top - parentRect.top,
                          width: rect.width,
                          height: rect.height,
                        });
                      }
                    } catch {
                      // CORS or tainted canvas — skip background in export
                    }
                  }
                }, 200);
              }
            }}
          />
        </Document>
      </div>
    );
  }

  return null;
};

const LoadingSpinner = ({ label = "Loading…" }: { label?: string }) => (
  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10 pointer-events-none">
    <div className="w-10 h-10 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
    <p className="text-white/50 text-xs font-bold uppercase tracking-widest">{label}</p>
  </div>
);
