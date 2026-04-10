export type Point = {
  x: number;
  y: number;
};

/** Face bounding box + center, stored in SCREEN pixel coords (X already mirrored) */
export interface FaceData {
  /** Screen-space center X (mirrored) */
  screenCx: number;
  /** Screen-space center Y */
  screenCy: number;
  /** Screen-space bbox width */
  screenW: number;
  /** Screen-space bbox height */
  screenH: number;
  /** Raw (un-mirrored) normalized face bbox for containment checks */
  rawNormX: number;
  rawNormY: number;
  rawNormW: number;
  rawNormH: number;
}

/** Anchors a stroke to the face so it moves with head motion */
export interface FaceAnchor {
  /** Screen-space face center at the moment the stroke began */
  cx: number;
  cy: number;
}

export type Stroke = {
  id: string;
  points: number[]; // Flat array [x1, y1, x2, y2, …]
  color: string;
  width: number;
  tool: 'pen' | 'eraser' | 'highlighter';
  glowIntensity?: number;
  /** If true, this was a short tap — render as a filled dot */
  isJustDot?: boolean;
  /** If set, this stroke moves with the face */
  faceAnchor?: FaceAnchor;
  /** Bounding box for selection */
  boundingBox?: { minX: number; minY: number; maxX: number; maxY: number };
};

export type GestureType =
  | 'IDLE'
  | 'DRAW'
  | 'ERASE'
  | 'UNDO'
  | 'REDO'
  | 'PINCH'
  | 'GRAB'
  | 'CLEAR_HOLD'; // 4-finger hold-to-clear

export interface HandLandmark {
  x: number;
  y: number;
  z: number;
}

export interface HandInfo {
  landmarks: HandLandmark[];
  handedness: 'Left' | 'Right';
  index: number;
}

export interface TrackingResults {
  hands: HandInfo[];
  primaryHandIndex: number;
}

export interface AppSettings {
  glowIntensity: number;
  showFingerTrace: boolean;
  showSkeleton: boolean;
  trailOpacity: number;
  dominantHand: 'auto' | 'left' | 'right';
  eraserRadius: number;
  faceAnchorEnabled: boolean;
  showFaceAnchorHint: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  glowIntensity: 12,
  showFingerTrace: true,
  showSkeleton: true,
  trailOpacity: 0.7,
  dominantHand: 'auto',
  eraserRadius: 35,
  faceAnchorEnabled: true,
  showFaceAnchorHint: true,
};
