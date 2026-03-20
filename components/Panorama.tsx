import React, { useEffect, useRef, forwardRef, useImperativeHandle, useCallback, useState } from 'react';
import { useThree, useLoader, useFrame, extend } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls, shaderMaterial } from '@react-three/drei';
import { ViewMode, MirrorState } from '../types';

interface PanoramaProps {
  imageUrl: string;
  viewMode: ViewMode;
  mirrorState: MirrorState;
  isEditing: boolean;
  brushSize: number;
  activeColor: string;
  onMaskHover: (color: string | null, x: number, y: number) => void;
  onMaskRightClick?: (color: string, x: number, y: number) => void;
  showHistory: boolean;
}

export interface SnapshotConfig {
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  screenSize?: {
    width: number;
    height: number;
  };
  useCurvature?: boolean;
  onCapture?: (blob: Blob) => void;
}

export interface PanoramaHandle {
  takeSnapshot: (config?: SnapshotConfig) => void;
  undoPaint: () => void;
  clearPaint: () => void;
  paintNadir: () => void;
  commitToHistory: (layerMapping: { originalColor: string; newColor: string }[]) => void;
  getCropForGeneration: (prompt: string, colorHex: string, fromHistory?: boolean, saveBackup?: boolean) => Promise<{ cropBase64: string; rect: { x: number; y: number; width: number; height: number }, shiftX: number } | null>;
  getCompositeForGeneration: (activeLayers: { color: string }[]) => Promise<{ cropBase64: string; rect: { x: number; y: number; width: number; height: number }, shiftX: number } | null>;
  applyGeneratedPatch: (patchBase64: string, rect: { x: number; y: number; width: number; height: number }, shiftX: number, noBlend?: boolean) => Promise<void>;
  getFullImageBase64: () => string;
  restoreHistoryRegion: (color: string) => Promise<void>;
  lookAt: (lon: number, lat: number) => void;
}

// --- SHADER HELPERS ---
const mirrorShaderChunk = `
  vec2 getMirroredUV(vec2 uv, bool enabled, int direction, float axis) {
    if (!enabled) return uv;
    
    vec2 newUV = uv;
    
    if (direction == 0) { 
      // Sky to Ground: Mirror Top (source) to Bottom (target)
      if (newUV.y < axis) {
        float targetY = 2.0 * axis - newUV.y;
        if (targetY > 1.0) {
           targetY = 2.0 - targetY;
           newUV.x = newUV.x + 0.5;
        }
        newUV.y = targetY;
      }
    } else { 
      // Ground to Sky: Mirror Bottom (source) to Top (target)
      if (newUV.y > axis) {
        float targetY = 2.0 * axis - newUV.y;
        if (targetY < 0.0) {
           targetY = -targetY;
           newUV.x = newUV.x + 0.5;
        }
        newUV.y = targetY;
      }
    }
    
    return newUV;
  }
`;

const historyShaderChunk = `
  uniform sampler2D historyMap;
  uniform bool showHistory;

  vec4 applyHistory(vec4 color, vec2 uv) {
    if (!showHistory) return color;
    
    vec4 histColor = texture2D(historyMap, uv);
    if (histColor.a > 0.1) {
       // Overlay history. 
       // The texture is stored with alpha 1.0 to preserve color ID integrity.
       // We mix it here to make it look semi-transparent (50% opacity).
       return mix(color, vec4(histColor.rgb, 1.0), 0.5);
    }
    return color;
  }
`;

// Updated cursor function that takes resolution as argument to avoid conflict
const cursorShaderChunk = `
  uniform vec2 cursorUv;
  uniform float cursorSize;
  uniform bool showCursor;
  // Resolution is now passed as an argument, not a global uniform here to prevent redefinition

  vec4 applyCursor(vec4 color, vec2 uv, vec2 res) {
    if (!showCursor) return color;
    
    float aspect = res.x / res.y;
    vec2 diff = uv - cursorUv;
    
    // Handle Horizontal Wrap for distance calculation
    if (diff.x > 0.5) diff.x -= 1.0;
    if (diff.x < -0.5) diff.x += 1.0;
    
    diff.x *= aspect;
    float dist = length(diff);
    
    // Draw Ring - Made thinner for precision
    float thickness = 0.0015; 
    float aa = 0.002;
    
    // Border (Black outline for contrast)
    float borderAlpha = 1.0 - smoothstep(thickness + 0.0005, thickness + 0.0005 + aa, abs(dist - cursorSize));
    if (borderAlpha > 0.0) {
       color = mix(color, vec4(0.0, 0.0, 0.0, 1.0), borderAlpha * 0.5);
    }

    // Main Ring (White)
    float alpha = 1.0 - smoothstep(thickness, thickness + aa, abs(dist - cursorSize));
    if (alpha > 0.0) {
       color = mix(color, vec4(1.0, 1.0, 1.0, 1.0), alpha);
    }
    
    return color;
  }
`;

// --- SHADERS ---

const EquirectMaterial = shaderMaterial(
  { 
    map: null, 
    maskMap: null,
    historyMap: null,
    mirrorEnabled: false,
    mirrorDirection: 0, 
    mirrorAxis: 0.5,
    isEditing: false,
    showHistory: false,
    cursorUv: new THREE.Vector2(-1, -1),
    cursorSize: 0.05,
    showCursor: false,
    resolution: new THREE.Vector2(2048, 1024)
  },
  `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  `
    uniform sampler2D map;
    uniform sampler2D maskMap;
    uniform bool mirrorEnabled;
    uniform int mirrorDirection;
    uniform float mirrorAxis;
    uniform bool isEditing;
    uniform vec2 resolution; // Explicitly declared
    
    varying vec2 vUv;
    
    ${mirrorShaderChunk}
    ${cursorShaderChunk}
    ${historyShaderChunk}

    void main() {
      vec2 uv = getMirroredUV(vUv, mirrorEnabled, mirrorDirection, mirrorAxis);
      vec4 texColor = texture2D(map, uv);
      
      // Apply History Overlay first
      texColor = applyHistory(texColor, uv);

      if (isEditing) {
         vec4 maskColor = texture2D(maskMap, uv);
         if (maskColor.a > 0.0) {
             gl_FragColor = mix(texColor, maskColor, 0.6);
         } else {
             gl_FragColor = texColor;
         }
         // Apply cursor to the raw UV (where the user is pointing)
         // Pass resolution explicitly
         gl_FragColor = applyCursor(gl_FragColor, vUv, resolution);
      } else {
         gl_FragColor = texColor;
      }
      
      #include <colorspace_fragment>
    }
  `
);

const PlanetMaterial = shaderMaterial(
  { 
    map: null,
    maskMap: null,
    historyMap: null,
    resolution: new THREE.Vector2(1, 1), 
    zoom: 1.0, 
    rotateMat: new THREE.Matrix3(),
    mirrorEnabled: false,
    mirrorDirection: 0, 
    mirrorAxis: 0.5,
    cropRect: new THREE.Vector4(0, 0, 1, 1),
    isEditing: false,
    showHistory: false,
    cursorUv: new THREE.Vector2(-1, -1),
    cursorSize: 0.05,
    showCursor: false
  },
  `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  `
    #include <common>
    uniform sampler2D map;
    uniform sampler2D maskMap;
    uniform float zoom;
    uniform mat3 rotateMat;
    uniform vec4 cropRect;
    
    uniform bool mirrorEnabled;
    uniform int mirrorDirection;
    uniform float mirrorAxis;
    uniform bool isEditing;
    uniform vec2 resolution; // Explicitly declared

    varying vec2 vUv;

    ${mirrorShaderChunk}
    ${cursorShaderChunk}
    ${historyShaderChunk}

    void main() {
      // Map local UV (0..1 based on crop) to global UV (0..1 based on full screen)
      vec2 globalUV = vUv * cropRect.zw + cropRect.xy;
      
      vec2 st = (globalUV - 0.5) * 2.0;
      st.x *= resolution.x / resolution.y;

      float r = length(st);
      float phi = atan(st.y, st.x);

      float theta = 2.0 * atan(r / zoom);

      vec3 dir = vec3(sin(theta) * cos(phi), -cos(theta), sin(theta) * sin(phi));

      dir = rotateMat * dir;

      float lat = asin(clamp(dir.y, -1.0, 1.0));
      float lon = atan(dir.z, dir.x);

      // Flip U coordinate (0.5 - ...) to fix horizontal mirroring relative to inside-view
      vec2 rawUV = vec2(0.5 - lon / (2.0 * PI), lat / PI + 0.5);

      // Mirroring Logic
      vec2 uv = getMirroredUV(rawUV, mirrorEnabled, mirrorDirection, mirrorAxis);

      vec4 texColor = texture2D(map, uv);
      
      // Apply History Overlay
      texColor = applyHistory(texColor, uv);

      if (isEditing) {
         vec4 maskColor = texture2D(maskMap, uv);
         if (maskColor.a > 0.0) {
             gl_FragColor = mix(texColor, maskColor, 0.6);
         } else {
             gl_FragColor = texColor;
         }
         // Apply cursor to the raw UV (before mirroring) to show where mouse is
         // Pass resolution explicitly
         gl_FragColor = applyCursor(gl_FragColor, rawUV, resolution);
      } else {
         gl_FragColor = texColor;
      }

      #include <colorspace_fragment>
    }
  `
);

extend({ PlanetMaterial, EquirectMaterial });

// Helper to mirror UVs in JS (matching Shader Logic)
const applyMirrorToUV = (uv: THREE.Vector2, mirror: MirrorState) => {
  if (!mirror.enabled) return uv.clone();
  
  const newUV = uv.clone();
  const axis = mirror.axis;
  
  if (mirror.direction === 'SKY_TO_GROUND') {
      // If we are in the "Ground" area (y < axis)
      if (newUV.y < axis) {
          let targetY = 2.0 * axis - newUV.y;
          // Wrapping handling matching GLSL
          if (targetY > 1.0) {
              targetY = 2.0 - targetY;
              newUV.x = newUV.x + 0.5; // Shift X by 180 deg
          }
          newUV.y = targetY;
      }
  } else {
      // Ground to Sky
      if (newUV.y > axis) {
          let targetY = 2.0 * axis - newUV.y;
          if (targetY < 0.0) {
              targetY = -targetY;
              newUV.x = newUV.x + 0.5;
          }
          newUV.y = targetY;
      }
  }
  
  // Handle X wrapping
  if (newUV.x > 1.0) newUV.x -= 1.0;
  if (newUV.x < 0.0) newUV.x += 1.0;
  
  return newUV;
};

// Helper for hex string to RGB comparison
const hexToRgb = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
};

// Robust RGB to Hex
const rgbToHex = (r: number, g: number, b: number) => {
    return "#" + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// --- HELPER: Create a horizontally shifted version of a canvas ---
const createShiftedCanvas = (sourceCanvas: HTMLCanvasElement, offsetX: number) => {
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    const newCanvas = document.createElement('canvas');
    newCanvas.width = width;
    newCanvas.height = height;
    const ctx = newCanvas.getContext('2d');
    if (!ctx) return newCanvas;

    // Normalize offset
    let dx = offsetX % width;
    if (dx < 0) dx += width;

    // Easier: Draw image twice
    ctx.drawImage(sourceCanvas, dx, 0);
    ctx.drawImage(sourceCanvas, dx - width, 0);

    return newCanvas;
};

// --- HELPER: Calculate Circular Centroid of Mask ---
const getMaskCentroidX = (
    maskCtx: CanvasRenderingContext2D, 
    width: number, 
    height: number, 
    targetColors: {r: number, g: number, b: number}[],
    tolerance: number = 50
) => {
    const data = maskCtx.getImageData(0, 0, width, height).data;
    let sumSin = 0;
    let sumCos = 0;
    let count = 0;

    for (let y = 0; y < height; y += 4) { // Optimization: skip rows
        for (let x = 0; x < width; x += 4) { // Optimization: skip cols
            const index = (y * width + x) * 4;
            if (data[index + 3] > 50) {
                const r = data[index];
                const g = data[index + 1];
                const b = data[index + 2];
                
                const isMatch = targetColors.some(c => 
                    Math.abs(r - c.r) < tolerance && 
                    Math.abs(g - c.g) < tolerance && 
                    Math.abs(b - c.b) < tolerance
                );

                if (isMatch) {
                    const theta = (x / width) * 2 * Math.PI;
                    sumSin += Math.sin(theta);
                    sumCos += Math.cos(theta);
                    count++;
                }
            }
        }
    }

    if (count === 0) return width / 2;

    const avgTheta = Math.atan2(sumSin / count, sumCos / count);
    let normalizedTheta = avgTheta;
    if (normalizedTheta < 0) normalizedTheta += 2 * Math.PI;

    return (normalizedTheta / (2 * Math.PI)) * width;
};

const Panorama = forwardRef<PanoramaHandle, PanoramaProps>(({ imageUrl, viewMode, mirrorState, isEditing, brushSize, activeColor, onMaskHover, onMaskRightClick, showHistory }, ref) => {
  const { camera, gl, scene, size } = useThree();
  const controlsRef = useRef<any>(null);
  const planetMatRef = useRef<any>(null);
  const equirectMatRef = useRef<any>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  
  const targetFov = useRef(75);
  const lastTouchDistance = useRef<number | null>(null);
  
  const mirrorStateRef = useRef(mirrorState);
  mirrorStateRef.current = mirrorState;

  const activeColorRef = useRef(activeColor);
  activeColorRef.current = activeColor;
  
  const showHistoryRef = useRef(showHistory);
  showHistoryRef.current = showHistory;
  
  const onMaskRightClickRef = useRef(onMaskRightClick);
  onMaskRightClickRef.current = onMaskRightClick;

  // Painting State
  const maskCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const maskCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const maskTextureRef = useRef<THREE.CanvasTexture | null>(null);
  
  // History State
  const historyCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const historyCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const historyTextureRef = useRef<THREE.CanvasTexture | null>(null);

  const mainCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const mainCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const mainTextureRef = useRef<THREE.Texture | null>(null);
  
  // Backups for regeneration
  const backupsRef = useRef<Record<string, { cropBase64: string; rect: { x: number; y: number; width: number; height: number }; shiftX: number }>>({});
  
  const paintHistoryRef = useRef<ImageData[]>([]);
  const isPaintingRef = useRef(false);
  const raycaster = useRef(new THREE.Raycaster());

  const planetState = useRef({
    quaternion: new THREE.Quaternion(),
    targetQuaternion: new THREE.Quaternion(),
    zoom: 0.6,
    targetZoom: 0.6,
    isDragging: false,
    lastX: 0,
    lastY: 0
  });

  // Initialize Textures
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.src = imageUrl;
    img.onload = () => {
        // Determine safe dimensions for mobile
        const maxTexSize = gl.capabilities.maxTextureSize;
        const safeLimit = 4096; // 4K limit for broad mobile stability
        const limit = Math.min(maxTexSize, safeLimit);
        
        let w = img.width;
        let h = img.height;

        if (w > limit || h > limit) {
             const scale = Math.min(limit / w, limit / h);
             w = Math.round(w * scale);
             h = Math.round(h * scale);
             console.log(`[OmniView] Downscaling image from ${img.width}x${img.height} to ${w}x${h} for performance.`);
        }

        // Setup Main Canvas (Source of Truth)
        mainCanvasRef.current.width = w;
        mainCanvasRef.current.height = h;
        const mainCtx = mainCanvasRef.current.getContext('2d');
        if (mainCtx) {
            mainCtx.drawImage(img, 0, 0, w, h);
            mainCtxRef.current = mainCtx;
        }

        // Setup Main Texture
        const texture = new THREE.CanvasTexture(mainCanvasRef.current);
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.needsUpdate = true;
        mainTextureRef.current = texture;

        // Setup Mask & History Canvas (Optimized Resolution for editing)
        // Maintain original aspect ratio
        const ASPECT = img.width / img.height;
        const MASK_WIDTH = Math.min(1024, w);
        const MASK_HEIGHT = Math.round(MASK_WIDTH / ASPECT);

        maskCanvasRef.current.width = MASK_WIDTH;
        maskCanvasRef.current.height = MASK_HEIGHT;
        const maskCtx = maskCanvasRef.current.getContext('2d', { willReadFrequently: true });
        if (maskCtx) {
            maskCtx.clearRect(0, 0, MASK_WIDTH, MASK_HEIGHT);
            maskCtxRef.current = maskCtx;
            paintHistoryRef.current = [maskCtx.getImageData(0, 0, MASK_WIDTH, MASK_HEIGHT)];
        }
        
        // Setup History Canvas
        historyCanvasRef.current.width = MASK_WIDTH;
        historyCanvasRef.current.height = MASK_HEIGHT;
        const historyCtx = historyCanvasRef.current.getContext('2d', { willReadFrequently: true });
        if (historyCtx) {
            historyCtx.clearRect(0, 0, MASK_WIDTH, MASK_HEIGHT);
            historyCtxRef.current = historyCtx;
        }

        // Clear Backups on new image load
        backupsRef.current = {};

        // Setup Textures
        const maskTex = new THREE.CanvasTexture(maskCanvasRef.current);
        maskTex.minFilter = THREE.LinearFilter;
        maskTex.magFilter = THREE.LinearFilter;
        maskTextureRef.current = maskTex;
        
        const historyTex = new THREE.CanvasTexture(historyCanvasRef.current);
        historyTex.minFilter = THREE.LinearFilter;
        historyTex.magFilter = THREE.LinearFilter;
        historyTextureRef.current = historyTex;

        // Force Re-render to apply textures immediately
        if (equirectMatRef.current) {
            equirectMatRef.current.map = mainTextureRef.current;
            equirectMatRef.current.maskMap = maskTextureRef.current;
            equirectMatRef.current.historyMap = historyTextureRef.current;
            equirectMatRef.current.uniforms.resolution.value.set(w, h);
        }
        if (planetMatRef.current) {
            planetMatRef.current.map = mainTextureRef.current;
            planetMatRef.current.maskMap = maskTextureRef.current;
            planetMatRef.current.historyMap = historyTextureRef.current;
            planetMatRef.current.uniforms.resolution.value.set(w, h);
        }
    };
  }, [imageUrl]); 

  // Ensure textures are bound when view changes
  useEffect(() => {
      if (mainTextureRef.current) {
          if (equirectMatRef.current) equirectMatRef.current.map = mainTextureRef.current;
          if (planetMatRef.current) planetMatRef.current.map = mainTextureRef.current;
      }
      if (maskTextureRef.current) {
          if (equirectMatRef.current) equirectMatRef.current.maskMap = maskTextureRef.current;
          if (planetMatRef.current) planetMatRef.current.maskMap = maskTextureRef.current;
      }
      if (historyTextureRef.current) {
          if (equirectMatRef.current) equirectMatRef.current.historyMap = historyTextureRef.current;
          if (planetMatRef.current) planetMatRef.current.historyMap = historyTextureRef.current;
      }
      if (mainCanvasRef.current.width > 0) {
          const res = new THREE.Vector2(mainCanvasRef.current.width, mainCanvasRef.current.height);
          if (equirectMatRef.current) equirectMatRef.current.uniforms.resolution.value.copy(res);
          if (planetMatRef.current) planetMatRef.current.uniforms.resolution.value.copy(res);
      }
  }, [viewMode, imageUrl]);

  // Update Brush Size Uniforms
  useEffect(() => {
      const width = mainCanvasRef.current.width || 2048;
      const height = mainCanvasRef.current.height || 1024;
      const aspect = width / height;
      const cursorSize = (brushSize / 2048) * aspect;

      if (equirectMatRef.current) equirectMatRef.current.uniforms.cursorSize.value = cursorSize;
      if (planetMatRef.current) planetMatRef.current.uniforms.cursorSize.value = cursorSize;
  }, [brushSize]);

  useEffect(() => {
    const dirInt = mirrorState.direction === 'SKY_TO_GROUND' ? 0 : 1;
    
    if (planetMatRef.current) {
      planetMatRef.current.uniforms.mirrorEnabled.value = mirrorState.enabled;
      planetMatRef.current.uniforms.mirrorDirection.value = dirInt;
      planetMatRef.current.uniforms.mirrorAxis.value = mirrorState.axis;
      planetMatRef.current.uniforms.isEditing.value = isEditing;
      planetMatRef.current.uniforms.showHistory.value = showHistory;
    }
    if (equirectMatRef.current) {
      equirectMatRef.current.uniforms.mirrorEnabled.value = mirrorState.enabled;
      equirectMatRef.current.uniforms.mirrorDirection.value = dirInt;
      equirectMatRef.current.uniforms.mirrorAxis.value = mirrorState.axis;
      equirectMatRef.current.uniforms.isEditing.value = isEditing;
      equirectMatRef.current.uniforms.showHistory.value = showHistory;
    }
    
    if (!isEditing) {
       if (equirectMatRef.current) equirectMatRef.current.uniforms.showCursor.value = false;
       if (planetMatRef.current) planetMatRef.current.uniforms.showCursor.value = false;
    }

  }, [mirrorState, isEditing, showHistory]);

  const applyZoom = useCallback((delta: number) => {
    if (viewMode === ViewMode.SCROLL) {
       if ((camera as any).isPerspectiveCamera) {
         const pCam = camera as THREE.PerspectiveCamera;
         const zoomSpeed = 0.05; 
         const minFov = 10;     
         const maxFov = 110;
         const newFov = targetFov.current - delta * zoomSpeed;
         targetFov.current = THREE.MathUtils.clamp(newFov, minFov, maxFov);
       }
    } else if (viewMode === ViewMode.PLANET) {
       const zoomSpeed = 0.003;
       const minZoom = 0.2; 
       const maxZoom = 4.0; 
       const newZoom = planetState.current.targetZoom + delta * zoomSpeed;
       planetState.current.targetZoom = THREE.MathUtils.clamp(newZoom, minZoom, maxZoom);
    }
  }, [viewMode, camera]);

  const rotatePlanet = useCallback((dx: number, dy: number) => {
      const speed = 0.004;
      const qYaw = new THREE.Quaternion();
      qYaw.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * speed);
      const qPitch = new THREE.Quaternion();
      qPitch.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dy * speed);
      planetState.current.targetQuaternion.premultiply(qYaw);
      planetState.current.targetQuaternion.multiply(qPitch);
      planetState.current.targetQuaternion.normalize();
  }, []);

  const paintOnUV = useCallback((rawUV: THREE.Vector2) => {
      if (!maskCtxRef.current || !maskTextureRef.current) return;
      
      const uv = applyMirrorToUV(rawUV, mirrorStateRef.current);

      const ctx = maskCtxRef.current;
      const w = maskCanvasRef.current.width;
      const h = maskCanvasRef.current.height;
      const x = uv.x * w;
      const y = (1.0 - uv.y) * h;
      
      const scale = w / 2048;
      const r = brushSize * scale;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = activeColorRef.current; 
      ctx.fill();

      // Handle Horizontal Wrapping (Seam)
      if (x < r) {
        ctx.beginPath();
        ctx.arc(x + w, y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (x > w - r) {
        ctx.beginPath();
        ctx.arc(x - w, y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      maskTextureRef.current.needsUpdate = true;
  }, [brushSize]);

  const getPlanetUV = useCallback((clientX: number, clientY: number, screenW: number, screenH: number) => {
      const u = clientX / screenW;
      const v = 1.0 - clientY / screenH; 

      let stX = (u - 0.5) * 2.0;
      let stY = (v - 0.5) * 2.0;
      const aspect = screenW / screenH;
      stX *= aspect;

      const r = Math.sqrt(stX * stX + stY * stY);
      const phi = Math.atan2(stY, stX);

      const zoom = planetState.current.zoom; 
      const theta = 2.0 * Math.atan(r / zoom);

      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);

      const dir = new THREE.Vector3(
          sinTheta * cosPhi,
          -cosTheta,
          sinTheta * sinPhi
      );

      dir.applyQuaternion(planetState.current.quaternion);

      const lat = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      const lon = Math.atan2(dir.z, dir.x);

      const finalU = 0.5 - lon / (2.0 * Math.PI);
      const finalV = lat / Math.PI + 0.5;

      return new THREE.Vector2(finalU, finalV);
  }, []);

  const getUVFromEvent = useCallback((clientX: number, clientY: number) => {
      if (viewMode === ViewMode.PLANET) {
          return getPlanetUV(clientX, clientY, size.width, size.height);
      } else if (viewMode === ViewMode.SCROLL && meshRef.current) {
          const x = (clientX / size.width) * 2 - 1;
          const y = -(clientY / size.height) * 2 + 1;
          raycaster.current.setFromCamera(new THREE.Vector2(x, y), camera);
          const intersects = raycaster.current.intersectObject(meshRef.current);
          if (intersects.length > 0) {
              return intersects[0].uv!;
          }
      }
      return null;
  }, [viewMode, camera, size, getPlanetUV]);

  const checkMaskHover = useCallback((rawUV: THREE.Vector2, clientX: number, clientY: number) => {
      const uv = applyMirrorToUV(rawUV, mirrorStateRef.current);
      let foundColor: string | null = null;
      
      const clamp = (val: number, max: number) => Math.max(0, Math.min(max - 1, Math.floor(val)));
      
      // Check Current Mask
      if (maskCtxRef.current && maskCanvasRef.current) {
          const w = maskCanvasRef.current.width;
          const h = maskCanvasRef.current.height;
          const x = clamp(uv.x * w, w);
          const y = clamp((1.0 - uv.y) * h, h);
          const pixel = maskCtxRef.current.getImageData(x, y, 1, 1).data;
          if (pixel[3] > 50) {
              foundColor = rgbToHex(pixel[0], pixel[1], pixel[2]);
          }
      }

      // Check History Mask if visible and nothing found on active mask
      if (!foundColor && showHistoryRef.current && historyCtxRef.current && historyCanvasRef.current) {
          const w = historyCanvasRef.current.width;
          const h = historyCanvasRef.current.height;
          const x = clamp(uv.x * w, w);
          const y = clamp((1.0 - uv.y) * h, h);
          const pixel = historyCtxRef.current.getImageData(x, y, 1, 1).data;
          if (pixel[3] > 50) { 
              foundColor = rgbToHex(pixel[0], pixel[1], pixel[2]);
          }
      }
      
      return foundColor;
  }, [showHistoryRef]);

  const handlePointerMove = useCallback((e: MouseEvent | TouchEvent) => {
      const isEditMode = isEditing;
      const isHistoryMode = showHistoryRef.current;
      
      if (!isEditMode && !isHistoryMode) return;

      const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;

      const targetUV = getUVFromEvent(clientX, clientY);

      if (targetUV) {
         if (isEditMode) {
             if (equirectMatRef.current) {
                 equirectMatRef.current.uniforms.cursorUv.value.copy(targetUV);
                 equirectMatRef.current.uniforms.showCursor.value = true;
             }
             if (planetMatRef.current) {
                 planetMatRef.current.uniforms.cursorUv.value.copy(targetUV);
                 planetMatRef.current.uniforms.showCursor.value = true;
             }

             if (isPaintingRef.current) {
                 paintOnUV(targetUV);
             }
         }
         
         if (!isPaintingRef.current) {
             const color = checkMaskHover(targetUV, clientX, clientY);
             onMaskHover(color, color ? clientX : 0, color ? clientY : 0);
         }

      } else {
         if (equirectMatRef.current) equirectMatRef.current.uniforms.showCursor.value = false;
         if (planetMatRef.current) planetMatRef.current.uniforms.showCursor.value = false;
         onMaskHover(null, 0, 0);
      }

  }, [isEditing, getUVFromEvent, paintOnUV, checkMaskHover, onMaskHover]);

  const handlePointerDown = useCallback((e: MouseEvent | TouchEvent) => {
     if (!isEditing) return;
     
     if ('button' in e && e.button !== 0) return;

     isPaintingRef.current = true;
     onMaskHover(null, 0, 0); 

     if (maskCtxRef.current && maskCanvasRef.current) {
         if (paintHistoryRef.current.length > 8) paintHistoryRef.current.shift();
         paintHistoryRef.current.push(
             maskCtxRef.current.getImageData(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height)
         );
     }

     handlePointerMove(e);
  }, [isEditing, handlePointerMove, onMaskHover]);

  const handlePointerUp = useCallback(() => {
     isPaintingRef.current = false;
  }, []);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    if (!showHistoryRef.current || isPaintingRef.current) return;
    
    e.preventDefault();
    const targetUV = getUVFromEvent(e.clientX, e.clientY);
    
    if (targetUV) {
        const color = checkMaskHover(targetUV, e.clientX, e.clientY);
        if (color && onMaskRightClickRef.current) {
            onMaskRightClickRef.current(color, e.clientX, e.clientY);
        }
    }
  }, [getUVFromEvent, checkMaskHover]);

  useEffect(() => {
    const canvas = gl.domElement;
    
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      applyZoom(-event.deltaY); 
    };

    const onTouchStart = (e: TouchEvent) => {
        if (isEditing) {
             e.preventDefault();
             if (e.touches.length === 1) handlePointerDown(e);
             return;
        }

        if (e.touches.length === 2) {
            lastTouchDistance.current = getTouchDistance(e);
            planetState.current.isDragging = false; 
        } else if (e.touches.length === 1 && viewMode === ViewMode.PLANET) {
            planetState.current.isDragging = true;
            planetState.current.lastX = e.touches[0].clientX;
            planetState.current.lastY = e.touches[0].clientY;
        }
    };

    const onTouchMove = (e: TouchEvent) => {
        if (isEditing) {
            e.preventDefault(); 
            if (e.touches.length === 1) handlePointerMove(e);
            return;
        }

        if (e.touches.length === 2) {
             e.preventDefault();
             e.stopPropagation(); 
             const dist = getTouchDistance(e);
             if (lastTouchDistance.current !== null) {
                 const delta = dist - lastTouchDistance.current;
                 applyZoom(delta * 5.0);
             }
             lastTouchDistance.current = dist;
             return;
        }

        if (e.touches.length === 1 && viewMode === ViewMode.PLANET) {
             e.preventDefault();
             if (!planetState.current.isDragging) return;
             const clientX = e.touches[0].clientX;
             const clientY = e.touches[0].clientY;
             const deltaX = clientX - planetState.current.lastX;
             const deltaY = clientY - planetState.current.lastY;
             rotatePlanet(deltaX, deltaY);
             planetState.current.lastX = clientX;
             planetState.current.lastY = clientY;
        }
    };

    const onTouchEnd = (e: TouchEvent) => {
        if (isEditing) {
            e.preventDefault();
            handlePointerUp();
            return;
        }
        lastTouchDistance.current = null;
        planetState.current.isDragging = false;
    };

    const onMouseDown = (e: MouseEvent) => {
       if (isEditing && e.button === 0) {
           handlePointerDown(e);
           return;
       }
       
       if (viewMode === ViewMode.PLANET) {
           const allowDrag = !isEditing || e.button === 1;
           if (allowDrag) {
               planetState.current.isDragging = true;
               planetState.current.lastX = e.clientX;
               planetState.current.lastY = e.clientY;
           }
       }
    };

    const onMouseMove = (e: MouseEvent) => {
       if ((isEditing || showHistoryRef.current) && !planetState.current.isDragging) {
           handlePointerMove(e);
       }
       
       if (viewMode !== ViewMode.PLANET || !planetState.current.isDragging) return;
       
       const deltaX = e.clientX - planetState.current.lastX;
       const deltaY = e.clientY - planetState.current.lastY;
       rotatePlanet(deltaX, deltaY);
       planetState.current.lastX = e.clientX;
       planetState.current.lastY = e.clientY;
    };

    const onMouseUp = () => {
       if (isEditing) {
           handlePointerUp();
       }
       planetState.current.isDragging = false;
    };

    const getTouchDistance = (e: TouchEvent) => {
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        return Math.sqrt(dx*dx + dy*dy);
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('contextmenu', handleContextMenu);

    return () => {
      canvas.removeEventListener('wheel', handleWheel, { capture: true } as any);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [gl, viewMode, applyZoom, rotatePlanet, isEditing, handlePointerDown, handlePointerMove, handlePointerUp, handleContextMenu]);

  useFrame(() => {
    if (viewMode === ViewMode.SCROLL && (camera as any).isPerspectiveCamera) {
      const pCam = camera as THREE.PerspectiveCamera;
      if (Math.abs(pCam.fov - targetFov.current) > 0.1) {
        pCam.fov = THREE.MathUtils.lerp(pCam.fov, targetFov.current, 0.1);
        pCam.updateProjectionMatrix();
      }
    }

    if (viewMode === ViewMode.PLANET && planetMatRef.current) {
       planetState.current.zoom = THREE.MathUtils.lerp(
         planetState.current.zoom,
         planetState.current.targetZoom,
         0.1
       );
       planetState.current.quaternion.slerp(planetState.current.targetQuaternion, 0.1);

       const rotationMatrix = new THREE.Matrix3();
       rotationMatrix.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(planetState.current.quaternion));

       planetMatRef.current.uniforms.rotateMat.value = rotationMatrix;
       planetMatRef.current.uniforms.zoom.value = planetState.current.zoom;
       
       if (gl.domElement.width === size.width) {
          planetMatRef.current.uniforms.cropRect.value.set(0, 0, 1, 1);
       }
    }
  });

  useImperativeHandle(ref, () => ({
    takeSnapshot: (config) => {
        const originalSize = new THREE.Vector2();
        gl.getSize(originalSize);
        
        let originalFov = 75;
        let originalAspect = 1;
        if ((camera as any).isPerspectiveCamera) {
            const pCam = camera as THREE.PerspectiveCamera;
            originalFov = pCam.fov;
            originalAspect = pCam.aspect;
        }

        const restore = () => {
            gl.setSize(originalSize.x, originalSize.y);
            if (viewMode === ViewMode.PLANET && planetMatRef.current) {
               planetMatRef.current.uniforms.zoom.value = planetState.current.zoom;
               planetMatRef.current.uniforms.cropRect.value.set(0, 0, 1, 1);
            }
            if ((camera as any).isPerspectiveCamera) {
                 const pCam = camera as THREE.PerspectiveCamera;
                 pCam.aspect = originalAspect;
                 pCam.fov = originalFov;
                 pCam.clearViewOffset();
                 pCam.updateProjectionMatrix();
            }
        };

        try {
            const MAX_DIM = 4096;
            if (!config || !config.rect) {
                const aspect = originalSize.x / originalSize.y;
                const w = Math.min(originalSize.x, MAX_DIM);
                const h = w / aspect;
                gl.setSize(w, h);
                gl.render(scene, camera);
            } else {
                 const { rect, screenSize } = config;
                 if (!screenSize) throw new Error("screenSize missing");
                 const targetAspect = rect.width / rect.height;
                 let w = 0, h = 0;
                 if (targetAspect > 1) { w = MAX_DIM; h = Math.round(w / targetAspect); } 
                 else { h = MAX_DIM; w = Math.round(h * targetAspect); }
                 const scale = w / rect.width;
                 const virtualW = screenSize.width * scale;
                 const virtualH = screenSize.height * scale;
                 const virtualX = rect.x * scale;
                 const virtualY = rect.y * scale;

                 gl.setSize(w, h);

                 if (viewMode === ViewMode.PLANET && planetMatRef.current) {
                    planetMatRef.current.uniforms.zoom.value = planetState.current.zoom;
                    const normX = rect.x / screenSize.width;
                    const normY = (screenSize.height - (rect.y + rect.height)) / screenSize.height;
                    const normW = rect.width / screenSize.width;
                    const normH = rect.height / screenSize.height;
                    planetMatRef.current.uniforms.cropRect.value.set(normX, normY, normW, normH);
                    gl.render(scene, camera);
                 } else if ((camera as any).isPerspectiveCamera) {
                    const pCam = camera as THREE.PerspectiveCamera;
                    pCam.aspect = screenSize.width / screenSize.height;
                    pCam.fov = originalFov; 
                    pCam.setViewOffset(virtualW, virtualH, virtualX, virtualY, w, h);
                    pCam.updateProjectionMatrix();
                    gl.render(scene, camera);
                 }
            }

            gl.domElement.toBlob((blob) => {
                if (blob) {
                    if (config?.onCapture) config.onCapture(blob);
                    else {
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.style.display = 'none';
                        document.body.appendChild(link);
                        link.download = `omniview-${Date.now()}.jpg`;
                        link.href = url;
                        link.click();
                        document.body.removeChild(link);
                        URL.revokeObjectURL(url);
                    }
                }
                restore();
            }, 'image/jpeg', 0.95);
        } catch (e) {
            console.error(e);
            restore();
        }
    },
    
    undoPaint: () => {
        if (!maskCtxRef.current || !maskTextureRef.current || paintHistoryRef.current.length === 0) return;
        const lastState = paintHistoryRef.current.pop();
        if (lastState) {
            maskCtxRef.current.putImageData(lastState, 0, 0);
        } else {
            maskCtxRef.current.clearRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
        }
        maskTextureRef.current.needsUpdate = true;
    },

    clearPaint: () => {
        if (!maskCtxRef.current || !maskTextureRef.current) return;
        maskCtxRef.current.clearRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
        paintHistoryRef.current = [];
        maskTextureRef.current.needsUpdate = true;
    },

    paintNadir: () => {
        if (!maskCtxRef.current || !maskTextureRef.current) return;
        if (paintHistoryRef.current.length > 8) paintHistoryRef.current.shift();
        paintHistoryRef.current.push(
            maskCtxRef.current.getImageData(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height)
        );

        const ctx = maskCtxRef.current;
        const h = maskCanvasRef.current.height;
        const w = maskCanvasRef.current.width;
        
        ctx.fillStyle = activeColorRef.current;
        ctx.fillRect(0, h * 0.85, w, h * 0.15);
        
        maskTextureRef.current.needsUpdate = true;
    },
    
    commitToHistory: (layerMapping: { originalColor: string; newColor: string }[]) => {
        if (!maskCtxRef.current || !historyCtxRef.current || !historyTextureRef.current) return;
        
        const w = maskCanvasRef.current.width;
        const h = maskCanvasRef.current.height;
        
        const maskData = maskCtxRef.current.getImageData(0, 0, w, h);
        const historyData = historyCtxRef.current.getImageData(0, 0, w, h);
        const md = maskData.data;
        const hd = historyData.data;

        const colorMap: Record<string, {r:number, g:number, b:number}> = {};
        
        layerMapping.forEach(m => {
            const origin = hexToRgb(m.originalColor);
            const target = hexToRgb(m.newColor);
            colorMap[`${origin.r},${origin.g},${origin.b}`] = target;
            
            // Transfer backup data to new color ID
            // Normalize keys to lowercase for robustness
            const originKey = m.originalColor.toLowerCase();
            const targetKey = m.newColor.toLowerCase();

            if (backupsRef.current[originKey]) {
                backupsRef.current[targetKey] = backupsRef.current[originKey];
                delete backupsRef.current[originKey];
            } else {
                console.warn("Panorama: No backup found for origin key during commit:", originKey);
            }
        });

        const tolerance = 50;

        for (let i = 0; i < md.length; i += 4) {
            if (md[i + 3] > 50) {
                const r = md[i];
                const g = md[i + 1];
                const b = md[i + 2];
                
                for (const key in colorMap) {
                    const [tr, tg, tb] = key.split(',').map(Number);
                    if (Math.abs(r - tr) < tolerance && 
                        Math.abs(g - tg) < tolerance && 
                        Math.abs(b - tb) < tolerance) {
                        
                        const target = colorMap[key];
                        hd[i] = target.r;
                        hd[i + 1] = target.g;
                        hd[i + 2] = target.b;
                        hd[i + 3] = 255; 
                        break;
                    }
                }
            }
        }
        
        historyCtxRef.current.putImageData(historyData, 0, 0);
        historyTextureRef.current.needsUpdate = true;
    },

    getCropForGeneration: async (prompt: string, colorHex: string, fromHistory: boolean = false, saveBackup: boolean = true) => {
        const targetCtx = fromHistory ? historyCtxRef.current : maskCtxRef.current;
        const targetCanvas = fromHistory ? historyCanvasRef.current : maskCanvasRef.current;
        
        if (!targetCtx || !targetCanvas || !mainCtxRef.current) return null;

        const targetRGB = hexToRgb(colorHex);
        const maskWidth = targetCanvas.width;
        const maskHeight = targetCanvas.height;

        const centroidX = getMaskCentroidX(targetCtx, maskWidth, maskHeight, [targetRGB]);
        const idealCenter = maskWidth / 2;
        const shiftX = Math.round(idealCenter - centroidX);

        const scaleX = mainCanvasRef.current.width / maskWidth;
        const mainShiftX = Math.round(shiftX * scaleX);

        const shiftedMain = createShiftedCanvas(mainCanvasRef.current, mainShiftX);
        const shiftedMask = createShiftedCanvas(targetCanvas, shiftX);
        
        const shiftedMaskCtx = shiftedMask.getContext('2d');
        if (!shiftedMaskCtx) return null;
        
        const maskData = shiftedMaskCtx.getImageData(0, 0, maskWidth, maskHeight);
        const data = maskData.data;

        let minX = maskWidth, minY = maskHeight, maxX = 0, maxY = 0;
        let hasMask = false;
        const tolerance = 50; 
        
        for (let y = 0; y < maskHeight; y++) {
            for (let x = 0; x < maskWidth; x++) {
                const index = (y * maskWidth + x) * 4;
                const r = data[index];
                const g = data[index + 1];
                const b = data[index + 2];
                const a = data[index + 3];

                if (a > 50) { 
                    if (Math.abs(r - targetRGB.r) < tolerance && 
                        Math.abs(g - targetRGB.g) < tolerance && 
                        Math.abs(b - targetRGB.b) < tolerance) {
                        
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                        hasMask = true;
                    }
                }
            }
        }

        if (!hasMask) return null;

        const scaleY = mainCanvasRef.current.height / maskHeight;

        let realMinX = Math.floor(minX * scaleX);
        let realMinY = Math.floor(minY * scaleY);
        let realMaxX = Math.ceil(maxX * scaleX);
        let realMaxY = Math.ceil(maxY * scaleY);

        const PADDING = 128;
        realMinX = Math.max(0, realMinX - PADDING);
        realMinY = Math.max(0, realMinY - PADDING);
        realMaxX = Math.min(shiftedMain.width, realMaxX + PADDING);
        realMaxY = Math.min(shiftedMain.height, realMaxY + PADDING);

        const cropW = realMaxX - realMinX;
        const cropH = realMaxY - realMinY;
        
        if (cropW <= 0 || cropH <= 0) return null;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = cropW;
        tempCanvas.height = cropH;
        const ctx = tempCanvas.getContext('2d');
        if (!ctx) return null;

        ctx.drawImage(shiftedMain, realMinX, realMinY, cropW, cropH, 0, 0, cropW, cropH);
        
        const tempMaskCanvas = document.createElement('canvas');
        tempMaskCanvas.width = maskWidth;
        tempMaskCanvas.height = maskHeight;
        const tempMaskCtx = tempMaskCanvas.getContext('2d');
        if (tempMaskCtx) {
             const filteredData = tempMaskCtx.createImageData(maskWidth, maskHeight);
             for (let i = 0; i < data.length; i += 4) {
                 const r = data[i];
                 const g = data[i+1];
                 const b = data[i+2];
                 const a = data[i+3];
                 if (a > 50 && 
                     Math.abs(r - targetRGB.r) < tolerance && 
                     Math.abs(g - targetRGB.g) < tolerance && 
                     Math.abs(b - targetRGB.b) < tolerance) {
                     filteredData.data[i] = r;
                     filteredData.data[i+1] = g;
                     filteredData.data[i+2] = b;
                     filteredData.data[i+3] = 255; 
                 }
             }
             tempMaskCtx.putImageData(filteredData, 0, 0);
             
             const sourceX = realMinX / scaleX;
             const sourceY = realMinY / scaleY;
             const sourceW = cropW / scaleX;
             const sourceH = cropH / scaleY;

             ctx.globalAlpha = 1.0;
             ctx.drawImage(
                tempMaskCanvas, 
                sourceX, sourceY, sourceW, sourceH, 
                0, 0, cropW, cropH
             );
        }

        const cropBase64 = tempCanvas.toDataURL('image/jpeg', 0.95).split(',')[1];
        
        const result = {
            cropBase64,
            rect: { x: realMinX, y: realMinY, width: cropW, height: cropH },
            shiftX: mainShiftX
        };
        
        // Only save backup if explicitly requested (usually only on first generation)
        // This prevents overwriting the "clean" original state with a "dirty" state during regeneration loops
        if (saveBackup && colorHex && cropBase64 && cropBase64.length > 100) {
            backupsRef.current[colorHex.toLowerCase()] = {
                cropBase64: result.cropBase64,
                rect: result.rect,
                shiftX: result.shiftX
            };
        }

        return result;
    },

    getCompositeForGeneration: async (activeLayers: { color: string }[]) => {
        if (!maskCtxRef.current || !mainCtxRef.current) return null;

        const targetColors = activeLayers.map(l => hexToRgb(l.color));
        const maskWidth = maskCanvasRef.current.width;
        const maskHeight = maskCanvasRef.current.height;

        const centroidX = getMaskCentroidX(maskCtxRef.current, maskWidth, maskHeight, targetColors);
        const idealCenter = maskWidth / 2;
        const shiftX = Math.round(idealCenter - centroidX);

        const scaleX = mainCanvasRef.current.width / maskWidth;
        const mainShiftX = Math.round(shiftX * scaleX);

        const shiftedMain = createShiftedCanvas(mainCanvasRef.current, mainShiftX);
        const shiftedMask = createShiftedCanvas(maskCanvasRef.current, shiftX);
        
        const shiftedMaskCtx = shiftedMask.getContext('2d');
        if (!shiftedMaskCtx) return null;

        const maskData = shiftedMaskCtx.getImageData(0, 0, maskWidth, maskHeight);
        const data = maskData.data;

        let minX = maskWidth, minY = maskHeight, maxX = 0, maxY = 0;
        let hasMask = false;
        const tolerance = 50;

        for (let y = 0; y < maskHeight; y++) {
            for (let x = 0; x < maskWidth; x++) {
                const index = (y * maskWidth + x) * 4;
                const a = data[index + 3];
                
                if (a > 50) {
                     const r = data[index];
                     const g = data[index + 1];
                     const b = data[index + 2];

                     const isMatch = targetColors.some(c => 
                        Math.abs(r - c.r) < tolerance && 
                        Math.abs(g - c.g) < tolerance && 
                        Math.abs(b - c.b) < tolerance
                     );

                     if (isMatch) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                        hasMask = true;
                     }
                }
            }
        }

        if (!hasMask) return null;

        const scaleY = mainCanvasRef.current.height / maskHeight;

        let realMinX = Math.floor(minX * scaleX);
        let realMinY = Math.floor(minY * scaleY);
        let realMaxX = Math.ceil(maxX * scaleX);
        let realMaxY = Math.ceil(maxY * scaleY);

        const PADDING = 128;
        realMinX = Math.max(0, realMinX - PADDING);
        realMinY = Math.max(0, realMinY - PADDING);
        realMaxX = Math.min(shiftedMain.width, realMaxX + PADDING);
        realMaxY = Math.min(shiftedMain.height, realMaxY + PADDING);

        const cropW = realMaxX - realMinX;
        const cropH = realMaxY - realMinY;

        if (cropW <= 0 || cropH <= 0) return null;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = cropW;
        tempCanvas.height = cropH;
        const ctx = tempCanvas.getContext('2d');
        if (!ctx) return null;

        ctx.drawImage(shiftedMain, realMinX, realMinY, cropW, cropH, 0, 0, cropW, cropH);

        const tempMaskCanvas = document.createElement('canvas');
        tempMaskCanvas.width = maskWidth;
        tempMaskCanvas.height = maskHeight;
        const tempMaskCtx = tempMaskCanvas.getContext('2d');
        
        if (tempMaskCtx) {
             const filteredData = tempMaskCtx.createImageData(maskWidth, maskHeight);
             for (let i = 0; i < data.length; i += 4) {
                 const a = data[i+3];
                 if (a > 50) {
                     const r = data[i];
                     const g = data[i+1];
                     const b = data[i+2];

                     const isMatch = targetColors.some(c => 
                        Math.abs(r - c.r) < tolerance && 
                        Math.abs(g - c.g) < tolerance && 
                        Math.abs(b - c.b) < tolerance
                     );

                     if (isMatch) {
                        filteredData.data[i] = r;
                        filteredData.data[i+1] = g;
                        filteredData.data[i+2] = b;
                        filteredData.data[i+3] = 255;
                     }
                 }
             }
             tempMaskCtx.putImageData(filteredData, 0, 0);

             const sourceX = realMinX / scaleX;
             const sourceY = realMinY / scaleY;
             const sourceW = cropW / scaleX;
             const sourceH = cropH / scaleY;

             ctx.globalAlpha = 1.0;
             ctx.drawImage(
                tempMaskCanvas, 
                sourceX, sourceY, sourceW, sourceH, 
                0, 0, cropW, cropH
             );
        }

        const cropBase64 = tempCanvas.toDataURL('image/jpeg', 0.95).split(',')[1];
        
        return {
            cropBase64,
            rect: { x: realMinX, y: realMinY, width: cropW, height: cropH },
            shiftX: mainShiftX
        };
    },

    applyGeneratedPatch: async (patchBase64: string, rect: { x: number; y: number; width: number; height: number }, shiftX: number, noBlend: boolean = false) => {
        return new Promise<void>((resolve) => {
             const patchImg = new Image();
             
             // Safety timeout
             const timeoutId = setTimeout(() => {
                 console.warn("Generated patch image load timed out.");
                 resolve();
             }, 3000);

             patchImg.onload = () => {
                 clearTimeout(timeoutId);
                 if (mainCtxRef.current && mainTextureRef.current) {
                     const fullWidth = mainCanvasRef.current.width;
                     const fullHeight = mainCanvasRef.current.height;

                     const canvas = document.createElement('canvas');
                     canvas.width = rect.width;
                     canvas.height = rect.height;
                     const ctx = canvas.getContext('2d');
                     if (!ctx) { resolve(); return; }

                     ctx.drawImage(patchImg, 0, 0, rect.width, rect.height);
                     
                     if (!noBlend) {
                         ctx.globalCompositeOperation = 'destination-in';
                         const feather = Math.min(32, rect.width * 0.1, rect.height * 0.1);
                         
                         const gradientV = ctx.createLinearGradient(0, 0, 0, rect.height);
                         gradientV.addColorStop(0, 'rgba(0,0,0,0)');
                         gradientV.addColorStop(feather / rect.height, 'rgba(0,0,0,1)');
                         gradientV.addColorStop(1 - feather / rect.height, 'rgba(0,0,0,1)');
                         gradientV.addColorStop(1, 'rgba(0,0,0,0)');
                         ctx.fillStyle = gradientV;
                         ctx.fillRect(0, 0, rect.width, rect.height);

                         const gradientH = ctx.createLinearGradient(0, 0, rect.width, 0);
                         gradientH.addColorStop(0, 'rgba(0,0,0,0)');
                         gradientH.addColorStop(feather / rect.width, 'rgba(0,0,0,1)');
                         gradientH.addColorStop(1 - feather / rect.width, 'rgba(0,0,0,1)');
                         gradientH.addColorStop(1, 'rgba(0,0,0,0)');
                         ctx.fillStyle = gradientH;
                         ctx.fillRect(0, 0, rect.width, rect.height);
                     }

                     const shiftedLayer = document.createElement('canvas');
                     shiftedLayer.width = fullWidth;
                     shiftedLayer.height = fullHeight;
                     const shiftedCtx = shiftedLayer.getContext('2d');
                     if (!shiftedCtx) { resolve(); return; }

                     shiftedCtx.drawImage(canvas, rect.x, rect.y);

                     const unshiftX = -shiftX;
                     let dx = unshiftX % fullWidth;
                     if (dx < 0) dx += fullWidth;
                     
                     mainCtxRef.current.globalCompositeOperation = 'source-over';
                     
                     mainCtxRef.current.drawImage(shiftedLayer, dx, 0);
                     mainCtxRef.current.drawImage(shiftedLayer, dx - fullWidth, 0);

                     mainTextureRef.current.needsUpdate = true;
                 }
                 resolve();
             };
             patchImg.onerror = (e) => {
                 clearTimeout(timeoutId);
                 console.error("Failed to load generated patch image", e);
                 resolve();
             };
             patchImg.src = `data:image/jpeg;base64,${patchBase64}`;
        });
    },

    getFullImageBase64: () => {
        return mainCanvasRef.current.toDataURL('image/jpeg', 0.95);
    },

    restoreHistoryRegion: async (colorHex: string) => {
        const backup = backupsRef.current[colorHex.toLowerCase()];
        if (!backup || !mainCtxRef.current) return;

        const { cropBase64, rect, shiftX } = backup;
        const patchImg = new Image();
        await new Promise<void>((resolve) => {
            patchImg.onload = () => {
                const fullWidth = mainCanvasRef.current.width;
                const fullHeight = mainCanvasRef.current.height;
                
                const shiftedLayer = document.createElement('canvas');
                shiftedLayer.width = fullWidth;
                shiftedLayer.height = fullHeight;
                const shiftedCtx = shiftedLayer.getContext('2d');
                if (shiftedCtx) {
                    shiftedCtx.drawImage(patchImg, rect.x, rect.y);
                    const unshiftX = -shiftX;
                    let dx = unshiftX % fullWidth;
                    if (dx < 0) dx += fullWidth;
                    mainCtxRef.current!.drawImage(shiftedLayer, dx, 0);
                    mainCtxRef.current!.drawImage(shiftedLayer, dx - fullWidth, 0);
                    mainTextureRef.current!.needsUpdate = true;
                }
                resolve();
            };
            patchImg.src = `data:image/jpeg;base64,${cropBase64}`;
        });
    },

    lookAt: (lon: number, lat: number) => {
        if (viewMode === ViewMode.SCROLL && controlsRef.current) {
            // Convert spherical coordinates (lon, lat) to a target vector
            const phi = lat;
            const theta = lon;
            
            const x = Math.cos(phi) * Math.cos(theta);
            const y = Math.sin(phi);
            const z = Math.cos(phi) * Math.sin(theta);
            
            // We want the camera to look at this point from origin
            // In OrbitControls, we rotate the camera around the target (0,0,0)
            const target = new THREE.Vector3(x, y, z).normalize().multiplyScalar(0.1);
            camera.position.copy(target);
            camera.lookAt(0, 0, 0);
            controlsRef.current.update();
        } else if (viewMode === ViewMode.PLANET) {
            // For planet view, we update the quaternion
            const qYaw = new THREE.Quaternion();
            qYaw.setFromAxisAngle(new THREE.Vector3(0, 1, 0), lon);
            const qPitch = new THREE.Quaternion();
            qPitch.setFromAxisAngle(new THREE.Vector3(1, 0, 0), lat);
            
            planetState.current.targetQuaternion.copy(qYaw).multiply(qPitch).normalize();
        }
    }

  }));

  return (
    <>
      {viewMode === ViewMode.SCROLL && (
        <>
          <OrbitControls
            ref={controlsRef}
            enableZoom={false}
            enablePan={false}
            enableDamping={true}
            dampingFactor={0.05}
            rotateSpeed={-0.5}
            target={[0, 0, 0]}
            enabled={true}
            mouseButtons={{
                LEFT: isEditing ? undefined : THREE.MOUSE.ROTATE,
                MIDDLE: THREE.MOUSE.ROTATE,
                RIGHT: THREE.MOUSE.ROTATE
            }}
          />
          <mesh ref={meshRef} scale={[-1, 1, 1]}>
            <sphereGeometry args={[500, 128, 128]} />
            {/* @ts-ignore */}
            <equirectMaterial
              ref={equirectMatRef}
              side={THREE.BackSide}
              transparent={false}
            />
          </mesh>
        </>
      )}

      {viewMode === ViewMode.PLANET && (
         <mesh frustumCulled={false}>
           <planeGeometry args={[2, 2]} />
           {/* @ts-ignore */}
           <planetMaterial 
             ref={planetMatRef} 
             transparent={false} 
             depthTest={false}
             toneMapped={false}
           />
         </mesh>
      )}
    </>
  );
});

export default Panorama;