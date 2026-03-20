import React, { useState, useRef, useEffect, useCallback } from 'react';
import { AppState, AnalysisResult, ViewerConfig, ViewMode, MirrorState, MaskLayer } from '../types';
import { SparklesIcon, UploadIcon, CloseIcon, CameraIcon, GlobeIcon, PanoramaIcon, SymmetryIcon, ArrowUpIcon, ArrowDownIcon, MoveIcon, MagicWandIcon, DownloadIcon, UndoIcon, BrushIcon, LayersIcon, CheckIcon, HelpIcon } from './Icons';

interface UIOverlayProps {
  appState: AppState;
  analysis: AnalysisResult | null;
  config: ViewerConfig;
  isCaptureMode: boolean;
  viewMode: ViewMode;
  mirrorState: MirrorState;
  canUndo: boolean;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAnalyze: () => void;
  onCloseAnalysis: () => void;
  onEnterCaptureMode: () => void;
  onExitCaptureMode: () => void;
  onTakeSnapshot: (rect: {x: number, y: number, width: number, height: number}, screenSize: {width: number, height: number}, useCurvature: boolean) => void;
  onReset: () => void;
  onToggleViewMode: () => void;
  onUpdateMirrorState: (state: MirrorState) => void;
  onEnterEditMode: () => void;
  onCancelEdit: () => void;
  onUndo: () => void;
  onDownload: () => void;
  
  // Style Props
  onEnterStyleMode: () => void;
  onCancelStyle: () => void;
  onApplyStyle: () => void;
  stylePrompt: string;
  onSetStylePrompt: (prompt: string) => void;
  
  // Paint/Edit Props
  onGenerateEdit: () => Promise<void>;
  onUndoPaint: () => void;
  onClearPaint: () => void;
  onSetBrushSize: (size: number) => void;
  layers: MaskLayer[];
  activeLayerId: string;
  onSelectLayer: (id: string) => void;
  onUpdateLayerPrompt: (id: string, prompt: string) => void;
  
  batchMode: boolean;
  onToggleBatchMode: () => void;
  editorMode: 'CUSTOM' | 'ERASE';
  onSetEditorMode: (mode: 'CUSTOM' | 'ERASE') => void;
  onAutoMaskTripod: () => void;
  
  hoveredMask?: { color: string | null, x: number, y: number, prompt?: string | null };
  
  showHistory: boolean;
  onToggleHistory: () => void;
  onJumpToLocation: (x: number, y: number) => void;

  contextMenu: { x: number, y: number, color: string, prompt: string } | null;
  onCloseContextMenu: () => void;
  onRegenerateHistory: (color: string, newPrompt: string) => Promise<void>;
}

const UIOverlay: React.FC<UIOverlayProps> = ({
  appState,
  analysis,
  config,
  isCaptureMode,
  viewMode,
  mirrorState,
  canUndo,
  onUpload,
  onAnalyze,
  onCloseAnalysis,
  onEnterCaptureMode,
  onExitCaptureMode,
  onTakeSnapshot,
  onReset,
  onToggleViewMode,
  onUpdateMirrorState,
  onEnterEditMode,
  onCancelEdit,
  onUndo,
  onDownload,
  onEnterStyleMode,
  onCancelStyle,
  onApplyStyle,
  stylePrompt,
  onSetStylePrompt,
  onGenerateEdit,
  onUndoPaint,
  onClearPaint,
  onSetBrushSize,
  layers,
  activeLayerId,
  onSelectLayer,
  onUpdateLayerPrompt,
  batchMode,
  onToggleBatchMode,
  editorMode,
  onSetEditorMode,
  onAutoMaskTripod,
  hoveredMask,
  showHistory,
  onToggleHistory,
  onJumpToLocation,
  contextMenu,
  onCloseContextMenu,
  onRegenerateHistory
}) => {
  // Capture Box Dimensions
  const [cropSize, setCropSize] = useState({ width: 0, height: 0 });
  const [cropPosition, setCropPosition] = useState({ x: 0, y: 0 });
  const [useCurvature, setUseCurvature] = useState(false);
  
  const currentRatio = cropSize.height > 0 ? cropSize.width / cropSize.height : 16/9;
  
  // Edit State
  const [brushSize, setBrushSizeLocal] = useState(30);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [showStylePresets, setShowStylePresets] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const STYLE_PRESETS = [
    { id: 'cyberpunk', name: 'Cyberpunk', prompt: 'Cyberpunk city at night, neon lights, futuristic architecture, rainy streets, high contrast', icon: '🏙️' },
    { id: 'watercolor', name: 'Watercolor', prompt: 'Beautiful watercolor painting, soft edges, vibrant colors, artistic brush strokes', icon: '🎨' },
    { id: 'sketch', name: 'Pencil Sketch', prompt: 'Detailed pencil sketch, graphite shading, hand-drawn look, artistic texture', icon: '✏️' },
    { id: 'sunset', name: 'Golden Hour', prompt: 'Warm sunset lighting, long shadows, golden atmosphere, beautiful sky colors', icon: '🌅' },
    { id: 'winter', name: 'Winter Wonderland', prompt: 'Snowy landscape, frozen details, cold atmosphere, white and blue tones', icon: '❄️' },
    { id: 'oil', name: 'Oil Painting', prompt: 'Classic oil painting style, thick paint texture, rich colors, masterpiece quality', icon: '🖼️' },
  ];
  
  // Context Menu State
  const [isEditingHistoryPrompt, setIsEditingHistoryPrompt] = useState(false);
  const [historyPromptValue, setHistoryPromptValue] = useState('');
  
  // Refs for drag logic
  const dragStartRef = useRef<{ x: number; y: number; w: number; h: number; posX: number; posY: number } | null>(null);
  const activeHandleRef = useRef<string | null>(null);

  // Initialize crop size on mount/resize
  useEffect(() => {
    const initSize = () => {
      const w = Math.min(window.innerWidth * 0.8, 900);
      const h = w * (9/16);
      setCropSize({ width: w, height: h });
      setCropPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    };

    if (isCaptureMode && cropSize.width === 0) {
      initSize();
    }
  }, [isCaptureMode]);

  // Sync history prompt value when menu opens
  useEffect(() => {
      if (contextMenu) {
          setHistoryPromptValue(contextMenu.prompt || "");
          setIsEditingHistoryPrompt(false);
      }
  }, [contextMenu]);

  const handleDragStart = (e: React.MouseEvent | React.TouchEvent, handle: string) => {
    e.preventDefault();
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;

    activeHandleRef.current = handle;
    dragStartRef.current = {
      x: clientX,
      y: clientY,
      w: cropSize.width,
      h: cropSize.height,
      posX: cropPosition.x,
      posY: cropPosition.y
    };

    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragEnd);
    window.addEventListener('touchmove', handleDragMove);
    window.addEventListener('touchend', handleDragEnd);
  };

  const handleDragMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!activeHandleRef.current || !dragStartRef.current) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;

    const deltaX = clientX - dragStartRef.current.x;
    const deltaY = clientY - dragStartRef.current.y;
    const handle = activeHandleRef.current;

    let newW = dragStartRef.current.w;
    let newH = dragStartRef.current.h;
    let newX = dragStartRef.current.posX;
    let newY = dragStartRef.current.posY;

    if (handle === 'move') {
        newX += deltaX;
        newY += deltaY;
    } else {
        if (handle.includes('e')) newW += deltaX * 2;
        if (handle.includes('w')) newW -= deltaX * 2;
        if (handle.includes('s')) newH += deltaY * 2;
        if (handle.includes('n')) newH -= deltaY * 2;
    }

    newW = Math.max(100, Math.min(newW, window.innerWidth - 40));
    newH = Math.max(100, Math.min(newH, window.innerHeight - 40));
    newX = Math.max(0, Math.min(newX, window.innerWidth));
    newY = Math.max(0, Math.min(newY, window.innerHeight));

    setCropSize({ width: newW, height: newH });
    setCropPosition({ x: newX, y: newY });
  }, []);

  const handleDragEnd = useCallback(() => {
    activeHandleRef.current = null;
    dragStartRef.current = null;
    window.removeEventListener('mousemove', handleDragMove);
    window.removeEventListener('mouseup', handleDragEnd);
    window.removeEventListener('touchmove', handleDragMove);
    window.removeEventListener('touchend', handleDragEnd);
  }, [handleDragMove]);

  const setPresetRatio = (ratio: number) => {
    const currentArea = cropSize.width * cropSize.height;
    let newH = Math.sqrt(currentArea / ratio);
    let newW = newH * ratio;
    if (newW > window.innerWidth * 0.9) {
      newW = window.innerWidth * 0.9;
      newH = newW / ratio;
    }
    if (newH > window.innerHeight * 0.8) {
      newH = window.innerHeight * 0.8;
      newW = newH * ratio;
    }
    setCropSize({ width: newW, height: newH });
  };

  const handleCaptureClick = () => {
    const rect = {
       x: cropPosition.x - cropSize.width / 2,
       y: cropPosition.y - cropSize.height / 2,
       width: cropSize.width,
       height: cropSize.height
    };
    const screenSize = { width: window.innerWidth, height: window.innerHeight };
    onTakeSnapshot(rect, screenSize, useCurvature);
  };

  const toggleMirror = () => {
    onUpdateMirrorState({ ...mirrorState, enabled: !mirrorState.enabled });
  };

  const setMirrorDirection = (direction: 'SKY_TO_GROUND' | 'GROUND_TO_SKY') => {
    onUpdateMirrorState({ ...mirrorState, direction });
  };

  const handleAxisChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdateMirrorState({ ...mirrorState, axis: parseFloat(e.target.value) });
  };

  const handleGenerateClick = async () => {
      setIsGenerating(true);
      await onGenerateEdit();
      setIsGenerating(false);
  };

  const handleApplyStyleClick = async () => {
    setIsGenerating(true);
    await onApplyStyle();
    setIsGenerating(false);
  };
  
  const handleRegenerateHistoryClick = async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      
      if (!contextMenu) return;
      setIsGenerating(true);
      onCloseContextMenu(); // Close immediately to avoid UI clutter
      try {
        await onRegenerateHistory(contextMenu.color, historyPromptValue);
        setShowSuccess(true);
        setTimeout(() => setShowSuccess(false), 3000);
      } catch (e) {
        console.error("Error regenerating history:", e);
      } finally {
        setIsGenerating(false);
      }
  };

  const renderTooltip = () => {
    // Hide tooltip if context menu is open
    if (contextMenu) return null;
    if (!hoveredMask || !hoveredMask.prompt) return null;
    return (
        <div 
            className="fixed pointer-events-none z-[100] bg-black/80 backdrop-blur-md border border-white/20 px-3 py-2 rounded-lg text-xs font-medium text-white shadow-xl flex items-center gap-2 max-w-[200px]"
            style={{
                left: hoveredMask.x + 20,
                top: hoveredMask.y,
                transform: 'translateY(-50%)'
            }}
        >
            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: hoveredMask.color || '#fff' }}></div>
            <span className="truncate">{hoveredMask.prompt}</span>
        </div>
    );
  };

  const renderContextMenu = () => {
      if (!contextMenu) return null;
      
      return (
          <div 
            className="fixed z-[100] bg-slate-900/90 backdrop-blur-xl border border-white/20 rounded-xl shadow-2xl p-4 w-72 flex flex-col gap-3 animate-fade-in-up prevent-close"
            style={{
                left: Math.min(contextMenu.x, window.innerWidth - 300),
                top: Math.min(contextMenu.y, window.innerHeight - 200)
            }}
            onClick={(e) => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }}
            onKeyDown={(e) => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }}
            onMouseDown={(e) => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }}
            onTouchStart={(e) => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }}
          >
              <div className="flex justify-between items-start">
                  <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full border border-white/20" style={{ backgroundColor: contextMenu.color }}></div>
                      <span className="text-xs font-bold uppercase text-slate-400 tracking-wider">Edit History</span>
                  </div>
                  <button onClick={onCloseContextMenu} className="text-slate-400 hover:text-white">
                      <div className="scale-75"><CloseIcon /></div>
                  </button>
              </div>

              <div className="flex flex-col gap-2">
                  <label className="text-xs text-slate-300">Prompt:</label>
                  <textarea 
                    value={historyPromptValue}
                    onChange={(e) => setHistoryPromptValue(e.target.value)}
                    onClick={(e) => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }}
                    className="w-full h-24 bg-black/40 border border-white/10 rounded-lg p-2 text-sm text-white resize-none focus:outline-none focus:border-cyan-500/50"
                  />
              </div>

              <button 
                onClick={handleRegenerateHistoryClick}
                disabled={!historyPromptValue.trim() || isGenerating}
                className="w-full py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold rounded-lg shadow-lg text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <SparklesIcon />
                Regenerate Patch
              </button>
          </div>
      );
  };

  // Increased touch target size to 32px (w-8 h-8) and adjusted offsets
  const renderHandle = (position: string, cursor: string) => (
    <div
      className={`absolute w-8 h-8 bg-white border border-slate-400 rounded-full shadow-lg z-20 flex items-center justify-center transition-transform hover:scale-125 hover:bg-cyan-50 pointer-events-auto ${cursor}`}
      style={{
        top: position.includes('n') ? '-16px' : position.includes('s') ? 'auto' : '50%',
        bottom: position.includes('s') ? '-16px' : 'auto',
        left: position.includes('w') ? '-16px' : position.includes('e') ? 'auto' : '50%',
        right: position.includes('e') ? '-16px' : 'auto',
        transform: !position.includes('n') && !position.includes('s') && !position.includes('e') && !position.includes('w') ? 'none' : 
                   (position === 'n' || position === 's') ? 'translateX(-50%)' : 'translateY(-50%)'
      }}
      onMouseDown={(e) => handleDragStart(e, position)}
      onTouchStart={(e) => handleDragStart(e, position)}
    >
      <div className="w-2 h-2 bg-slate-400 rounded-full"></div>
    </div>
  );

  const activeLayer = layers.find(l => l.id === activeLayerId);

  if (appState === AppState.IDLE) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 bg-opacity-95 z-50 text-white p-6">
        <div className="max-w-md w-full text-center space-y-8">
          <div className="space-y-2">
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
              OmniView 360
            </h1>
            <p className="text-slate-400 text-sm sm:text-base">
              Immersive panoramic viewer powered by Gemini AI.
            </p>
          </div>
          <div className="relative group cursor-pointer active:scale-95 transition-transform">
            <div className="absolute -inset-1 bg-gradient-to-r from-cyan-400 to-blue-600 rounded-lg blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
            <label className="relative flex flex-col items-center justify-center w-full h-40 sm:h-48 border-2 border-dashed border-slate-600 rounded-lg bg-slate-800 hover:bg-slate-750 transition-colors cursor-pointer active:bg-slate-700">
              <div className="flex flex-col items-center justify-center pt-5 pb-6 px-4">
                <div className="mb-3 text-cyan-400"><UploadIcon /></div>
                <p className="mb-2 text-sm text-slate-300 text-center"><span className="font-semibold">Click to upload</span> or drag and drop</p>
                <p className="text-xs text-slate-500">Equirectangular JPG or PNG</p>
              </div>
              <input type="file" className="hidden" accept="image/jpeg, image/png" onChange={onUpload} />
            </label>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* GLOBAL HOVER TOOLTIP */}
      {renderTooltip()}
      
      {/* CONTEXT MENU */}
      {renderContextMenu()}

      {/* --- HELP MODAL --- */}
      {showHelp && (
        <div className="absolute inset-0 z-[200] flex items-center justify-center p-6 pointer-events-auto">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowHelp(false)}></div>
            <div className="relative w-full max-w-lg bg-slate-900 border border-white/10 rounded-3xl shadow-2xl overflow-hidden flex flex-col animate-fade-in-up">
                <div className="p-6 border-b border-white/5 flex justify-between items-center bg-gradient-to-r from-slate-800 to-slate-900">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                        <HelpIcon /> Getting Started
                    </h2>
                    <button onClick={() => setShowHelp(false)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                        <CloseIcon />
                    </button>
                </div>
                <div className="p-8 overflow-y-auto max-h-[70vh] space-y-6">
                    <section className="space-y-3">
                        <h3 className="text-cyan-400 font-bold uppercase tracking-widest text-xs">Viewing</h3>
                        <p className="text-sm text-slate-300 leading-relaxed">
                            Drag to look around. Use your mouse wheel or pinch to zoom. 
                            Switch between <span className="text-white font-medium">Scroll Mode</span> and <span className="text-white font-medium">Planet View</span> using the globe icon.
                        </p>
                    </section>
                    
                    <section className="space-y-3">
                        <h3 className="text-purple-400 font-bold uppercase tracking-widest text-xs">AI Editing (Nano Banana)</h3>
                        <p className="text-sm text-slate-300 leading-relaxed">
                            Click the magic wand to enter edit mode. Paint over areas you want to change, then describe what should be there.
                            Use <span className="text-white font-medium">Erase Mode</span> to seamlessly remove objects like tripods or people.
                        </p>
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-indigo-400 font-bold uppercase tracking-widest text-xs">Style Transfer</h3>
                        <p className="text-sm text-slate-300 leading-relaxed">
                            Click the sparkles icon to transform the entire scene. Choose a preset like <span className="text-white font-medium">Cyberpunk</span> or <span className="text-white font-medium">Watercolor</span>, or write your own custom style.
                        </p>
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-emerald-400 font-bold uppercase tracking-widest text-xs">Mirror & Symmetry</h3>
                        <p className="text-sm text-slate-300 leading-relaxed">
                            Use the symmetry icon to create surreal reflections. You can mirror the sky onto the ground or vice versa, and adjust the horizon level.
                        </p>
                    </section>
                </div>
                <div className="p-6 bg-slate-800/50 border-t border-white/5 flex justify-center">
                    <button 
                        onClick={() => setShowHelp(false)}
                        className="px-8 py-3 bg-white text-black font-bold rounded-full hover:bg-cyan-400 transition-colors shadow-lg active:scale-95"
                    >
                        Got it!
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* --- STYLE MODE OVERLAY --- */}
      {appState === AppState.STYLING && (
        <div className="absolute inset-0 pointer-events-none z-10 flex flex-col justify-between p-4 pt-safe pb-safe">
            <div className="flex justify-between items-start pointer-events-auto">
                <div className="px-4 py-2 bg-black/40 backdrop-blur-md rounded-full border border-white/10 text-white font-bold flex items-center gap-2 shadow-lg animate-fade-in-up">
                    <SparklesIcon /> 
                    <span className="text-sm">Style Transfer</span>
                </div>
                
                {!isGenerating && (
                    <button 
                      onClick={onCancelStyle} 
                      className="px-4 py-2 bg-white/10 hover:bg-white/20 hover:backdrop-blur-xl rounded-full text-white backdrop-blur-md border border-white/5 transition-all shadow-lg text-sm font-medium animate-fade-in-up"
                    >
                        Exit
                    </button>
                )}
            </div>

            {isGenerating && (
                <div className="absolute inset-0 flex flex-col items-center justify-center z-50 pointer-events-auto">
                    <div className="bg-black/40 backdrop-blur-md p-6 rounded-2xl flex flex-col items-center border border-white/10 shadow-2xl">
                        <div className="w-10 h-10 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mb-4"></div>
                        <div className="text-white font-medium text-sm">Transforming scene...</div>
                    </div>
                </div>
            )}

            <div className={`pointer-events-auto w-full max-w-md mx-auto flex flex-col gap-3 transition-all duration-300 transform ${isGenerating ? 'opacity-0 translate-y-10' : 'opacity-100 translate-y-0'}`}>
                <div className="bg-slate-900/60 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl flex flex-col gap-4 animate-fade-in-up">
                    <div className="flex flex-col gap-2">
                        <div className="flex justify-between items-center">
                            <span className="text-xs text-slate-400 font-bold uppercase tracking-wider">Describe Style</span>
                            <button 
                                onClick={() => setShowStylePresets(!showStylePresets)}
                                className="text-[10px] text-cyan-400 font-bold uppercase hover:text-cyan-300"
                            >
                                {showStylePresets ? "Hide Presets" : "Show Presets"}
                            </button>
                        </div>
                        
                        {showStylePresets && (
                            <div className="grid grid-cols-3 gap-2 py-2">
                                {STYLE_PRESETS.map(preset => (
                                    <button
                                        key={preset.id}
                                        onClick={() => onSetStylePrompt(preset.prompt)}
                                        className="flex flex-col items-center gap-1 p-2 bg-black/20 hover:bg-white/10 border border-white/5 rounded-lg transition-all"
                                    >
                                        <span className="text-xl">{preset.icon}</span>
                                        <span className="text-[10px] text-slate-300 text-center leading-tight">{preset.name}</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        <textarea 
                            value={stylePrompt}
                            onChange={(e) => onSetStylePrompt(e.target.value)}
                            placeholder="e.g. A futuristic cyberpunk city with neon lights and rainy streets..."
                            className="w-full h-24 bg-black/30 border border-white/10 rounded-lg p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-all"
                        />
                    </div>

                    <button 
                        onClick={handleApplyStyleClick}
                        disabled={!stylePrompt.trim() || isGenerating}
                        className="w-full py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold rounded-xl shadow-lg flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        <SparklesIcon />
                        Apply Transformation
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* --- EDIT MODE OVERLAY (GLASSMORPHIC REDESIGN) --- */}
      {appState === AppState.EDITING && (
        <div className="absolute inset-0 pointer-events-none z-10 flex flex-col justify-between p-4 pt-safe pb-safe">
            
            {/* Top Floating Bar */}
            <div className="flex justify-between items-start pointer-events-auto">
                <div className="px-4 py-2 bg-black/40 backdrop-blur-md rounded-full border border-white/10 text-white font-bold flex items-center gap-2 shadow-lg animate-fade-in-up">
                    <MagicWandIcon /> 
                    <span className="text-sm">Nano Banana</span>
                </div>
                
                {!isGenerating && (
                    <button 
                      onClick={onCancelEdit} 
                      className="px-4 py-2 bg-white/10 hover:bg-white/20 hover:backdrop-blur-xl rounded-full text-white backdrop-blur-md border border-white/5 transition-all shadow-lg text-sm font-medium animate-fade-in-up"
                    >
                        Exit
                    </button>
                )}
            </div>

            {/* Loading Overlay - Centered Glass */}
            {isGenerating && (
                <div className="absolute inset-0 flex flex-col items-center justify-center z-50 pointer-events-auto">
                    <div className="bg-black/40 backdrop-blur-md p-6 rounded-2xl flex flex-col items-center border border-white/10 shadow-2xl">
                        <div className="w-10 h-10 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mb-4"></div>
                        <div className="text-white font-medium text-sm">
                            {editorMode === 'ERASE' ? "Removing object..." : (batchMode ? "Processing composite..." : "Generating edits...")}
                        </div>
                    </div>
                </div>
            )}

            {/* Bottom Dock - Floating Glass Panel */}
            <div className={`pointer-events-auto w-full max-w-md mx-auto flex flex-col gap-3 transition-all duration-300 transform ${isGenerating ? 'opacity-0 translate-y-10' : 'opacity-100 translate-y-0'}`}>
                
                {/* Main Glass Panel */}
                <div className="bg-slate-900/60 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl flex flex-col gap-4 animate-fade-in-up">
                    
                    {/* Row 1: Tools & Mode */}
                    <div className="flex items-center gap-3">
                        {/* Mode Switcher */}
                        <div className="flex bg-black/40 p-1 rounded-lg border border-white/5 shrink-0">
                            <button 
                              onClick={() => onSetEditorMode('CUSTOM')}
                              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${editorMode === 'CUSTOM' ? 'bg-slate-600/80 text-white shadow ring-1 ring-white/10' : 'text-slate-400 hover:text-white'}`}
                            >
                              Edit
                            </button>
                            <button 
                              onClick={() => onSetEditorMode('ERASE')}
                              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${editorMode === 'ERASE' ? 'bg-slate-600/80 text-white shadow ring-1 ring-white/10' : 'text-slate-400 hover:text-white'}`}
                            >
                              Erase
                            </button>
                        </div>

                        {/* Brush Slider */}
                        <div className="flex items-center gap-2 flex-1 min-w-0 bg-black/20 rounded-lg px-2 py-1.5 border border-white/5">
                           <span className="text-slate-400 scale-75"><BrushIcon /></span>
                           <input 
                              type="range" 
                              min="5" 
                              max="100" 
                              value={brushSize} 
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                setBrushSizeLocal(v);
                                onSetBrushSize(v);
                              }}
                              className="w-full h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                           />
                        </div>

                        {/* Toggle History Visibility */}
                        <button 
                          onClick={onToggleHistory}
                          className={`p-2 rounded-lg border border-white/5 transition-colors shrink-0 ${showHistory ? 'bg-purple-500/30 text-purple-300 border-purple-500/30' : 'bg-white/5 hover:bg-white/10 text-white'}`}
                          title={showHistory ? "Hide Past Edits" : "Show Past Edits"}
                        >
                            <LayersIcon />
                        </button>

                        {/* Undo & Clear */}
                        <div className="flex gap-1 shrink-0">
                            <button onClick={onUndoPaint} className="p-2 bg-white/5 hover:bg-white/10 rounded-lg text-white border border-white/5 transition-colors" title="Undo Stroke">
                                <UndoIcon />
                            </button>
                            <button onClick={onClearPaint} className="px-2 py-2 bg-white/5 hover:bg-red-500/20 text-slate-400 hover:text-red-300 rounded-lg text-[10px] font-bold uppercase tracking-wider border border-white/5 transition-colors">
                                CLR
                            </button>
                        </div>
                    </div>

                    {/* Row 2: Contextual Inputs */}
                    {editorMode === 'CUSTOM' && (
                        <div className="flex flex-col gap-3">
                            {/* Color Palette */}
                            <div className="flex gap-2 justify-between overflow-x-auto py-1">
                                {layers.map(layer => (
                                    <button
                                    key={layer.id}
                                    onClick={() => onSelectLayer(layer.id)}
                                    className={`w-9 h-9 rounded-full border-2 transition-all transform relative shadow-md shrink-0 ${activeLayerId === layer.id ? 'border-white scale-110 shadow-lg ring-2 ring-white/20' : 'border-transparent opacity-60 hover:opacity-100 hover:scale-105'}`}
                                    style={{ backgroundColor: layer.color }}
                                    >
                                        {layer.prompt && <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-white rounded-full border border-black/20"></div>}
                                    </button>
                                ))}
                            </div>
                            
                            {/* Prompt Input */}
                            {activeLayer && (
                                <div className="relative group">
                                    <div className={`absolute inset-y-0 left-0 w-1.5 rounded-l-lg transition-colors`} style={{ backgroundColor: activeLayer.color }}></div>
                                    <input 
                                    type="text" 
                                    value={activeLayer.prompt}
                                    onChange={(e) => onUpdateLayerPrompt(activeLayer.id, e.target.value)}
                                    placeholder={`Describe changes for ${activeLayer.colorName} area...`}
                                    className="w-full bg-black/30 border border-white/10 rounded-lg pl-4 pr-10 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:bg-black/50 transition-all shadow-inner"
                                    />
                                    {activeLayer.prompt && (
                                        <button 
                                          onClick={() => onUpdateLayerPrompt(activeLayer.id, '')}
                                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-white"
                                        >
                                            <div className="scale-75"><CloseIcon /></div>
                                        </button>
                                    )}
                                </div>
                            )}

                             {/* Sequential vs Composite Toggle (Integrated into Panel) */}
                            <div className="flex flex-col gap-2 p-2 bg-black/20 rounded-lg border border-white/5 mt-1">
                                <div className="flex items-center justify-between text-xs text-slate-400 px-1">
                                    <span className="font-bold uppercase tracking-wider">Generation Method</span>
                                </div>
                                <div className="flex gap-1">
                                     <button 
                                       onClick={() => !batchMode && onToggleBatchMode()} 
                                       className={`flex-1 py-1.5 px-2 rounded text-xs transition-all border ${!batchMode ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300 font-bold' : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-white/5'}`}
                                     >
                                        Sequential
                                     </button>
                                     <button 
                                       onClick={() => batchMode && onToggleBatchMode()}
                                       className={`flex-1 py-1.5 px-2 rounded text-xs transition-all border ${batchMode ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300 font-bold' : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-white/5'}`}
                                     >
                                        Composite
                                     </button>
                                </div>
                                <div className="px-1 text-[10px] text-slate-500 leading-tight">
                                    {batchMode ? "Merges all masks into one edit. Good for overlapping objects." : "Processes each color mask individually. Better quality for distinct objects."}
                                </div>
                            </div>
                        </div>
                    )}

                    {editorMode === 'ERASE' && (
                        <div className="flex justify-center">
                            <button 
                                onClick={onAutoMaskTripod}
                                className="w-full py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg flex items-center justify-center gap-2 text-sm text-slate-300 hover:text-white transition-colors group"
                            >
                                <div className="w-3 h-3 rounded-full border-2 border-slate-500 border-b-transparent group-hover:border-white group-hover:border-b-transparent transition-colors"></div>
                                Auto-Mask Tripod (Bottom)
                            </button>
                        </div>
                    )}

                    {/* Row 3: Action Button */}
                    <button 
                        onClick={handleGenerateClick}
                        className={`w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg active:scale-95 transition-all text-sm sm:text-base border border-white/10 ${
                            editorMode === 'ERASE' 
                            ? 'bg-gradient-to-r from-pink-600/90 to-rose-600/90 hover:from-pink-500 hover:to-rose-500 text-white shadow-rose-900/20' 
                            : 'bg-gradient-to-r from-cyan-600/90 to-blue-600/90 hover:from-cyan-500 hover:to-blue-500 text-white shadow-cyan-900/20'
                        }`}
                    >
                        <SparklesIcon />
                        {editorMode === 'ERASE' ? "Erase Selection" : "Generate Edit"}
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* --- CAPTURE MODE INTERFACE --- */}
      {isCaptureMode && (
        <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden flex flex-col">
          {/* Capture Region Visualization */}
          <div 
            className="absolute pointer-events-none group"
            style={{
              width: cropSize.width,
              height: cropSize.height,
              left: cropPosition.x - cropSize.width / 2,
              top: cropPosition.y - cropSize.height / 2,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.75)',
              border: '2px solid rgba(255, 255, 255, 0.8)'
            }}
          >
              <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-30 pointer-events-none">
                  <div className="border-r border-white h-full row-span-3"></div>
                  <div className="border-r border-white h-full row-span-3"></div>
                  <div className="border-b border-white w-full col-span-3 row-start-1"></div>
                  <div className="border-b border-white w-full col-span-3 row-start-2"></div>
                  <div className="border-b border-white w-full col-span-3 row-start-3"></div>
              </div>

              {renderHandle('nw', 'cursor-nwse-resize')}
              {renderHandle('n', 'cursor-ns-resize')}
              {renderHandle('ne', 'cursor-nesw-resize')}
              {renderHandle('e', 'cursor-ew-resize')}
              {renderHandle('se', 'cursor-nwse-resize')}
              {renderHandle('s', 'cursor-ns-resize')}
              {renderHandle('sw', 'cursor-nesw-resize')}
              {renderHandle('w', 'cursor-ew-resize')}

              <div 
                  className="absolute -top-16 left-0 right-0 h-16 flex items-center justify-center pointer-events-auto cursor-move group-hover:opacity-100 transition-opacity"
                  onMouseDown={(e) => handleDragStart(e, 'move')}
                  onTouchStart={(e) => handleDragStart(e, 'move')}
              >
                  <div className="bg-cyan-500/80 hover:bg-cyan-500 text-black px-4 py-2 rounded-full flex items-center gap-2 shadow-lg backdrop-blur-sm active:scale-95">
                      <MoveIcon />
                      <span className="text-xs font-bold uppercase tracking-wide">Move</span>
                  </div>
              </div>

              <div className="absolute -bottom-10 left-0 text-white font-mono text-xs bg-black/50 px-2 py-1 rounded flex items-center gap-2 whitespace-nowrap pointer-events-auto">
              <span>{Math.round(cropSize.width)} x {Math.round(cropSize.height)}</span>
              <span className="text-slate-400">|</span>
              <span>{currentRatio.toFixed(2)}:1</span>
              {useCurvature && <span className="text-cyan-400 font-bold border-l border-white/20 pl-2">CURVED</span>}
              {mirrorState.enabled && <span className="text-purple-400 font-bold border-l border-white/20 pl-2">MIRRORED</span>}
            </div>
          </div>

          {/* Bottom Control Panel */}
          <div className="absolute bottom-0 left-0 right-0 p-4 pb-safe bg-gradient-to-t from-black/95 to-transparent pointer-events-auto flex flex-col items-center gap-4">
              <div className="flex flex-wrap justify-center items-center gap-3">
                  <div className="flex flex-wrap justify-center gap-1 bg-black/40 p-1 rounded-lg backdrop-blur-md border border-white/10">
                    {[
                      { label: '21:9', value: 21/9 },
                      { label: '16:9', value: 16/9 },
                      { label: '4:3', value: 4/3 },
                      { label: '1:1', value: 1 },
                    ].map((ratio) => (
                      <button
                        key={ratio.label}
                        onClick={() => setPresetRatio(ratio.value)}
                        className={`px-3 py-2 rounded-md text-sm font-medium transition-all ${
                          Math.abs(currentRatio - ratio.value) < 0.1
                            ? 'bg-white text-black shadow-sm'
                            : 'text-slate-300 hover:text-white hover:bg-white/10'
                        }`}
                      >
                        {ratio.label}
                      </button>
                    ))}
                  </div>

                  {viewMode === ViewMode.SCROLL && (
                    <button
                      onClick={() => setUseCurvature(!useCurvature)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all active:scale-95 ${
                          useCurvature 
                          ? 'bg-cyan-500/20 border-cyan-500 text-cyan-400' 
                          : 'bg-black/40 border-white/10 text-slate-300 hover:bg-white/10'
                      }`}
                    >
                        <div className={`w-3 h-3 rounded-full ${useCurvature ? 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]' : 'bg-slate-500'}`}></div>
                        <span className="inline">Curved</span>
                    </button>
                  )}
              </div>

              <div className="flex items-center gap-4 w-full justify-center">
                <button
                  onClick={onExitCaptureMode}
                  className="flex-1 max-w-[120px] px-4 py-3 rounded-full bg-white/10 hover:bg-white/20 text-white font-medium backdrop-blur-md transition-colors text-sm sm:text-base active:bg-white/30"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCaptureClick}
                  className="flex-1 max-w-[200px] px-4 sm:px-8 py-3 rounded-full bg-cyan-500 hover:bg-cyan-400 text-black font-bold shadow-lg shadow-cyan-500/30 transform active:scale-95 transition-all flex items-center justify-center gap-2 text-sm sm:text-base"
                >
                  <CameraIcon />
                  Take Photo
                </button>
              </div>
          </div>
        </div>
      )}

      {/* --- STANDARD VIEWING INTERFACE --- */}
      {appState !== AppState.EDITING && !isCaptureMode && (
        <div className="absolute inset-0 pointer-events-none z-10 flex flex-col justify-between p-4 pt-safe pb-safe sm:p-6">
          <div className="flex justify-between items-start pointer-events-auto">
            <div className="flex flex-col">
              <h1 className="text-lg sm:text-xl font-bold text-white drop-shadow-md">OmniView 360</h1>
              <button 
                onClick={onReset}
                className="text-xs text-slate-300 hover:text-white underline mt-1 text-left p-1 -ml-1"
              >
                New Image
              </button>
            </div>
            
            <div className="flex flex-col items-end gap-2">
              {/* Context Menu Loading Overlay - Decoupled from contextMenu state */}
              {isGenerating && (
                 <div className="px-4 py-2 bg-black/60 backdrop-blur-md rounded-full border border-white/10 text-white flex items-center gap-3 mb-2 shadow-xl animate-fade-in-up">
                     <div className="w-4 h-4 border-2 border-t-cyan-400 border-r-transparent border-b-cyan-400 border-l-transparent rounded-full animate-spin"></div>
                     <span className="text-sm font-medium">Regenerating Patch...</span>
                 </div>
              )}

              {/* Success Toast */}
              {showSuccess && (
                 <div className="px-4 py-2 bg-green-500/80 backdrop-blur-md rounded-full border border-white/10 text-white flex items-center gap-2 mb-2 shadow-xl animate-fade-in-up">
                     <div className="scale-75"><CheckIcon /></div>
                     <span className="text-sm font-bold">Regeneration Complete!</span>
                 </div>
              )}

              <div className="flex gap-2">
                  <button
                    onClick={toggleMirror}
                    className={`p-3 rounded-full backdrop-blur-md transition-all border border-white/10 ${
                        mirrorState.enabled 
                        ? 'bg-purple-600/80 text-white hover:bg-purple-500/80 shadow-[0_0_10px_rgba(147,51,234,0.5)]' 
                        : 'bg-black/40 text-slate-200 hover:bg-black/60'
                    } active:scale-95`}
                    title={mirrorState.enabled ? "Disable Mirror" : "Enable Mirror Effect"}
                  >
                    <SymmetryIcon />
                  </button>

                  <button
                    onClick={onToggleHistory}
                    className={`p-3 rounded-full backdrop-blur-md transition-all border border-white/10 ${
                        showHistory 
                        ? 'bg-purple-600/80 text-white hover:bg-purple-500/80 shadow-[0_0_10px_rgba(147,51,234,0.5)]' 
                        : 'bg-black/40 text-slate-200 hover:bg-black/60'
                    } active:scale-95`}
                    title={showHistory ? "Hide Past Edits" : "Show Past Edits"}
                  >
                    <LayersIcon />
                  </button>

                  <button
                    onClick={onToggleViewMode}
                    className="flex items-center gap-2 p-3 rounded-full backdrop-blur-md transition-all border border-white/10 bg-black/40 text-slate-200 hover:bg-black/60 active:bg-cyan-500/80 active:scale-95"
                    title={viewMode === ViewMode.SCROLL ? "Switch to Planet View" : "Switch to Scroll View"}
                  >
                    {viewMode === ViewMode.SCROLL ? (
                      <>
                        <GlobeIcon />
                        <span className="hidden sm:inline text-sm font-medium ml-2">Planet View</span>
                      </>
                    ) : (
                      <>
                        <PanoramaIcon />
                        <span className="hidden sm:inline text-sm font-medium ml-2">Scroll Mode</span>
                      </>
                    )}
                  </button>

                  {canUndo && (
                    <button
                      onClick={onUndo}
                      className="p-3 rounded-full backdrop-blur-md transition-all border border-white/10 bg-black/40 text-slate-200 hover:bg-black/60 active:bg-cyan-500/80 active:scale-95"
                      title="Undo Last Edit"
                    >
                      <UndoIcon />
                    </button>
                  )}

                  <button
                    onClick={() => setShowHelp(true)}
                    className="p-3 rounded-full backdrop-blur-md transition-all border border-white/10 bg-black/40 text-slate-200 hover:bg-black/60 active:bg-cyan-500/80 active:scale-95"
                    title="Help & Guide"
                  >
                    <HelpIcon />
                  </button>

                  <button
                    onClick={onEnterStyleMode}
                    className="p-3 rounded-full backdrop-blur-md transition-all border border-white/10 bg-black/40 text-slate-200 hover:bg-black/60 active:bg-cyan-500/80 active:scale-95"
                    title="Global Style Transfer"
                  >
                    <SparklesIcon />
                  </button>

                  <button
                    onClick={onEnterEditMode}
                    className="p-3 rounded-full backdrop-blur-md transition-all border border-white/10 bg-black/40 text-slate-200 hover:bg-black/60 active:bg-cyan-500/80 active:scale-95"
                    title="Nano Banana Editor"
                  >
                    <MagicWandIcon />
                  </button>

                  <button
                    onClick={onEnterCaptureMode}
                    className="p-3 rounded-full backdrop-blur-md transition-all border border-white/10 bg-black/40 text-slate-200 hover:bg-black/60 active:bg-cyan-500/80 active:scale-95"
                    title="Snapshot Mode"
                  >
                    <CameraIcon />
                  </button>

                  <button
                    onClick={onDownload}
                    className="p-3 rounded-full backdrop-blur-md transition-all border border-white/10 bg-black/40 text-slate-200 hover:bg-black/60 active:bg-cyan-500/80 active:scale-95"
                    title="Download Full 360 Image"
                  >
                    <DownloadIcon />
                  </button>
                </div>

                {mirrorState.enabled && (
                  <div className="bg-black/60 backdrop-blur-xl border border-white/10 rounded-xl p-3 mt-1 flex flex-col gap-3 w-48 animate-fade-in-up origin-top-right">
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-400 font-bold uppercase tracking-wider">Direction</span>
                    </div>
                    <div className="flex gap-1 bg-black/40 p-1 rounded-lg">
                        <button 
                          onClick={() => setMirrorDirection('SKY_TO_GROUND')}
                          className={`flex-1 py-2 rounded-md flex items-center justify-center gap-1 transition-all ${mirrorState.direction === 'SKY_TO_GROUND' ? 'bg-purple-500/30 text-purple-300 shadow-inner' : 'text-slate-400 hover:bg-white/5'}`}
                          title="Mirror Top to Bottom"
                        >
                          <ArrowDownIcon />
                        </button>
                        <button 
                          onClick={() => setMirrorDirection('GROUND_TO_SKY')}
                          className={`flex-1 py-2 rounded-md flex items-center justify-center gap-1 transition-all ${mirrorState.direction === 'GROUND_TO_SKY' ? 'bg-purple-500/30 text-purple-300 shadow-inner' : 'text-slate-400 hover:bg-white/5'}`}
                          title="Mirror Bottom to Top"
                        >
                          <ArrowUpIcon />
                        </button>
                    </div>
                    
                    <div className="flex flex-col gap-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-400 font-bold uppercase tracking-wider">Horizon</span>
                          <span className="text-purple-300 font-mono">{(mirrorState.axis * 100).toFixed(0)}%</span>
                        </div>
                        <input 
                          type="range" 
                          min="0.0" 
                          max="1.0" 
                          step="0.01"
                          value={mirrorState.axis}
                          onChange={handleAxisChange}
                          className="w-full h-4 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500 hover:accent-purple-400"
                        />
                    </div>
                  </div>
                )}
            </div>
          </div>

          {/* Analysis Panel */}
          {analysis && (
            <div className="absolute inset-x-0 bottom-0 top-auto sm:inset-auto sm:top-20 sm:bottom-20 sm:right-4 pointer-events-auto flex flex-col items-end z-20 max-h-[60vh] sm:max-h-full sm:w-80">
                <div className="w-full h-full bg-slate-900/90 sm:bg-black/60 backdrop-blur-xl border-t sm:border border-white/10 rounded-t-2xl sm:rounded-2xl p-6 text-white overflow-y-auto shadow-2xl animate-fade-in-up flex flex-col pb-safe">
                    <div className="flex justify-between items-center mb-4 shrink-0">
                      <h2 className="text-lg font-semibold flex items-center gap-2">
                        <SparklesIcon /> Analysis
                      </h2>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1 px-2 py-0.5 bg-cyan-500/20 rounded-full border border-cyan-500/30">
                            <div className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse"></div>
                            <span className="text-[9px] font-bold text-cyan-400 uppercase tracking-tighter">Live</span>
                        </div>
                        <button 
                            onClick={onCloseAnalysis}
                            className="p-2 rounded-full hover:bg-white/10 transition-colors"
                            aria-label="Close Analysis"
                        >
                            <CloseIcon />
                        </button>
                      </div>
                    </div>
                    
                    <div className="space-y-4 overflow-y-auto">
                        <div>
                            <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400 mb-1">Atmosphere</h3>
                            <p className="text-sm leading-relaxed text-slate-200">{analysis.atmosphere}</p>
                        </div>
                        
                        <div>
                            <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400 mb-1">Description</h3>
                            <p className="text-sm leading-relaxed text-slate-200">{analysis.description}</p>
                        </div>

                        <div>
                            <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400 mb-1">Key Objects</h3>
                            <div className="flex flex-wrap gap-2">
                                {analysis.objects.map((obj, i) => {
                                    const location = analysis.objectLocations?.find(l => 
                                        l.object.toLowerCase().includes(obj.toLowerCase()) || 
                                        obj.toLowerCase().includes(l.object.toLowerCase())
                                    );
                                    return (
                                        <button 
                                            key={i} 
                                            onClick={() => location && onJumpToLocation(location.x, location.y)}
                                            className={`text-xs px-2 py-1 rounded-md border transition-all flex items-center gap-1 ${
                                                location 
                                                ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/40 cursor-pointer' 
                                                : 'bg-white/10 border-white/5 text-slate-400'
                                            }`}
                                        >
                                            {obj}
                                            {location && <span className="text-[10px]">📍</span>}
                                        </button>
                                    );
                                })}
                            </div>
                            {analysis.objectLocations && analysis.objectLocations.length > 0 && (
                                <p className="text-[10px] text-slate-500 mt-2 italic">Click objects with 📍 to jump to them</p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
          )}

          {/* Bottom Control Bar */}
          <div className="flex justify-center pointer-events-auto pb-safe">
            {appState !== AppState.ANALYZING && !analysis && (
                <button
                    onClick={onAnalyze}
                    className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white rounded-full font-medium shadow-lg hover:shadow-xl transition-all transform hover:-translate-y-1 mb-4 sm:mb-0 active:scale-95"
                >
                    <SparklesIcon />
                    Analyze Scene
                </button>
            )}

            {appState === AppState.ANALYZING && (
                <div className="px-6 py-3 bg-black/60 backdrop-blur-md rounded-full border border-white/10 text-white flex items-center gap-3 mb-4 sm:mb-0">
                    <div className="w-5 h-5 border-2 border-t-cyan-400 border-r-transparent border-b-cyan-400 border-l-transparent rounded-full animate-spin"></div>
                    <span>Analyzing scene...</span>
                </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default UIOverlay;