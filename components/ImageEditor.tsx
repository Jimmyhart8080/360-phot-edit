import React, { useRef, useState, useEffect } from 'react';
import { BrushIcon, CloseIcon, SparklesIcon, UndoIcon, CheckIcon, RefreshIcon } from './Icons';

interface ImageEditorProps {
  imageSrc: string;
  onCancel: () => void;
  onGeneratePatch: (cropBase64: string, prompt: string) => Promise<string>;
  onComplete: (fullBase64: string) => void;
}

const ImageEditor: React.FC<ImageEditorProps> = ({ imageSrc, onCancel, onGeneratePatch, onComplete }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isReviewing, setIsReviewing] = useState(false);
  const [brushSize, setBrushSize] = useState(20);
  const [prompt, setPrompt] = useState('');
  const [imageLoaded, setImageLoaded] = useState(false);
  
  const historyRef = useRef<ImageData[]>([]);
  const imgRef = useRef<HTMLImageElement>(new Image());
  const preGenStateRef = useRef<ImageData | null>(null);
  
  // Track the area that has been modified to optimize generation
  const dirtyRect = useRef({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

  const resetDirtyRect = () => {
    dirtyRect.current = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  };

  const updateDirtyRect = (x: number, y: number) => {
    // Calculate radius based on brush size and scale (approximate)
    // We want to be generous to catch antialiasing
    const radius = (brushSize * (canvasRef.current!.width / 1000)) / 2 + 5;
    
    dirtyRect.current.minX = Math.min(dirtyRect.current.minX, x - radius);
    dirtyRect.current.minY = Math.min(dirtyRect.current.minY, y - radius);
    dirtyRect.current.maxX = Math.max(dirtyRect.current.maxX, x + radius);
    dirtyRect.current.maxY = Math.max(dirtyRect.current.maxY, y + radius);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx && containerRef.current) {
      imgRef.current.src = imageSrc;
      imgRef.current.onload = () => {
        // Fit canvas to container while maintaining aspect ratio
        const maxWidth = containerRef.current!.clientWidth;
        const maxHeight = containerRef.current!.clientHeight;
        const aspect = imgRef.current.width / imgRef.current.height;

        let w = maxWidth;
        let h = w / aspect;

        if (h > maxHeight) {
           h = maxHeight;
           w = h * aspect;
        }

        canvas.width = imgRef.current.width;
        canvas.height = imgRef.current.height;
        
        // Render image
        ctx.drawImage(imgRef.current, 0, 0);
        
        // Save initial state
        historyRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
        resetDirtyRect();
        setImageLoaded(true);
      };
    }
  }, [imageSrc]);

  const getCoordinates = (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    let clientX, clientY;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = (e as React.MouseEvent).clientX;
      clientY = (e as React.MouseEvent).clientY;
    }

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    if (isGenerating || isReviewing) return;
    setIsDrawing(true);
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      const { x, y } = getCoordinates(e);
      updateDirtyRect(x, y);
      ctx.moveTo(x, y);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.4)'; // Semi-transparent red mask
      ctx.lineWidth = brushSize * (canvasRef.current!.width / 1000); // Scale brush relative to image
    }
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || isGenerating || isReviewing) return;
    e.preventDefault(); // Prevent scrolling on touch
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      const { x, y } = getCoordinates(e);
      updateDirtyRect(x, y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  };

  const stopDrawing = () => {
    if (isDrawing) {
      setIsDrawing(false);
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx && canvasRef.current) {
        ctx.closePath();
        // Push to history
        if (historyRef.current.length > 10) historyRef.current.shift();
        historyRef.current.push(ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height));
      }
    }
  };

  const handleUndo = () => {
     if (isGenerating || isReviewing) return;
     const ctx = canvasRef.current?.getContext('2d');
     if (ctx && historyRef.current.length > 1) {
         historyRef.current.pop(); // Remove current state
         const previousState = historyRef.current[historyRef.current.length - 1];
         ctx.putImageData(previousState, 0, 0);
         // Note: We do not shrink the dirty rect on undo, for simplicity.
     } else if (ctx && historyRef.current.length === 1) {
         // Re-render original image if only one state left
         ctx.drawImage(imgRef.current, 0, 0);
         resetDirtyRect();
     }
  };

  const handleGenerate = async () => {
      if (!canvasRef.current || isGenerating || !prompt.trim()) return;
      
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // 1. Calculate Crop Bounds with Padding
      // Ensure we have some area selected
      if (dirtyRect.current.minX === Infinity) return;

      const PADDING = 128; // Padding pixels for context
      const minX = Math.max(0, Math.floor(dirtyRect.current.minX - PADDING));
      const minY = Math.max(0, Math.floor(dirtyRect.current.minY - PADDING));
      const maxX = Math.min(canvas.width, Math.ceil(dirtyRect.current.maxX + PADDING));
      const maxY = Math.min(canvas.height, Math.ceil(dirtyRect.current.maxY + PADDING));
      
      const width = maxX - minX;
      const height = maxY - minY;

      // Ensure dimensions are valid and not too small for the model to make sense of it
      if (width <= 0 || height <= 0) return;

      try {
        setIsGenerating(true);
        
        // Save state before generating so we can retry
        preGenStateRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // 2. Create Temporary Canvas for Crop
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d');
        
        if (!tempCtx) throw new Error("Could not create temp canvas");

        // Draw the cropped area from main canvas
        tempCtx.drawImage(canvas, minX, minY, width, height, 0, 0, width, height);
        
        const cropBase64 = tempCanvas.toDataURL('image/jpeg', 0.95).split(',')[1];

        // 3. Call API
        const patchBase64 = await onGeneratePatch(cropBase64, prompt);

        // 4. Stitch Result Back
        const patchImg = new Image();
        patchImg.onload = () => {
            // Draw patch back onto the main canvas
            ctx.drawImage(patchImg, minX, minY, width, height);
            
            // Enter Review Mode
            setIsGenerating(false);
            setIsReviewing(true);
        };
        patchImg.src = `data:image/jpeg;base64,${patchBase64}`;

      } catch (e) {
        console.error("Generation failed:", e);
        alert("Failed to generate edit. Please try again.");
        setIsGenerating(false);
      }
  };

  const handleAccept = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const fullBase64 = canvas.toDataURL('image/jpeg', 0.95);
      onComplete(fullBase64);
      resetDirtyRect();
      setIsReviewing(false);
  };

  const handleRetry = () => {
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx && preGenStateRef.current) {
          ctx.putImageData(preGenStateRef.current, 0, 0);
      }
      setIsReviewing(false);
      // We do not reset dirty rect here, allowing the user to try again with the same mask
  };

  return (
    <div className="absolute inset-0 bg-slate-900 z-50 flex flex-col">
      {/* Header */}
      <div className="p-4 bg-slate-800 border-b border-white/10 flex justify-between items-center z-10">
         <h2 className="text-white font-bold flex items-center gap-2">
            <BrushIcon /> Nano Banana Editor
         </h2>
         {!isGenerating && !isReviewing && (
            <button onClick={onCancel} className="p-2 hover:bg-white/10 rounded-full text-white">
                <CloseIcon />
            </button>
         )}
      </div>

      {/* Canvas Area */}
      <div ref={containerRef} className="flex-1 relative bg-black flex items-center justify-center overflow-hidden p-4">
         {!imageLoaded && <div className="text-slate-400 animate-pulse">Loading image...</div>}
         <canvas 
           ref={canvasRef}
           className={`max-w-full max-h-full shadow-2xl touch-none ${isGenerating || isReviewing ? 'cursor-default' : 'cursor-crosshair'}`}
           style={{ display: imageLoaded ? 'block' : 'none', opacity: isGenerating ? 0.5 : 1 }}
           onMouseDown={startDrawing}
           onMouseMove={draw}
           onMouseUp={stopDrawing}
           onMouseLeave={stopDrawing}
           onTouchStart={startDrawing}
           onTouchMove={draw}
           onTouchEnd={stopDrawing}
         />
         
         {isGenerating && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-20 pointer-events-none">
                <div className="w-12 h-12 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mb-4"></div>
                <div className="px-4 py-2 bg-black/60 backdrop-blur-md rounded-lg text-white font-medium">
                   Generating edit...
                </div>
            </div>
         )}
      </div>

      {/* Toolbar */}
      <div className={`p-4 bg-slate-800 border-t border-white/10 flex flex-col gap-4 z-10 pb-safe transition-all`}>
         
         {/* Edit Mode Toolbar */}
         {!isReviewing && (
           <>
              <div className={`flex items-center gap-4 ${isGenerating ? 'opacity-50 pointer-events-none' : ''}`}>
                  <div className="flex-1 flex flex-col gap-1">
                      <div className="flex justify-between text-xs text-slate-400">
                          <span>Brush Size</span>
                          <span>{brushSize}px</span>
                      </div>
                      <input 
                        type="range" 
                        min="5" 
                        max="100" 
                        value={brushSize} 
                        onChange={(e) => setBrushSize(Number(e.target.value))}
                        className="w-full h-1.5 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                      />
                  </div>
                  <button onClick={handleUndo} className="p-3 bg-white/10 hover:bg-white/20 rounded-lg text-white" title="Undo">
                      <UndoIcon />
                  </button>
              </div>

              <div className={`flex gap-2 ${isGenerating ? 'opacity-50 pointer-events-none' : ''}`}>
                  <input 
                    type="text" 
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe the changes for the highlighted area..."
                    className="flex-1 bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                  <button 
                    onClick={handleGenerate}
                    disabled={!prompt.trim()}
                    className="px-6 bg-gradient-to-r from-cyan-500 to-blue-600 disabled:opacity-50 disabled:cursor-not-allowed hover:from-cyan-400 hover:to-blue-500 text-white font-bold rounded-lg flex items-center gap-2 shadow-lg"
                  >
                    <SparklesIcon />
                    Generate
                  </button>
              </div>
           </>
         )}

         {/* Review Mode Toolbar */}
         {isReviewing && (
            <div className="flex gap-4 animate-fade-in-up">
               <button 
                 onClick={handleRetry}
                 className="flex-1 py-3 rounded-lg bg-white/10 hover:bg-white/20 text-white font-semibold flex items-center justify-center gap-2 border border-white/5"
               >
                 <RefreshIcon />
                 Retry
               </button>
               <button 
                 onClick={handleAccept}
                 className="flex-1 py-3 rounded-lg bg-green-500 hover:bg-green-400 text-white font-bold flex items-center justify-center gap-2 shadow-lg shadow-green-500/20"
               >
                 <CheckIcon />
                 Accept
               </button>
            </div>
         )}
      </div>
    </div>
  );
};

export default ImageEditor;