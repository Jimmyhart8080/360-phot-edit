import React, { useState, Suspense, useCallback, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { AppState, AnalysisResult, ViewerConfig, ViewMode, MirrorState, MaskLayer } from './types';
import Panorama, { PanoramaHandle } from './components/Panorama';
import UIOverlay from './components/UIOverlay';
import { analyze360Image, generateEditedImage, generateMultiEditImage, generateStyledImage, findObjectsInPanorama } from './services/geminiService';

const DEFAULT_LAYERS: MaskLayer[] = [
  { id: 'red', color: '#ff0000', colorName: 'Red', prompt: '' },
  { id: 'blue', color: '#0000ff', colorName: 'Blue', prompt: '' },
  { id: 'green', color: '#00ff00', colorName: 'Green', prompt: '' },
  { id: 'yellow', color: '#ffff00', colorName: 'Yellow', prompt: '' },
];

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageData, setImageData] = useState<{ base64: string, mimeType: string } | null>(null);
  const [editHistory, setEditHistory] = useState<{ base64: string, mimeType: string }[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [config, setConfig] = useState<ViewerConfig>({
    showControls: true
  });
  const [isCaptureMode, setIsCaptureMode] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.SCROLL);
  const [brushSize, setBrushSize] = useState(30);
  
  // Multi-mask state
  const [layers, setLayers] = useState<MaskLayer[]>(DEFAULT_LAYERS);
  const [activeLayerId, setActiveLayerId] = useState<string>(DEFAULT_LAYERS[0].id);
  const [batchMode, setBatchMode] = useState(false);
  const [editorMode, setEditorMode] = useState<'CUSTOM' | 'ERASE'>('CUSTOM');

  // History State
  const [showHistory, setShowHistory] = useState(false);
  const [historyPrompts, setHistoryPrompts] = useState<Record<string, string>>({});
  
  // Context Menu State (Right Click on Mask)
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, color: string, prompt: string } | null>(null);

  // Hover state for mask inspection
  const [hoveredMask, setHoveredMask] = useState<{ color: string | null, x: number, y: number }>({ color: null, x: 0, y: 0 });

  // Mirror State
  const [mirrorState, setMirrorState] = useState<MirrorState>({
    enabled: false,
    direction: 'SKY_TO_GROUND', // Default: Reflect Sky onto Ground
    axis: 0.5 // Default: Horizon
  });

  const [stylePrompt, setStylePrompt] = useState('');

  const panoramaRef = useRef<PanoramaHandle>(null);

  const handleUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Create object URL for Three.js texture loader
    const url = URL.createObjectURL(file);
    setImageUrl(url);

    // Read file as base64 for Gemini API
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      setImageData({
        base64,
        mimeType: file.type
      });
      setEditHistory([]); // Reset history on new upload
      setAnalysis(null);
      setAppState(AppState.VIEWING);
      setHistoryPrompts({});
      setShowHistory(false);
      setContextMenu(null);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleAnalyze = async () => {
    if (!imageData) return;

    setAppState(AppState.ANALYZING);

    try {
      const result = await analyze360Image(imageData.base64, imageData.mimeType);
      setAnalysis(result);
      
      // Secondary pass: Find object locations for interactivity
      if (result.objects && result.objects.length > 0) {
          const locations = await findObjectsInPanorama(imageData.base64, imageData.mimeType, result.objects.slice(0, 5));
          setAnalysis(prev => prev ? { ...prev, objectLocations: locations } : null);
      }
    } catch (error) {
      console.error("Analysis failed", error);
      alert("Failed to analyze the image. Please check your API Key and try again.");
    } finally {
      setAppState(AppState.VIEWING);
    }
  };

  const handleCloseAnalysis = () => {
    setAnalysis(null);
  };

  const handleReset = () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(null);
    setImageData(null);
    setEditHistory([]);
    setAnalysis(null);
    setAppState(AppState.IDLE);
    setConfig({ showControls: true });
    setIsCaptureMode(false);
    setViewMode(ViewMode.SCROLL);
    setMirrorState({ enabled: false, direction: 'SKY_TO_GROUND', axis: 0.5 });
    setLayers(DEFAULT_LAYERS.map(l => ({ ...l, prompt: '' }))); // Reset prompts
    setActiveLayerId(DEFAULT_LAYERS[0].id);
    setEditorMode('CUSTOM');
    setHistoryPrompts({});
    setShowHistory(false);
    setContextMenu(null);
  };

  const handleEnterCaptureMode = () => {
    setIsCaptureMode(true);
    setContextMenu(null);
  };

  const handleExitCaptureMode = () => {
    setIsCaptureMode(false);
  };

  const handleTakeSnapshot = (rect: {x: number, y: number, width: number, height: number}, screenSize: {width: number, height: number}, useCurvature: boolean) => {
    if (panoramaRef.current) {
      panoramaRef.current.takeSnapshot({
        rect,
        screenSize,
        useCurvature
      });
      setIsCaptureMode(false);
    }
  };

  const handleJumpToLocation = (x: number, y: number) => {
    if (panoramaRef.current) {
        // Convert normalized equirectangular UV to 3D rotation
        // In our shader/panorama:
        // U = 0.5 - lon / (2 * PI)
        // V = lat / PI + 0.5
        
        const lon = (0.5 - x) * 2 * Math.PI;
        const lat = (y - 0.5) * Math.PI;
        
        panoramaRef.current.lookAt(lon, lat);
    }
  };

  const handleToggleViewMode = () => {
    setViewMode((prev) => prev === ViewMode.SCROLL ? ViewMode.PLANET : ViewMode.SCROLL);
  };

  const handleUpdateMirrorState = (newState: MirrorState) => {
    setMirrorState(newState);
  };

  // --- EDITOR HANDLERS ---
  const handleEnterEditMode = () => {
    setAppState(AppState.EDITING);
    setContextMenu(null);
  };

  const handleEnterStyleMode = () => {
    setAppState(AppState.STYLING);
    setContextMenu(null);
  };

  const handleCancelStyle = () => {
    setAppState(AppState.VIEWING);
    setStylePrompt('');
  };

  const handleApplyStyle = async () => {
    if (!imageData || !stylePrompt.trim()) return;

    setAppState(AppState.STYLING); // Ensure we are in styling state (loading)
    
    try {
      // Use the full image for style transfer
      const fullBase64 = panoramaRef.current?.getFullImageBase64();
      if (!fullBase64) return;

      const resultBase64 = await generateStyledImage(fullBase64, imageData.mimeType, stylePrompt);
      
      // Update the image
      const newUrl = `data:${imageData.mimeType};base64,${resultBase64}`;
      setImageUrl(newUrl);
      
      // Update imageData for future edits
      setImageData({
        base64: resultBase64,
        mimeType: imageData.mimeType
      });

      // Add to history
      setEditHistory(prev => [...prev, { base64: resultBase64, mimeType: imageData.mimeType }]);
      
      setAppState(AppState.VIEWING);
      setStylePrompt('');
    } catch (error) {
      console.error("Style transfer failed", error);
      alert("Failed to apply style. Please try again.");
      setAppState(AppState.STYLING); // Stay in styling mode if it failed? Or go back?
    }
  };

  const handleCancelEdit = () => {
    if (panoramaRef.current) {
        panoramaRef.current.clearPaint();
    }
    setAppState(AppState.VIEWING);
  };

  const handleUpdateLayerPrompt = (id: string, prompt: string) => {
      setLayers(prev => prev.map(l => l.id === id ? { ...l, prompt } : l));
  };

  const handleAutoMaskTripod = () => {
      if (panoramaRef.current) {
          panoramaRef.current.paintNadir();
      }
  };

  const handleMaskHover = useCallback((color: string | null, x: number, y: number) => {
      // Find matching prompt either in current layers or history
      let foundPrompt = null;
      let foundColorName = null;
      let foundColor = color;

      if (color) {
          // Check active layers
          const activeLayer = layers.find(l => l.color.toLowerCase() === color.toLowerCase());
          if (activeLayer) {
              foundPrompt = activeLayer.prompt;
              foundColorName = activeLayer.colorName;
          } else {
              // Check history layers
              const histPrompt = historyPrompts[color.toLowerCase()];
              if (histPrompt) {
                  foundPrompt = histPrompt;
                  foundColorName = "History";
              }
          }
      }
      
      setHoveredMask({ color: foundColor, x, y });
  }, [layers, historyPrompts]);

  const handleMaskRightClick = useCallback((color: string, x: number, y: number) => {
      const prompt = historyPrompts[color.toLowerCase()];
      if (prompt) {
          setContextMenu({ x, y, color: color, prompt });
      }
  }, [historyPrompts]);
  
  const handleRegenerateHistory = async (color: string, newPrompt: string) => {
      if (!panoramaRef.current || !imageData) return;
      
      // Save History ONCE before starting
      const currentFullImageBase64 = panoramaRef.current.getFullImageBase64().split(',')[1];
      setEditHistory(prev => [...prev, { base64: currentFullImageBase64, mimeType: 'image/jpeg' }]);
      
      // Update Prompt immediately in UI
      setHistoryPrompts(prev => ({
          ...prev,
          [color.toLowerCase()]: newPrompt
      }));

      try {
           // Restore the original pixels for this region before generating new crop
           // This prevents artifacts from previous failed attempts being part of the new input
           await panoramaRef.current.restoreHistoryRegion(color);

           // We reuse the existing color layer in history
           // IMPORTANT: pass saveBackup=false to avoid overwriting the clean backup with potentially dirty state if restoration failed
           const cropData = await panoramaRef.current.getCropForGeneration(newPrompt, color, true, false); 
           
           if (!cropData) {
               console.warn("Could not locate the history mask for regeneration.");
               return;
           }

           const { cropBase64, rect, shiftX } = cropData;
           const generatedBase64 = await generateEditedImage(cropBase64, 'image/jpeg', newPrompt, 'Masked Area');
           await panoramaRef.current.applyGeneratedPatch(generatedBase64, rect, shiftX);
           
      } catch (e) {
          console.error("Regeneration failed:", e);
          alert("Failed to regenerate patch. The backup might be missing or corrupted.");
      }
  };

  const handleGenerateEdit = async () => {
      if (!panoramaRef.current || !imageData) return;

      // Determine active layers and prompts based on mode
      let activeLayers: MaskLayer[] = [];
      const ERASE_PROMPT = "Remove the object covered by the mask. Fill the area with the surrounding background texture and lighting to make it invisible and seamless.";

      if (editorMode === 'ERASE') {
         // In Erase mode, we use the active layer (color) and force the erase prompt
         // We assume the user has painted something on the active layer
         const currentLayer = layers.find(l => l.id === activeLayerId);
         if (currentLayer) {
             activeLayers = [{ ...currentLayer, prompt: ERASE_PROMPT }];
         }
      } else {
         // Custom Mode
         activeLayers = layers.filter(l => l.prompt.trim().length > 0);
         if (activeLayers.length === 0) {
            alert("Please enter a prompt for at least one color.");
            return;
         }
      }

      // Save History ONCE before starting
      const currentFullImageBase64 = panoramaRef.current.getFullImageBase64().split(',')[1];
      setEditHistory(prev => [...prev, { base64: currentFullImageBase64, mimeType: 'image/jpeg' }]);
      setAnalysis(null);

      // Prepare History Commit Data
      // We generate unique random colors for this edit session to store in history
      const historyMappings: { originalColor: string, newColor: string, prompt: string }[] = [];
      
      activeLayers.forEach(layer => {
          // Generate a random unique hex color for history tracking
          let randomColor = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
          // Ensure it doesn't clash with existing (unlikely but safe)
          while (historyPrompts[randomColor]) {
              randomColor = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
          }
          historyMappings.push({
              originalColor: layer.color,
              newColor: randomColor,
              prompt: layer.prompt
          });
      });

      try {
          // --- IMPORTANT: CREATE BACKUPS ---
          // For both sequential and batch modes, we must first capture the "before" state
          // for each layer so we can restore it later if needed.
          // This call stores the backup in backupsRef inside Panorama.
          // Pass saveBackup=true because this is the initial creation of the backup.
          for (const layer of activeLayers) {
               await panoramaRef.current.getCropForGeneration(layer.prompt, layer.color, false, true);
          }

          if (batchMode && editorMode === 'CUSTOM') {
            // SIMULTANEOUS MODE
            const cropData = await panoramaRef.current.getCompositeForGeneration(activeLayers);

            if (cropData) {
               const { cropBase64, rect, shiftX } = cropData;
               const instructions = activeLayers.map(l => ({ colorName: l.colorName, prompt: l.prompt }));
               
               const generatedBase64 = await generateMultiEditImage(cropBase64, 'image/jpeg', instructions);
               await panoramaRef.current.applyGeneratedPatch(generatedBase64, rect, shiftX);
            }

          } else {
            // SEQUENTIAL MODE
            for (const layer of activeLayers) {
               // We fetch crop again to get the latest coordinates (though rect should be same as backup)
               const cropData = await panoramaRef.current.getCropForGeneration(layer.prompt, layer.color);
               
               if (!cropData) {
                   if (editorMode === 'ERASE') {
                       alert("Please paint an area to erase first.");
                       return;
                   }
                   continue;
               }
  
               const { cropBase64, rect, shiftX } = cropData;
               const generatedBase64 = await generateEditedImage(cropBase64, 'image/jpeg', layer.prompt, layer.colorName);
               await panoramaRef.current.applyGeneratedPatch(generatedBase64, rect, shiftX);
               
               await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          
          // Commit Masks to History before clearing
          panoramaRef.current.commitToHistory(historyMappings.map(m => ({ originalColor: m.originalColor, newColor: m.newColor })));
          
          // Update Prompt Registry
          setHistoryPrompts(prev => {
              const next = { ...prev };
              historyMappings.forEach(m => {
                  next[m.newColor.toLowerCase()] = m.prompt; // Store as lowercase for consistent lookup
              });
              return next;
          });

          // Clear paint after success
          panoramaRef.current.clearPaint();
          
          // Clear prompts only in Custom mode
          if (editorMode === 'CUSTOM') {
              setLayers(prev => prev.map(l => ({ ...l, prompt: '' })));
          }

      } catch (e) {
          console.error("Edit generation failed:", e);
          alert("Failed to generate edit. Please try again.");
      }
  };

  const handleUndo = () => {
    if (editHistory.length === 0) return;

    const previousState = editHistory[editHistory.length - 1];
    const newHistory = editHistory.slice(0, -1);

    // Reconstruct Blob and URL from base64
    const byteCharacters = atob(previousState.base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: previousState.mimeType });
    const newUrl = URL.createObjectURL(blob);

    if (imageUrl) URL.revokeObjectURL(imageUrl);

    setImageUrl(newUrl);
    setImageData(previousState);
    setEditHistory(newHistory);
    setAnalysis(null);
  };

  const handleDownload = () => {
    if (panoramaRef.current) {
      const link = document.createElement('a');
      link.download = `omniview-360-${Date.now()}.jpg`;
      link.href = panoramaRef.current.getFullImageBase64();
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  // Helper to get prompt for UI overlay
  const getPromptForHover = (color: string | null) => {
      if (!color) return null;
      // Check active
      const layer = layers.find(l => l.color.toLowerCase() === color.toLowerCase());
      if (layer) return layer.prompt;
      // Check history
      return historyPrompts[color.toLowerCase()];
  };

  return (
    // Use fixed inset-0 and h-[100dvh] for robust mobile layout
    <div 
        className="fixed inset-0 w-full h-[100dvh] bg-slate-900 overflow-hidden touch-none"
        onClick={(e) => { 
            // Only close context menu if click didn't originate from inside a prevent-close element
            if (contextMenu && !(e.target as HTMLElement).closest('.prevent-close')) {
                setContextMenu(null); 
            }
        }}
    >
      
      {/* 3D Scene Layer */}
      {imageUrl && (
        <div className="absolute inset-0 z-0">
          <Canvas 
            camera={{ position: [0, 0, 0.1], fov: 75 }}
            gl={{ preserveDrawingBuffer: true }} 
            style={{ touchAction: 'none' }}
          >
            <Suspense fallback={null}>
               <Panorama 
                 ref={panoramaRef}
                 imageUrl={imageUrl}
                 viewMode={viewMode}
                 mirrorState={mirrorState}
                 isEditing={appState === AppState.EDITING}
                 brushSize={brushSize}
                 activeColor={layers.find(l => l.id === activeLayerId)?.color || '#ff0000'}
                 onMaskHover={handleMaskHover}
                 onMaskRightClick={handleMaskRightClick}
                 showHistory={showHistory}
               />
            </Suspense>
          </Canvas>
        </div>
      )}

      {/* UI Overlay Layer */}
      <UIOverlay 
        appState={appState}
        analysis={analysis}
        config={config}
        isCaptureMode={isCaptureMode}
        viewMode={viewMode}
        mirrorState={mirrorState}
        canUndo={editHistory.length > 0}
        onUpload={handleUpload}
        onAnalyze={handleAnalyze}
        onCloseAnalysis={handleCloseAnalysis}
        onEnterCaptureMode={handleEnterCaptureMode}
        onExitCaptureMode={handleExitCaptureMode}
        onTakeSnapshot={handleTakeSnapshot}
        onReset={handleReset}
        onToggleViewMode={handleToggleViewMode}
        onUpdateMirrorState={handleUpdateMirrorState}
        onEnterEditMode={handleEnterEditMode}
        onCancelEdit={handleCancelEdit}
        onUndo={handleUndo}
        onDownload={handleDownload}
        
        onEnterStyleMode={handleEnterStyleMode}
        onCancelStyle={handleCancelStyle}
        onApplyStyle={handleApplyStyle}
        stylePrompt={stylePrompt}
        onSetStylePrompt={setStylePrompt}
        
        onGenerateEdit={handleGenerateEdit}
        onUndoPaint={() => panoramaRef.current?.undoPaint()}
        onClearPaint={() => panoramaRef.current?.clearPaint()}
        onSetBrushSize={setBrushSize}
        
        layers={layers}
        activeLayerId={activeLayerId}
        onSelectLayer={setActiveLayerId}
        onUpdateLayerPrompt={handleUpdateLayerPrompt}
        
        batchMode={batchMode}
        onToggleBatchMode={() => setBatchMode(!batchMode)}
        editorMode={editorMode}
        onSetEditorMode={setEditorMode}
        onAutoMaskTripod={handleAutoMaskTripod}
        
        hoveredMask={{ 
            ...hoveredMask, 
            prompt: getPromptForHover(hoveredMask.color) // Inject resolved prompt
        }}
        
        showHistory={showHistory}
        onToggleHistory={() => setShowHistory(!showHistory)}
        onJumpToLocation={handleJumpToLocation}

        contextMenu={contextMenu}
        onCloseContextMenu={() => setContextMenu(null)}
        onRegenerateHistory={handleRegenerateHistory}
      />
      
      <Suspense fallback={
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
             <div className="text-white font-bold text-lg animate-pulse">Loading Environment...</div>
        </div>
      }>
      </Suspense>
      
    </div>
  );
};

export default App;