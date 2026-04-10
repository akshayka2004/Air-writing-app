import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";

/**
 * Singleton manager for the MediaPipe FaceDetector.
 * Uses the same WASM bundle as HandLandmarker (same CDN path).
 * This keeps both models consistent and avoids duplicate downloads.
 */
class FaceDetectorManager {
  private static instance: FaceDetectorManager;
  private detector: FaceDetector | null = null;
  private initializing = false;

  private constructor() {}

  public static getInstance(): FaceDetectorManager {
    if (!FaceDetectorManager.instance) {
      FaceDetectorManager.instance = new FaceDetectorManager();
    }
    return FaceDetectorManager.instance;
  }

  public async initialize(): Promise<FaceDetector | null> {
    if (typeof window === "undefined") return null;
    if (this.detector) return this.detector;
    if (this.initializing) {
      while (this.initializing) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return this.detector;
    }

    this.initializing = true;
    try {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
      );
      this.detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.5,
        minSuppressionThreshold: 0.3,
      });
      return this.detector;
    } catch (err) {
      console.warn("FaceDetector initialization failed:", err);
      return null;
    } finally {
      this.initializing = false;
    }
  }

  public getDetector(): FaceDetector | null {
    return this.detector;
  }
}

export const faceDetectorManager = FaceDetectorManager.getInstance();
