import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { checkAccessibilityPermission, requestAccessibilityPermission, checkScreenRecordingPermission, requestScreenRecordingPermission } from 'tauri-plugin-macos-permissions-api';
import { type as typeOs } from '@tauri-apps/plugin-os';
import { writeFile } from "@tauri-apps/plugin-fs";
import { message } from "@tauri-apps/plugin-dialog";
import { join, downloadDir } from "@tauri-apps/api/path";
import Settings from "./Settings";
import { loadSettings } from "./store";
import React, { ErrorInfo } from 'react';
import "./App.css";

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean, error: Error | null}> {
  constructor(props: {children: React.ReactNode}) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-red-900 text-white p-6 overflow-auto">
          <h1 className="text-xl font-bold mb-4">App Crashed</h1>
          <pre className="text-xs whitespace-pre-wrap">{this.state.error?.stack || this.state.error?.toString()}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// ----------------------------------------------------
// Types
// ----------------------------------------------------
type Tool = "rect" | "circle" | "arrow" | "freehand" | "blur" | null;
type Point = { x: number; y: number };

interface Annotation {
  tool: Tool;
  color: string;
  lineWidth: number;
  points: Point[]; 
  rect?: { x: number; y: number; w: number; h: number }; 
}

// ----------------------------------------------------
// Control Panel Window
// ----------------------------------------------------
function ControlPanel() {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isScrollingSetup, setIsScrollingSetup] = useState(false);

  const handleCapture = async (mode: "fullscreen" | "region" | "window") => {
    setLoading(true);
    setErrorMsg(null);
    try {
      // Hide the control panel window before capturing so it's not visible in the screenshot
      await getCurrentWindow().hide();
      await new Promise(r => setTimeout(r, 200));
      
      // takes screenshot and stores bytes in Rust memory
      await invoke("take_screenshot");
      
      let target = "main";
      if (mode === "region" || mode === "window" || isScrollingSetup) {
        target = "region-selector";
      }
      
      // Wake up the target window explicitly so its JS context resumes
      const targetWindow = new Window(target);
      await targetWindow.show();
      await targetWindow.setFocus();
      
      // emit lightweight signal
      await emit("load-image", { target, isScrolling: isScrollingSetup, isWindowMode: mode === "window", isFullScreen: mode === "fullscreen" });
      await getCurrentWindow().hide();
      setIsScrollingSetup(false); // reset state after use
    } catch (e: any) {
      console.error(e);
      setErrorMsg(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        getCurrentWindow().hide();
        setIsScrollingSetup(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    
    const unlisten = listen("open-control-panel-for-scrolling", async () => {
      setIsScrollingSetup(true);
      await getCurrentWindow().show();
      await getCurrentWindow().setFocus();
    });
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      unlisten.then(f => f());
    };
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-navy-900 border-2 border-navy-700 rounded-lg select-none p-4 relative">
      {errorMsg && (
        <div className="absolute top-0 left-0 w-full bg-red-500 text-white text-xs p-1 text-center">
          {errorMsg}
        </div>
      )}
      <h2 className="text-white font-semibold mb-4 opacity-80 mt-2">
        {isScrollingSetup ? "Select Scrolling Area" : "Select Capture Mode"}
      </h2>
      <div className="flex gap-4">
        <button 
          onClick={() => handleCapture("fullscreen")}
          disabled={loading}
          className={`flex flex-col items-center gap-2 p-4 bg-navy-800 hover:bg-navy-700 rounded-xl transition-all w-32 border shadow-md active:scale-95 ${isScrollingSetup ? "border-emerald-600 shadow-emerald-900/50" : "border-navy-600"}`}
        >
          <span className="text-2xl">🖥️</span>
          <span className="text-white font-medium text-sm">Full Screen</span>
        </button>
        <button 
          onClick={() => handleCapture("region")}
          disabled={loading}
          className={`flex flex-col items-center gap-2 p-4 bg-navy-800 hover:bg-navy-700 rounded-xl transition-all w-32 border shadow-md active:scale-95 ${isScrollingSetup ? "border-emerald-600 shadow-emerald-900/50" : "border-navy-600"}`}
        >
          <span className="text-2xl">✂️</span>
          <span className="text-white font-medium text-sm">Region</span>
        </button>
        <button 
          onClick={() => handleCapture("window")}
          disabled={loading}
          className={`flex flex-col items-center gap-2 p-4 bg-navy-800 hover:bg-navy-700 rounded-xl transition-all w-32 border shadow-md active:scale-95 ${isScrollingSetup ? "border-emerald-600 shadow-emerald-900/50" : "border-navy-600"}`}
        >
          <span className="text-2xl">🪟</span>
          <span className="text-white font-medium text-sm">Window</span>
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------
// Region Selector Window
// ----------------------------------------------------
function RegionSelector() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [baseImage, setBaseImage] = useState<HTMLImageElement | HTMLCanvasElement | null>(null);
  const [startPos, setStartPos] = useState<Point | null>(null);
  const [currentPos, setCurrentPos] = useState<Point | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isScrollingMode, setIsScrollingMode] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isHiding, setIsHiding] = useState(false);
  const [isWindowMode, setIsWindowMode] = useState(false);
  const [monitorPos, setMonitorPos] = useState({ x: 0, y: 0 });
  const [windows, setWindows] = useState<any[]>([]);
  const [hoveredWindow, setHoveredWindow] = useState<any | null>(null);
  const [pendingFullScreenScroll, setPendingFullScreenScroll] = useState(false);

  useEffect(() => {
    const unlistenStop = listen("scrolling-stopped", async () => {
      setIsRecording(false);
      try { await getCurrentWindow().setIgnoreCursorEvents(false); } catch (e) { console.warn(e); }
      
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke("stop_scrolling_capture");
      } catch (e) {
        console.error("Error stopping scrolling capture:", e);
      }
      
      await emit("load-image", { target: "main" });
      await getCurrentWindow().hide();
    });
    return () => { unlistenStop.then(f => f()); }
  }, []);

  useEffect(() => {
    const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      await getCurrentWindow().hide();
    });

    const unlisten = listen<{ target: string, isScrolling?: boolean, isWindowMode?: boolean, isFullScreen?: boolean }>("load-image", async (e) => {
      if (e.payload.target !== "region-selector") return;
      setIsScrollingMode(e.payload.isScrolling || false);
      setIsRecording(false);
      setIsHiding(false);
      
      try { await getCurrentWindow().setIgnoreCursorEvents(false); } catch (err) { console.warn(err); }
      
      try {
        const { currentMonitor, primaryMonitor } = await import('@tauri-apps/api/window');
        let monitor = await currentMonitor();
        if (!monitor) {
          monitor = await primaryMonitor();
        }
        
        if (monitor) {
          setMonitorPos({ x: monitor.position.x, y: monitor.position.y });
          await getCurrentWindow().setSize(monitor.size);
          await getCurrentWindow().setPosition(monitor.position);
        }
        
        setIsWindowMode(e.payload.isWindowMode || false);
        if (e.payload.isWindowMode) {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const winList = await invoke<any[]>("get_windows");
            setWindows(winList);
          } catch (err) {
            console.error("Failed to fetch windows", err);
          }
        }
        
        await getCurrentWindow().show(); // Force show to display errors
        await getCurrentWindow().setFocus();
        
        // Fetch raw PNG bytes via IPC
        const bytes = await invoke<ArrayBuffer | Uint8Array>("get_image_buffer");
        
        const blob = new Blob([bytes], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        
        const img = new Image();
        img.onload = () => {
          const offCanvas = document.createElement("canvas");
          offCanvas.width = img.width;
          offCanvas.height = img.height;
          const offCtx = offCanvas.getContext("2d");
          if (offCtx) offCtx.drawImage(img, 0, 0);
          setBaseImage(offCanvas);
          URL.revokeObjectURL(url);
          
          if (e.payload.isFullScreen && e.payload.isScrolling) {
            setPendingFullScreenScroll(true);
          }
        };
        img.onerror = () => {
          setErrorMsg("Failed to load image from backend.");
          URL.revokeObjectURL(url);
        };
        img.src = url;
      } catch (err: any) {
        setErrorMsg(String(err));
      }
    });
    return () => { 
      unlisten.then(f => f()); 
      unlistenClose.then(f => f());
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (!canvas || !baseImage) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      // Draw full image dimmed
      ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (isRecording) {
        // If recording, we just want a clear canvas because the window will be hidden.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      // Draw bright selection area
      if (isWindowMode && hoveredWindow && !isDragging) {
        // Draw window highlight
        const wx = hoveredWindow.x - monitorPos.x;
        const wy = hoveredWindow.y - monitorPos.y;
        const ww = hoveredWindow.width;
        const wh = hoveredWindow.height;
        
        ctx.save();
        ctx.beginPath();
        ctx.rect(wx, wy, ww, wh);
        ctx.clip();
        ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
        ctx.restore();
        
        ctx.fillStyle = "rgba(129, 140, 248, 0.2)"; // Soft blue tint
        ctx.fillRect(wx, wy, ww, wh);
        ctx.strokeStyle = "#818cf8";
        ctx.lineWidth = 3;
        ctx.strokeRect(wx, wy, ww, wh);
      } else if (startPos && currentPos) {
        const rx = Math.min(startPos.x, currentPos.x);
        const ry = Math.min(startPos.y, currentPos.y);
        const rw = Math.abs(currentPos.x - startPos.x);
        const rh = Math.abs(currentPos.y - startPos.y);

        ctx.save();
        ctx.beginPath();
        ctx.rect(rx, ry, rw, rh);
        ctx.clip();
        ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
        ctx.restore();
        
        ctx.strokeStyle = "#818cf8";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(rx, ry, rw, rh);
      }
    };
    
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, [baseImage, startPos, currentPos, isRecording, isWindowMode, hoveredWindow, monitorPos]);

  useEffect(() => {
    if (pendingFullScreenScroll && baseImage) {
      setPendingFullScreenScroll(false);
      startScrollingCaptureLogic(0, 0, window.innerWidth, window.innerHeight);
    }
  }, [pendingFullScreenScroll, baseImage]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        getCurrentWindow().hide();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const startScrollingCaptureLogic = async (rx: number, ry: number, rw: number, rh: number) => {
    if (!baseImage) return;
    const scaleX = baseImage.width / window.innerWidth;
    const scaleY = baseImage.height / window.innerHeight;
    
    const physicalW = Math.round(rw * scaleX);
    const physicalH = Math.round(rh * scaleY);
    const physicalX = Math.round(rx * scaleX);
    const physicalY = Math.round(ry * scaleY);
    
    setIsRecording(true);
    setIsHiding(true);
    
    // Wait just 50ms for the DOM to paint the opacity: 0
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Hide Region Selector asynchronously (OS might take 200ms+ due to animation)
    getCurrentWindow().hide().catch(console.error);

    // 6. Show the stop recording button
    const { Window } = await import('@tauri-apps/api/window');
    const stopWin = await Window.getByLabel('stop-recording');
    const { loadSettings } = await import('./store');
    const settings = await loadSettings();
    
    if (stopWin) {
      const { LogicalPosition } = await import('@tauri-apps/api/dpi');
      const pos = settings.stopButtonPosition || "bottom";
      
      const margin = 50;
      const w = 80;
      const h = 80;
      let nx = window.innerWidth / 2 - w / 2;
      let ny = window.innerHeight - h - margin;
      
      if (pos === "top") {
          ny = margin;
      } else if (pos === "left") {
          nx = margin;
          ny = window.innerHeight / 2 - h / 2;
      } else if (pos === "right") {
          nx = window.innerWidth - w - margin;
          ny = window.innerHeight / 2 - h / 2;
      }
      
      if (pos !== "hidden") {
        await stopWin.setPosition(new LogicalPosition(nx, ny));
        await stopWin.show();
      }
    }
    
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke("start_scrolling_capture", {
        x: physicalX,
        y: physicalY,
        w: physicalW,
        h: physicalH,
        maxDurationSeconds: settings.maxRecordingDuration || 30
      });
      // Do NOT call load-image yet. We wait for stop_scrolling_capture.
    } catch (e) {
      console.error(e);
      if (stopWin) stopWin.hide().catch(console.error);
      setIsRecording(false);
      setIsHiding(false);
      await getCurrentWindow().show();
    }
  };

  const onMouseDown = async (e: React.MouseEvent) => {
    if (isRecording) return;
    
    if (isWindowMode) {
      if (hoveredWindow) {
        if (isScrollingMode) {
          // Manually trigger the scrolling logic
          const rx = hoveredWindow.x - monitorPos.x;
          const ry = hoveredWindow.y - monitorPos.y;
          const rw = hoveredWindow.width;
          const rh = hoveredWindow.height;
          await startScrollingCaptureLogic(rx, ry, rw, rh);
        } else {
          // Take regular window screenshot
          try {
            setIsHiding(true);
            await getCurrentWindow().hide();
            
            const { invoke } = await import('@tauri-apps/api/core');
            
            // Activate the target app to ensure traffic lights are colored
            if (hoveredWindow.app_name) {
              await invoke("activate_app", { appName: hoveredWindow.app_name });
              await new Promise(resolve => setTimeout(resolve, 300));
            }
            
            await invoke("capture_window", { id: hoveredWindow.id });
            await emit("load-image", { target: "main" });
          } catch (err) {
            console.error("Window capture failed", err);
          }
        }
      }
      return;
    }
    
    setStartPos({ x: e.clientX, y: e.clientY });
    setCurrentPos({ x: e.clientX, y: e.clientY });
    setIsDragging(true);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (isRecording) return;
    
    if (isWindowMode && !isDragging) {
      // Find the hovered window
      const globalX = e.clientX + monitorPos.x;
      const globalY = e.clientY + monitorPos.y;
      
      const hovered = windows.find(w => 
        globalX >= w.x && globalX <= w.x + w.width &&
        globalY >= w.y && globalY <= w.y + w.height
      );
      setHoveredWindow(hovered || null);
      return;
    }
    
    if (!isDragging) return;
    setCurrentPos({ x: e.clientX, y: e.clientY });
  };

  const onMouseUp = async () => {
    if (!isDragging || !startPos || !currentPos || !baseImage || !canvasRef.current || isRecording) return;
    setIsDragging(false);

    const rx = Math.min(startPos.x, currentPos.x);
    const ry = Math.min(startPos.y, currentPos.y);
    const rw = Math.abs(currentPos.x - startPos.x);
    const rh = Math.abs(currentPos.y - startPos.y);

    if (rw > 10 && rh > 10) {
      if (isScrollingMode) {
        await startScrollingCaptureLogic(rx, ry, rw, rh);
      } else {
        // Crop image
        const scaleX = baseImage.width / window.innerWidth;
        const scaleY = baseImage.height / window.innerHeight;
        
        const physicalW = Math.round(rw * scaleX);
        const physicalH = Math.round(rh * scaleY);
        const physicalX = Math.round(rx * scaleX);
        const physicalY = Math.round(ry * scaleY);
        
        const offCanvas = document.createElement("canvas");
        offCanvas.width = physicalW;
        offCanvas.height = physicalH;
        const offCtx = offCanvas.getContext("2d");
        if (offCtx) {
          offCtx.drawImage(
            baseImage,
            physicalX, physicalY, physicalW, physicalH,
            0, 0, physicalW, physicalH
          );
          
          const dataUrl = offCanvas.toDataURL("image/png");
          const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
          const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
          
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke("store_cropped_image", { bytes: Array.from(bytes) });
            await emit("load-image", { target: "main" });
          } catch (err) {
            console.error("Failed to store cropped image", err);
          }
        }
        await getCurrentWindow().hide();
      }
    } else {
      // User clicked without dragging, abort
      await getCurrentWindow().hide();
    }
  };

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        await getCurrentWindow().hide();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="h-screen w-screen cursor-crosshair relative" style={{ opacity: isHiding ? 0 : 1 }}>
       {errorMsg && <div className="absolute top-0 left-0 w-full p-4 bg-red-600 text-white z-50 overflow-auto max-h-full font-mono text-sm">{errorMsg}</div>}
       <canvas 
          ref={canvasRef}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          className="w-full h-full block"
       />
    </div>
  );
}

// ----------------------------------------------------
// Editor Window (Main)
// ----------------------------------------------------
function Editor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [baseImage, setBaseImage] = useState<HTMLImageElement | HTMLCanvasElement | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[]>([]);
  const [currentTool, setCurrentTool] = useState<Tool>("rect");
  const [currentColor, setCurrentColor] = useState<string>("#ef4444"); 
  const [lineWidth, setLineWidth] = useState<number>(4);
  
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentAnnotation, setCurrentAnnotation] = useState<Annotation | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState<{width: number, height: number} | null>(null);

  useEffect(() => {
    const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      await getCurrentWindow().hide();
    });

    const unlisten = listen<{ dataUrl?: string, target: string }>("load-image", async (e) => {
      if (e.payload.target !== "main") return;

      try {
        await getCurrentWindow().center();
        await getCurrentWindow().show();
        await getCurrentWindow().setFocus();
        if (e.payload.dataUrl) {
          // Came from region selector crop
          const img = new Image();
          img.onload = async () => {
            const canvas = canvasRef.current;
            if (canvas) {
              canvas.width = img.width;
              canvas.height = img.height;
            }
            setCanvasSize({ width: img.width, height: img.height });
            setBaseImage(img);
            setAnnotations([]);
            setRedoStack([]);
            await getCurrentWindow().center();
            await getCurrentWindow().show();
            await getCurrentWindow().setFocus();
          };
          img.src = e.payload.dataUrl;
        } else {
          // Re-fetch raw PNG bytes via IPC
          const bytes = await invoke<ArrayBuffer | Uint8Array>("get_image_buffer");
          const blob = new Blob([bytes], { type: 'image/png' });
          const url = URL.createObjectURL(blob);
          
          const img = new Image();
          img.onload = async () => {
            const canvas = canvasRef.current;
            if (canvas) {
              canvas.width = img.width;
              canvas.height = img.height;
            }
            setCanvasSize({ width: img.width, height: img.height });
            setBaseImage(img);
            setAnnotations([]);
            setRedoStack([]);
            await getCurrentWindow().center();
            await getCurrentWindow().show();
            URL.revokeObjectURL(url);
          };
          img.onerror = () => {
            setErrorMsg("Failed to load image from backend.");
            URL.revokeObjectURL(url);
          };
          img.src = url;
        }
      } catch (err: any) {
         setErrorMsg(String(err));
      }
    });
    return () => { 
      unlisten.then(f => f()); 
      unlistenClose.then(f => f());
    };
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (baseImage) {
      ctx.drawImage(baseImage, 0, 0);
    } else {
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const allAnns = currentAnnotation ? [...annotations, currentAnnotation] : annotations;

    // FIX BLUR BUG: Draw blur annotations first
    const blurAnns = allAnns.filter(a => a.tool === "blur");
    const otherAnns = allAnns.filter(a => a.tool !== "blur");

    const drawAnn = (ann: Annotation) => {
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.lineWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      
      if (ann.tool === "rect" && ann.rect) {
        ctx.strokeRect(ann.rect.x, ann.rect.y, ann.rect.w, ann.rect.h);
      } else if (ann.tool === "circle" && ann.rect) {
        const { x, y, w, h } = ann.rect;
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, 2 * Math.PI);
        ctx.stroke();
      } else if (ann.tool === "blur" && ann.rect) {
        const { x, y, w, h } = ann.rect;
        if (w > 0 && h > 0) {
          const blockSize = Math.max(4, ann.lineWidth * 2);
          const dw = Math.max(1, Math.floor(w / blockSize));
          const dh = Math.max(1, Math.floor(h / blockSize));
          
          const temp = document.createElement("canvas");
          temp.width = dw;
          temp.height = dh;
          const tCtx = temp.getContext("2d");
          if (tCtx) {
            tCtx.drawImage(baseImage, x, y, w, h, 0, 0, dw, dh);
            
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(temp, 0, 0, dw, dh, x, y, w, h);
            ctx.restore();
          }
        }
      } else if (ann.tool === "freehand" && ann.points.length > 0) {
        ctx.beginPath();
        ctx.moveTo(ann.points[0].x, ann.points[0].y);
        for (let i = 1; i < ann.points.length; i++) {
          ctx.lineTo(ann.points[i].x, ann.points[i].y);
        }
        ctx.stroke();
      } else if (ann.tool === "arrow" && ann.points.length >= 2) {
         const start = ann.points[0];
         const end = ann.points[ann.points.length - 1];
         ctx.beginPath();
         ctx.moveTo(start.x, start.y);
         ctx.lineTo(end.x, end.y);
         ctx.stroke();
         const headlen = 15;
         const angle = Math.atan2(end.y - start.y, end.x - start.x);
         ctx.beginPath();
         ctx.moveTo(end.x, end.y);
         ctx.lineTo(end.x - headlen * Math.cos(angle - Math.PI / 6), end.y - headlen * Math.sin(angle - Math.PI / 6));
         ctx.moveTo(end.x, end.y);
         ctx.lineTo(end.x - headlen * Math.cos(angle + Math.PI / 6), end.y - headlen * Math.sin(angle + Math.PI / 6));
         ctx.stroke();
      }
    };

    blurAnns.forEach(drawAnn);
    otherAnns.forEach(drawAnn);

  }, [baseImage, annotations, currentAnnotation]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const getMousePos = (e: React.MouseEvent | MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    
    // Fallback if dimensions are 0
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!baseImage) return;
    setIsDrawing(true);
    const pos = getMousePos(e);
    setCurrentAnnotation({ tool: currentTool, color: currentColor, lineWidth, points: [pos], rect: { x: pos.x, y: pos.y, w: 0, h: 0 }});
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || !currentAnnotation) return;
    const pos = getMousePos(e);

    setCurrentAnnotation(prev => {
      if (!prev) return prev;
      if (prev.tool === "freehand") {
        return { ...prev, points: [...prev.points, pos] };
      }
      if (prev.tool === "rect" || prev.tool === "blur" || prev.tool === "circle") {
        const startPos = prev.points[0];
        return {
          ...prev,
          rect: {
            x: Math.min(startPos.x, pos.x),
            y: Math.min(startPos.y, pos.y),
            w: Math.abs(pos.x - startPos.x),
            h: Math.abs(pos.y - startPos.y)
          }
        };
      }
      if (prev.tool === "arrow") {
        return { ...prev, points: [prev.points[0], pos] };
      }
      return prev;
    });
  };

  const onMouseUp = () => {
    if (isDrawing && currentAnnotation) {
      setAnnotations(prev => [...prev, currentAnnotation]);
      setRedoStack([]);
    }
    setIsDrawing(false);
    setCurrentAnnotation(null);
  };

  const handleSave = useCallback(async () => {
    if (!canvasRef.current) return;
    try {
      const settings = await loadSettings();
      const defaultDir = settings.defaultSaveLocation;
      
      const fileName = settings.namingConvention
        .replace("{YYYY-MM-DD}", new Date().toISOString().split('T')[0])
        .replace("{HH-MM-SS}", new Date().toTimeString().split(' ')[0].replace(/:/g, '-'))
        .replace("{TIMESTAMP}", Date.now().toString())
        + ".png";

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvasRef.current!.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error("Blob generation failed"));
        }, "image/png");
      });

      let saveDir = defaultDir;
      if (!saveDir) {
        saveDir = await downloadDir();
      }

      try {
        const buffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(buffer);
        const filePath = await join(saveDir, fileName);
        await writeFile(filePath, uint8Array);
      } catch (fsErr) {
        setErrorMsg("FS Plugin write failed: " + fsErr);
        console.error("FS Plugin write failed", fsErr);
      }
      
      await getCurrentWindow().hide();
    } catch (e) {
      console.error(e);
      setErrorMsg("Failed to save: " + e);
    }
  }, []);

  const handleCopy = useCallback(async () => {
    if (!canvasRef.current) return;
    try {
      const blobPromise = new Promise<Blob>((resolve, reject) => {
        canvasRef.current!.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Blob generation failed"));
        }, 'image/png');
      });
      
      // Safari requires clipboard.write to be called immediately in the event chain
      // passing the promise directly, without awaiting it first.
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blobPromise })
      ]);
      
      const settings = await loadSettings();
      if (settings.saveOnCopy) {
        await handleSave();
      } else {
        await getCurrentWindow().hide();
      }
    } catch (e) {
      setErrorMsg("Failed to copy: " + e);
    }
  }, [handleSave]);

  const handleUndo = useCallback(() => {
    if (annotations.length === 0) return;
    const last = annotations[annotations.length - 1];
    setAnnotations(annotations.slice(0, -1));
    setRedoStack([...redoStack, last]);
  }, [annotations, redoStack]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack(redoStack.slice(0, -1));
    setAnnotations([...annotations, next]);
  }, [annotations, redoStack]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Input elements should not trigger tool shortcuts
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        setCurrentTool(prev => {
          if (prev) return null;
          getCurrentWindow().hide();
          return null;
        });
      } else if (e.key === '1') {
        setCurrentTool("rect");
      } else if (e.key === '2') {
        setCurrentTool("circle");
      } else if (e.key === '3') {
        setCurrentTool("arrow");
      } else if (e.key === '4') {
        setCurrentTool("freehand");
      } else if (e.key === '5') {
        setCurrentTool("blur");
      } else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) {
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if (e.key === 'y' && (e.metaKey || e.ctrlKey)) {
        handleRedo();
      } else if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'c' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleCopy();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave, handleCopy, handleUndo, handleRedo]);

  return (
    <main className="w-screen h-screen bg-navy-900 overflow-hidden relative">
      {errorMsg && <div className="absolute top-0 left-0 w-full p-4 bg-red-600 text-white z-50 overflow-auto max-h-full font-mono text-sm">{errorMsg}</div>}
      
      {baseImage ? (
        <>
          <header className="absolute top-0 left-0 right-0 h-16 px-6 flex items-center justify-between border-b border-navy-700 bg-navy-800 shadow-sm z-10">
            <div className="flex gap-2">
              {(["rect", "circle", "arrow", "freehand", "blur"] as Tool[]).map((t, idx) => (
                <button 
                  key={t}
                  onClick={() => setCurrentTool(t)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors duration-200 relative group ${currentTool === t ? 'bg-indigo-600 text-white shadow-sm' : 'hover:bg-navy-600 text-indigo-200 hover:text-white'}`}
                  title={`Shortcut: ${idx + 1}`}
                >
                  {t ? t.charAt(0).toUpperCase() + t.slice(1) : ''}
                  <span className="absolute -top-1 -right-1 bg-navy-900 text-navy-400 text-[10px] w-4 h-4 rounded-full flex items-center justify-center border border-navy-700 opacity-0 group-hover:opacity-100 transition-opacity">
                    {idx + 1}
                  </span>
                </button>
              ))}
            </div>
            
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 mr-4">
                <span className="text-navy-300 text-xs font-medium">Size:</span>
                <input 
                  type="range" 
                  min="2" max="30" 
                  value={lineWidth}
                  onChange={e => setLineWidth(Number(e.target.value))}
                  className="w-24 accent-indigo-500"
                />
              </div>
              
              <span className="text-navy-300 text-xs font-medium">Color:</span>
              <input 
                type="color" 
                value={currentColor}
                onChange={e => setCurrentColor(e.target.value)}
                className="w-8 h-8 rounded-full cursor-pointer bg-transparent border-0 outline-none hover:scale-105 transition-transform"
              />
            </div>
            
            <div className="flex gap-2 items-center">
              <button onClick={handleUndo} disabled={annotations.length === 0} className="px-3 py-1.5 text-sm font-medium rounded-md bg-navy-700 hover:bg-navy-600 disabled:opacity-30 disabled:cursor-not-allowed text-white transition-colors">
                Undo
              </button>
              <button onClick={handleRedo} disabled={redoStack.length === 0} className="px-3 py-1.5 text-sm font-medium rounded-md bg-navy-700 hover:bg-navy-600 disabled:opacity-30 disabled:cursor-not-allowed text-white transition-colors">
                Redo
              </button>
              <div className="w-px h-6 bg-navy-600 mx-1"></div>
              <button onClick={handleCopy} className="px-4 py-1.5 text-sm font-medium rounded-md bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">
                Copy
              </button>
              <button onClick={handleSave} className="px-4 py-1.5 text-sm font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 text-white transition-colors">
                Save
              </button>
            </div>
          </header>

          {/* Canvas Wrapper */}
          <div className="absolute top-16 bottom-0 left-0 right-0 bg-navy-900 p-6">
            <div className="relative w-full h-full">
              <canvas 
                ref={canvasRef} 
                width={canvasSize?.width}
                height={canvasSize?.height}
                onMouseDown={currentTool ? onMouseDown : undefined} 
                onMouseMove={currentTool ? onMouseMove : undefined} 
                onMouseUp={currentTool ? onMouseUp : undefined} 
                onMouseLeave={currentTool ? onMouseUp : undefined} 
                className={`shadow-2xl rounded-sm ${currentTool === "freehand" ? "cursor-default" : (currentTool ? "cursor-crosshair" : "cursor-default")}`} 
                style={{ 
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  maxWidth: '100%', 
                  maxHeight: '100%',
                  width: 'auto',
                  height: 'auto',
                  display: 'block'
                }}
              />
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-8">
           <header className="mb-8 text-center">
             <h1 className="text-4xl font-extrabold text-white mb-2 tracking-tight drop-shadow-lg opacity-80">Specture</h1>
             <p className="text-indigo-400 text-sm font-medium opacity-60">Ready in Background</p>
           </header>
        </div>
      )}
    </main>
  );
}

// ----------------------------------------------------
// Main App Component
// ----------------------------------------------------
function MainApp() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const wLabel = getCurrentWindow().label;
    setLabel(wLabel);

    if (wLabel === "main") {
      const checkAndRequestPermissions = async () => {
        try {
          const type = await typeOs();
          if (type === 'macos') {
            const hasAccess = await checkAccessibilityPermission();
            if (!hasAccess) {
              await requestAccessibilityPermission();
            }
            
            const hasScreen = await checkScreenRecordingPermission();
            if (!hasScreen) {
              await requestScreenRecordingPermission();
            }
          }
        } catch (e) {
          console.error("Permission check failed", e);
        }
      };

      const setupShortcuts = async () => {
        await checkAndRequestPermissions();

        try {
          const settings = await loadSettings();
          
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('set_debug_logs_enabled', { enabled: settings.enableDebugLogs }).catch(console.warn);
          });
          
          const normalizeShortcut = (sc: string | null) => {
            if (!sc) return null;
            
            const parts = sc.split("+");
            let norm = "";
            
            let hasShift = false;
            let hasCtrl = false;
            let hasAlt = false;
            let hasSuper = false;
            
            for (let i = 0; i < parts.length - 1; i++) {
                const upper = parts[i].toUpperCase().trim();
                if (upper === "SHIFT") hasShift = true;
                else if (upper === "CTRL" || upper === "CONTROL") hasCtrl = true;
                else if (upper === "ALT" || upper === "OPTION") hasAlt = true;
                else if (upper === "CMD" || upper === "COMMAND" || upper === "SUPER") hasSuper = true;
                else if (upper === "COMMANDORCONTROL" || upper === "CMDORCTRL") {
                    if (typeOs() === "macos") hasSuper = true;
                    else hasCtrl = true;
                }
            }
            
            if (hasShift) norm += "shift+";
            if (hasCtrl) norm += "control+";
            if (hasAlt) norm += "alt+";
            if (hasSuper) norm += "super+";
            
            let key = parts[parts.length - 1].trim();
            // Format keys the way global-hotkey's `keyboard-types` Code does
            if (key.length === 1 && /[A-Za-z]/.test(key)) {
                key = `Key${key.toUpperCase()}`;
            } else if (key.length === 1 && /[0-9]/.test(key)) {
                key = `Digit${key}`;
            } else if (key === "`") {
                key = "Backquote";
            } else if (key === "\\") {
                key = "Backslash";
            } else if (key === "[") {
                key = "BracketLeft";
            } else if (key === "]") {
                key = "BracketRight";
            } else if (key === ",") {
                key = "Comma";
            } else if (key === ".") {
                key = "Period";
            } else if (key === "/") {
                key = "Slash";
            } else if (key === "-") {
                key = "Minus";
            } else if (key === "=") {
                key = "Equal";
            } else if (key === ";") {
                key = "Semicolon";
            } else if (key === "'") {
                key = "Quote";
            } else if (key === " ") {
                key = "Space";
            } else {
                key = key.charAt(0).toUpperCase() + key.slice(1);
            }
            norm += key;
            return norm;
          };

          const handleShortcut = async (firedShortcut: string) => {
            let mode = null;
            const normFired = normalizeShortcut(firedShortcut);
            if (normFired === normalizeShortcut(settings.shortcutControlPanel)) mode = "control";
            else if (normFired === normalizeShortcut(settings.shortcutFullScreen)) mode = "fullscreen";
            else if (normFired === normalizeShortcut(settings.shortcutRegion)) mode = "region";
            else if (normFired === normalizeShortcut(settings.shortcutWindow)) mode = "window";
            else if (normFired === normalizeShortcut(settings.shortcutScrolling)) mode = "scrolling";
            
            if (!mode) return;

            try {
              const { invoke } = await import('@tauri-apps/api/core');

              if (mode === "scrolling") {
                const isActive = await invoke<boolean>("is_scrolling_active");
                if (isActive) {
                  const { emit } = await import('@tauri-apps/api/event');
                  await emit("scrolling-stopped");
                  return;
                }
              }

              if (mode === "control") {
                const cp = await Window.getByLabel("control-panel");
                if (cp) {
                  const isVis = await cp.isVisible();
                  if (isVis) {
                    await cp.hide();
                  } else {
                    await cp.show();
                    await cp.setFocus();
                  }
                }
              } else {
                const cp = await Window.getByLabel("control-panel");
                if (cp) await cp.hide();

                // slight delay to let CP hide
                await new Promise(r => setTimeout(r, 200));

                await invoke("take_screenshot");

                const isScrolling = mode === "scrolling";
                if (mode === "fullscreen") {
                  await emit("load-image", { target: "main", isScrolling });
                } else if (mode === "region" || mode === "window") {
                    // Show region selector window
                    const rs = await Window.getByLabel("region-selector");
                    if (rs) {
                      await rs.show();
                      await rs.setFocus();
                      // Tell it what mode it is
                      await emit("load-image", { target: "region-selector", isScrolling, isWindowMode: mode === "window" });
                    }
                } else if (mode === "scrolling") {
                    await emit("open-control-panel-for-scrolling");
                }
              }
            } catch (actionErr) {
              console.error("Action failed", actionErr);
              await getCurrentWindow().show();
              await message(`Failed to execute shortcut action: ${actionErr}`, { title: 'Execution Error', kind: 'error' });
              await getCurrentWindow().hide();
            }
          };

          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('register_shortcuts', { 
            shortcuts: [
              settings.shortcutControlPanel, 
              settings.shortcutFullScreen, 
              settings.shortcutRegion,
              settings.shortcutWindow,
              settings.shortcutScrolling
            ]
          });

          // Bind our rock-solid Rust IPC fallback listener once
          // Using global listener because Rust app.emit is global
          const unlisten = await listen<string>("global-shortcut-triggered", async (e) => {
            const firedShortcut = e.payload;
            await handleShortcut(firedShortcut);
          });
          
          return unlisten;
        } catch (err) {
          console.error("Shortcut setup failed", err);
          return () => {};
        }
      };
      
      let currentUnlisten = () => {};
      
      const applyShortcuts = async () => {
         currentUnlisten();
         currentUnlisten = await setupShortcuts();
      };
      
      applyShortcuts();
      const unlistenSettings = listen("settings-updated", applyShortcuts);
      
      return () => {
         currentUnlisten();
         unlistenSettings.then(f => f());
      };
    }
  }, []);

  useEffect(() => {
    // A listener for ALL windows so the user can see it in the Settings devtools!
    const unlistenDebug = listen<string>("global-shortcut-triggered", (e) => {
      console.log("DEBUG: Global Rust shortcut fired seen in window:", getCurrentWindow().label, e.payload);
    });
    return () => {
      unlistenDebug.then(f => f());
    };
  }, []);

  if (!label) return null;

  if (label === "control-panel") return <ControlPanel />;
  if (label === "region-selector") return <RegionSelector />;
  if (label === "settings") return <Settings />;
  return <Editor />;
}

function StopRecording() {
  useEffect(() => {
    document.documentElement.style.backgroundColor = "transparent";
    document.body.style.backgroundColor = "transparent";
    // Also remove the tailwind classes that might enforce background
    document.documentElement.classList.remove('bg-navy-900');
    document.body.classList.remove('bg-navy-900');
    
    return () => { 
      document.documentElement.style.backgroundColor = "";
      document.body.style.backgroundColor = ""; 
      document.documentElement.classList.add('bg-navy-900');
      document.body.classList.add('bg-navy-900');
    };
  }, []);

  const handleStop = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke("log_debug", { message: "Stop button CLICKED!" });

      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await invoke("log_debug", { message: "Hiding window..." });
      await getCurrentWindow().hide().catch(() => {});
      
      const { emit } = await import('@tauri-apps/api/event');
      await invoke("log_debug", { message: "Emitting stopped event..." });
      await emit("scrolling-stopped");
    } catch (e: any) {
      console.error(e);
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke("log_debug", { message: `ERROR in Stop button: ${e.toString()}` }).catch(()=>{});
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide();
    }
  };
  
  return (
    <div data-tauri-drag-region className="h-screen w-screen flex items-center justify-center bg-transparent overflow-hidden">
      <button 
        onPointerDown={handleStop}
        title="Stop Recording"
        className="w-16 h-16 flex items-center justify-center bg-red-600 hover:bg-red-500 rounded-full shadow-[0_0_15px_rgba(220,38,38,0.7)] border-2 border-red-800 animate-pulse cursor-pointer transition-colors pointer-events-auto"
      >
        <div className="w-5 h-5 bg-white rounded-sm pointer-events-none"></div>
      </button>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setMode(params.get('mode'));
  }, []);

  if (mode === 'stop-recording') {
    return <StopRecording />;
  }

  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}

