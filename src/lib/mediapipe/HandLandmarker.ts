import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

class HandLandmarkerManager {
  private static instance: HandLandmarkerManager;
  private landmarker: HandLandmarker | null = null;
  private initializing = false;
  private initPromise: Promise<HandLandmarker | null> | null = null;

  private constructor() {}

  public static getInstance(): HandLandmarkerManager {
    if (!HandLandmarkerManager.instance) {
      HandLandmarkerManager.instance = new HandLandmarkerManager();
    }
    return HandLandmarkerManager.instance;
  }

  public async initialize(): Promise<HandLandmarker | null> {
    if (typeof window === "undefined") return null;
    if (this.landmarker) return this.landmarker;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.initializing = true;
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );
        this.landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 2,
          // Lower thresholds → faster detection, especially near face/edge
          minHandDetectionConfidence: 0.35,
          minHandPresenceConfidence: 0.35,
          minTrackingConfidence: 0.65,
        });
        return this.landmarker;
      } catch (e) {
        console.warn("HandLandmarker GPU init failed, falling back to CPU", e);
        try {
          const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
          );
          this.landmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
              delegate: "CPU",
            },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.35,
            minHandPresenceConfidence: 0.35,
            minTrackingConfidence: 0.65,
          });
          return this.landmarker;
        } catch (e2) {
          console.error("HandLandmarker CPU init also failed", e2);
          return null;
        }
      } finally {
        this.initializing = false;
      }
    })();

    return this.initPromise;
  }

  public getLandmarker(): HandLandmarker | null {
    return this.landmarker;
  }
}

export const handLandmarkerManager = HandLandmarkerManager.getInstance();
