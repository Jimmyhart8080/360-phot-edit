export interface AnalysisResult {
  description: string;
  objects: string[];
  atmosphere: string;
  objectLocations?: { object: string; x: number; y: number }[];
}

export enum AppState {
  IDLE = 'IDLE',
  LOADING_IMAGE = 'LOADING_IMAGE',
  VIEWING = 'VIEWING',
  ANALYZING = 'ANALYZING',
  EDITING = 'EDITING',
  STYLING = 'STYLING', // New state for global style generation
}

export interface GlobalStyleOption {
  id: string;
  name: string;
  prompt: string;
  icon: string;
}

export enum ViewMode {
  SCROLL = 'SCROLL',
  PLANET = 'PLANET',
}

export interface ViewerConfig {
  showControls: boolean;
}

export interface MirrorState {
  enabled: boolean;
  direction: 'SKY_TO_GROUND' | 'GROUND_TO_SKY'; // Determines which side is reflected
  axis: number; // 0.0 to 1.0 (Vertical UV coordinate)
}

export interface MaskLayer {
  id: string;
  color: string;
  colorName: string;
  prompt: string;
}
