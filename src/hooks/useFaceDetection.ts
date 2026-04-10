"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { faceDetectorManager } from "@/lib/mediapipe/FaceDetector";
import { FaceData } from "@/types";

const FACE_DETECT_EVERY_N_FRAMES = 3;
const FACE_LOSS_FRAMES = 30; // ~1s at 30fps before nulling out

export function useFaceDetection(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  width: number,
  height: number,
  enabled: boolean
) {
  const [faceData, setFaceData] = useState<FaceData | null>(null);
  const [isReady, setIsReady] = useState(false);
  const frameCountRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const requestRef = useRef<number | null>(null);
  const isActiveRef = useRef(true);
  const missedFaceFrames = useRef(0);
  const widthRef  = useRef(width);
  const heightRef = useRef(height);
  widthRef.current  = width;
  heightRef.current = height;

  useEffect(() => {
    isActiveRef.current = true;
    if (!enabled) {
      setFaceData(null);
      return;
    }

    const init = async () => {
      const detector = await faceDetectorManager.initialize();
      if (isActiveRef.current && detector) setIsReady(true);
    };
    init();

    return () => {
      isActiveRef.current = false;
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [enabled]);

  const detect = useCallback(() => {
    if (!isReady || !enabled || !isActiveRef.current) return;

    const videoElement = videoRef.current;
    if (
      !videoElement ||
      videoElement.readyState < 2 ||
      videoElement.videoWidth === 0
    ) {
      requestRef.current = requestAnimationFrame(detect);
      return;
    }

    frameCountRef.current++;

    if (
      frameCountRef.current % FACE_DETECT_EVERY_N_FRAMES === 0 &&
      videoElement.currentTime !== lastVideoTimeRef.current
    ) {
      lastVideoTimeRef.current = videoElement.currentTime;
      const detector = faceDetectorManager.getDetector();

      if (detector) {
        try {
          const result = detector.detectForVideo(videoElement, performance.now());
          if (isActiveRef.current) {
            if (result.detections && result.detections.length > 0) {
              missedFaceFrames.current = 0;
              const det = result.detections[0];
              const bbox = det.boundingBox;
              if (bbox) {
                const vw = videoElement.videoWidth;
                const vh = videoElement.videoHeight;
                const rawNormX = bbox.originX / vw;
                const rawNormY = bbox.originY / vh;
                const rawNormW = bbox.width / vw;
                const rawNormH = bbox.height / vh;
                const rawNormCx = rawNormX + rawNormW / 2;
                const rawNormCy = rawNormY + rawNormH / 2;

                setFaceData({
                  screenCx: (1 - rawNormCx) * widthRef.current,
                  screenCy: rawNormCy * heightRef.current,
                  screenW: rawNormW * widthRef.current,
                  screenH: rawNormH * heightRef.current,
                  rawNormX,
                  rawNormY,
                  rawNormW,
                  rawNormH,
                });
              }
            } else {
              missedFaceFrames.current++;
              if (missedFaceFrames.current > FACE_LOSS_FRAMES) {
                setFaceData(null);
              }
            }
          }
        } catch {
          // Suppress transient detection errors
        }
      }
    }

    requestRef.current = requestAnimationFrame(detect);
    // videoRef is stable, widthRef/heightRef are updated directly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, enabled]);

  useEffect(() => {
    if (isReady && enabled) {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      requestRef.current = requestAnimationFrame(detect);
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isReady, enabled, detect]);

  return { faceData, faceDetectorReady: isReady };
}
