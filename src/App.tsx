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
import i18n from "./i18n";
import React, { ErrorInfo } from 'react';
import { useTranslation } from 'react-i18next';
import { Square, Circle, ArrowRight, Pen, Droplet, Type, Undo, Redo, Monitor, Scissors, AppWindow, Highlighter, GripVertical, MousePointer2, Eraser } from 'lucide-react';
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
type Tool = "rect" | "circle" | "arrow" | "freehand" | "blur" | "text" | "highlighter" | "select" | "eraser" | null;
type Point = { x: number; y: number };

const isMac = typeOs() === 'macos';
const isP3 = window.matchMedia("(color-gamut: p3)").matches;
let targetColorSpace: "srgb" | "display-p3" = isMac && isP3 ? "display-p3" : "srgb";

async function updateTargetColorSpace() {
  const settings = await loadSettings();
  if (settings.colorSpaceMode === "srgb") targetColorSpace = "srgb";
  else if (settings.colorSpaceMode === "display-p3") targetColorSpace = "display-p3";
  else targetColorSpace = isMac && isP3 ? "display-p3" : "srgb";
}

interface Annotation {
  id: string;
  tool: Tool;
  color: string;
  lineWidth: number;
  points: Point[]; 
  rect?: { x: number; y: number; w: number; h: number }; 
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  highlighterMode?: "normal" | "multiply";
}

interface WindowInfo {
  id: number;
  pid: number;
  app_name: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

// ----------------------------------------------------
// Capture Menu Window
// ----------------------------------------------------
function CaptureMenu() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isScrollingSetup, setIsScrollingSetup] = useState(false);

  const handleCapture = async (mode: "fullscreen" | "region" | "window") => {
    setLoading(true);
    setErrorMsg(null);
    try {
      // Hide the capture menu window before capturing so it's not visible in the screenshot
      await getCurrentWindow().hide();
      await new Promise(r => setTimeout(r, 200));
      
      // takes screenshot and stores bytes in Rust memory
      await invoke("take_screenshot");
      
      let target = "main";
      
      // Wake up the target window explicitly so its JS context resumes
      const targetWindow = new Window(target);
      await targetWindow.show();
      await targetWindow.setFocus();
      
      // emit lightweight signal
      await emit("load-image", { target, isScrolling: isScrollingSetup, captureMode: mode });
      await getCurrentWindow().hide();
      setIsScrollingSetup(false);
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
    
    const unlisten = listen("open-capture-menu-for-scrolling", async () => {
      setIsScrollingSetup(true);
      await getCurrentWindow().show();
      await getCurrentWindow().setFocus();
    });
    
    // Position the window at the top center of the screen
    import('@tauri-apps/api/window').then(async ({ currentMonitor, LogicalPosition }) => {
      try {
        const monitor = await currentMonitor();
        if (monitor) {
          const factor = monitor.scaleFactor;
          // Calculate center X (in logical pixels)
          const logicalWidth = monitor.size.width / factor;
          const windowWidth = 400; 
          const x = (logicalWidth / 2) - (windowWidth / 2);
          const y = 30; // 30px from the top
          
          const win = getCurrentWindow();
          await win.setPosition(new LogicalPosition(x, y));
        }
      } catch (err) {
         console.warn("Failed to set capture menu position", err);
      }
    });
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      unlisten.then(f => f());
    };
  }, []);

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-transparent overflow-hidden">
      <div className={`flex flex-row items-center justify-center gap-6 bg-zinc-950/90 backdrop-blur-xl border rounded-full select-none h-14 w-fit px-8 shadow-[0_8px_30px_rgba(0,0,0,0.4)] relative transition-colors ${isScrollingSetup ? 'border-blue-500/50 shadow-[0_0_20px_rgba(59,130,246,0.3)]' : 'border-zinc-800/80'}`}>
        {errorMsg && (
          <div className="absolute top-12 w-[90%] bg-red-900/80 text-red-100 text-[9px] p-1 rounded text-center font-medium backdrop-blur-sm z-50 shadow-lg">
            {errorMsg}
          </div>
        )}
        
        {isScrollingSetup && (
          <div className="absolute -top-6 bg-blue-600 text-white text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shadow-md">
            {t('settings.scrolling_capture')}
          </div>
        )}
        
        <button 
          onClick={() => handleCapture("fullscreen")}
          disabled={loading}
          title={t('settings.capture_full_screen')}
          className={`flex items-center justify-center p-2 rounded-full transition-all w-10 h-10 border active:scale-90 shadow-sm ${isScrollingSetup ? 'bg-blue-900/30 border-blue-700/50 text-blue-300 hover:bg-blue-800/50' : 'bg-zinc-900/50 border-zinc-800/50 text-zinc-400 hover:bg-zinc-800 hover:text-white hover:border-zinc-700'}`}
        >
          <Monitor size={18} strokeWidth={2.5} />
        </button>
        
        <button 
          onClick={() => handleCapture("region")}
          disabled={loading}
          title={t('settings.capture_region')}
          className={`flex items-center justify-center p-2 rounded-full transition-all w-10 h-10 border active:scale-90 shadow-sm ${isScrollingSetup ? 'bg-blue-900/30 border-blue-700/50 text-blue-300 hover:bg-blue-800/50' : 'bg-zinc-900/50 border-zinc-800/50 text-zinc-400 hover:bg-zinc-800 hover:text-white hover:border-zinc-700'}`}
        >
          <Scissors size={18} strokeWidth={2.5} />
        </button>
        
        <button 
          onClick={() => handleCapture("window")}
          disabled={loading}
          title={t('settings.capture_window')}
          className={`flex items-center justify-center p-2 rounded-full transition-all w-10 h-10 border active:scale-90 shadow-sm ${isScrollingSetup ? 'bg-blue-900/30 border-blue-700/50 text-blue-300 hover:bg-blue-800/50' : 'bg-zinc-900/50 border-zinc-800/50 text-zinc-400 hover:bg-zinc-800 hover:text-white hover:border-zinc-700'}`}
        >
          <AppWindow size={18} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------
// ----------------------------------------------------

function Editor() {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [baseImage, setBaseImage] = useState<HTMLImageElement | HTMLCanvasElement | null>(null);
  
  // Toolbar drag state
  const [toolbarOffset, setToolbarOffset] = useState({ x: 0, y: 0 });
  const [isDraggingToolbar, setIsDraggingToolbar] = useState(false);
  const toolbarDragStart = useRef({ x: 0, y: 0 });
  const initialOffsetStart = useRef({ x: 0, y: 0 });
  
  // Overlay state machine
  const [overlayMode, setOverlayMode] = useState<"IDLE" | "SELECTING" | "SELECTING_WINDOW" | "EDITING">("IDLE");
  const [captureModeState, setCaptureModeState] = useState<string>("region");
  const [cropRegion, setCropRegion] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  const [startPos, setStartPos] = useState<Point | null>(null);
  const [currentPos, setCurrentPos] = useState<Point | null>(null);
  const [isResizing, setIsResizing] = useState<string | null>(null); // handle name: 'nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'
  
  // Annotation editing state
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [isResizingAnnotation, setIsResizingAnnotation] = useState<string | null>(null);
  const [isMovingAnnotation, setIsMovingAnnotation] = useState(false);
  
  // Window Capture state
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [hoveredWindow, setHoveredWindow] = useState<WindowInfo | null>(null);
  const [monitorOffset, setMonitorOffset] = useState<{ x: number, y: number }>({ x: 0, y: 0 });
  
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[][]>([]);
  const [undoStack, setUndoStack] = useState<Annotation[][]>([]);
  
  const historySnapshot = useRef<Annotation[] | null>(null);
  const hasEditedAnnotation = useRef(false);
  const [currentTool, setCurrentTool] = useState<Tool | null>(null);
  const [currentColor, setCurrentColor] = useState<string>("#ef4444"); 
  const [lineWidth, setLineWidth] = useState<number>(4);
  const [fontFamily, setFontFamily] = useState<string>("Inter");
  const [fontSize, setFontSize] = useState<number>(24);
  const [highlighterMode, setHighlighterMode] = useState<"normal" | "multiply">("normal");
  const [toolbarPosition, setToolbarPosition] = useState<"bottom" | "top">("bottom");
  const [activeText, setActiveText] = useState<{ x: number, y: number, clientX: number, clientY: number, text: string } | null>(null);
  
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentAnnotation, setCurrentAnnotation] = useState<Annotation | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState<{width: number, height: number} | null>(null);
  const [isEyedropperActive, setIsEyedropperActive] = useState(false);
  const isCancellingText = useRef(false);
  const isHoveringHeader = useRef(false);
  const colorInputRef = useRef<HTMLInputElement>(null);
  
  const moveStartPos = useRef<{ x: number, y: number } | null>(null);
  const resizeStartAnnotation = useRef<Annotation | null>(null);

  const resetEditorState = useCallback(() => {
    setAnnotations([]);
    setUndoStack([]);
    setRedoStack([]);
    setCurrentTool(null);
    setActiveText(null);
    setIsDrawing(false);
    setCurrentAnnotation(null);
    setSelectedAnnotationId(null);
    historySnapshot.current = null;
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    if (overlayMode === "IDLE") {
      win.setIgnoreCursorEvents(true).catch(console.warn);
      win.hide().catch(console.warn);
    } else {
      win.setIgnoreCursorEvents(false).catch(console.warn);
    }
  }, [overlayMode]);

  useEffect(() => {
    const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      resetEditorState();
      await getCurrentWindow().hide();
    });

    const unlisten = listen<{ dataUrl?: string, target: string, captureMode?: string }>("load-image", async (e) => {
      if (e.payload.target !== "main") return;
      await updateTargetColorSpace();
      
      const captureMode = e.payload.captureMode || "fullscreen";
      setCaptureModeState(captureMode);
      if (captureMode === "region" || captureMode === "scrolling") setOverlayMode("SELECTING");
      else if (captureMode === "window") setOverlayMode("SELECTING_WINDOW");
      else setOverlayMode("EDITING");
      
      getCurrentWindow().setFocus();
      
      const settings = await loadSettings();
      setHighlighterMode(settings.highlighterMode || "normal");
      setToolbarPosition(settings.toolbarPosition || "bottom");

      if (captureMode === "window") {
        const { invoke } = await import('@tauri-apps/api/core');
        try {
          const fetchedWindows = await invoke<WindowInfo[]>("get_windows");
          setWindows(fetchedWindows);
        } catch (err) {
          console.error("Failed to fetch windows:", err);
          setWindows([]);
        }
      } else {
        setWindows([]);
      }
      setHoveredWindow(null);

      try {
        const { currentMonitor, primaryMonitor } = await import('@tauri-apps/api/window');
        let monitor = await currentMonitor();
        if (!monitor) monitor = await primaryMonitor();
        
        if (monitor) {
          const logicalPos = monitor.position.toLogical(monitor.scaleFactor);
          setMonitorOffset({ x: logicalPos.x, y: logicalPos.y });
          await getCurrentWindow().setSize(monitor.size);
          await getCurrentWindow().setPosition(monitor.position);
        }

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
            
            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            const tempCtx = tempCanvas.getContext("2d");
            if (tempCtx) {
              tempCtx.drawImage(img, 0, 0);
              const rawData = tempCtx.getImageData(0, 0, img.width, img.height);
              try {
                const p3Data = new ImageData(rawData.data, img.width, img.height, { colorSpace: targetColorSpace });
                const offCanvas = document.createElement("canvas");
                offCanvas.width = img.width;
                offCanvas.height = img.height;
                const offCtx = offCanvas.getContext("2d", { colorSpace: targetColorSpace } as any) as CanvasRenderingContext2D | null;
                if (offCtx) offCtx.putImageData(p3Data, 0, 0);
                setBaseImage(offCanvas);
              } catch (e) {
                setBaseImage(img);
              }
            } else {
              setBaseImage(img);
            }
            
            setAnnotations([]);
            setRedoStack([]);
            setToolbarOffset({ x: 0, y: 0 });
            if (captureMode === "fullscreen") {
               setCropRegion({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
            } else {
               setCropRegion(null);
            }
            
            const { LogicalSize, PhysicalSize, PhysicalPosition } = await import('@tauri-apps/api/dpi');
            const { currentMonitor } = await import('@tauri-apps/api/window');
            const monitor = await currentMonitor();
            
            if (captureMode === "scrolling-result") {
              const factor = monitor ? monitor.scaleFactor : 1;
              const maxHeight = monitor ? (monitor.size.height / factor) * 0.85 : 800;
              const maxWidth = monitor ? (monitor.size.width / factor) * 0.85 : 1200;
              
              const imgLogicalWidth = img.width / factor;
              const imgLogicalHeight = img.height / factor;
              
              const targetWidth = Math.min(imgLogicalWidth, maxWidth);
              const targetHeight = Math.min(imgLogicalHeight, maxHeight);
              
              await getCurrentWindow().setSize(new LogicalSize(targetWidth, targetHeight));
              await getCurrentWindow().center();
              await getCurrentWindow().setAlwaysOnTop(true);
            } else {
              if (monitor) {
                await getCurrentWindow().setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
                await getCurrentWindow().setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
              }
            }
            
            await getCurrentWindow().show();
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
            
            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            const tempCtx = tempCanvas.getContext("2d");
            if (tempCtx) {
              tempCtx.drawImage(img, 0, 0);
              const rawData = tempCtx.getImageData(0, 0, img.width, img.height);
              try {
                const p3Data = new ImageData(rawData.data, img.width, img.height, { colorSpace: targetColorSpace });
                const offCanvas = document.createElement("canvas");
                offCanvas.width = img.width;
                offCanvas.height = img.height;
                const offCtx = offCanvas.getContext("2d", { colorSpace: targetColorSpace } as any) as CanvasRenderingContext2D | null;
                if (offCtx) offCtx.putImageData(p3Data, 0, 0);
                setBaseImage(offCanvas);
              } catch (e) {
                setBaseImage(img);
              }
            } else {
              setBaseImage(img);
            }

            setAnnotations([]);
            setRedoStack([]);
            setToolbarOffset({ x: 0, y: 0 });
            if (captureMode === "fullscreen") {
               setCropRegion({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
            } else {
               setCropRegion(null);
            }
            
            const { LogicalSize, PhysicalSize, PhysicalPosition } = await import('@tauri-apps/api/dpi');
            const { currentMonitor } = await import('@tauri-apps/api/window');
            const monitor = await currentMonitor();
            
            if (captureMode === "scrolling-result") {
              const factor = monitor ? monitor.scaleFactor : 1;
              const maxHeight = monitor ? (monitor.size.height / factor) * 0.85 : 800;
              const maxWidth = monitor ? (monitor.size.width / factor) * 0.85 : 1200;
              
              const imgLogicalWidth = img.width / factor;
              const imgLogicalHeight = img.height / factor;
              
              const targetWidth = Math.min(imgLogicalWidth, maxWidth);
              const targetHeight = Math.min(imgLogicalHeight, maxHeight);
              
              await getCurrentWindow().setSize(new LogicalSize(targetWidth, targetHeight));
              await getCurrentWindow().center();
              await getCurrentWindow().setAlwaysOnTop(true);
            } else {
              if (monitor) {
                await getCurrentWindow().setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
                await getCurrentWindow().setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
              }
            }
            
            await getCurrentWindow().show();
            await getCurrentWindow().show();
            await getCurrentWindow().setFocus();
            URL.revokeObjectURL(url);
          };
          img.onerror = () => {
            setErrorMsg(t('app.failed_to_load'));
            URL.revokeObjectURL(url);
          };
          img.src = url;
        }
      } catch (err: any) {
        if (String(err) !== "No image buffer found") {
          setErrorMsg(String(err));
        }
        await getCurrentWindow().hide();
        resetEditorState();
      }
    });
    
    const unlistenScrolling = listen("scrolling-stopped", async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke("stop_scrolling_capture");
        await emit("load-image", { target: "main", isScrolling: true, captureMode: "scrolling-result" });
      } catch (err) {
        console.error("Failed to stitch scrolling capture", err);
      }
    });
    
    return () => { 
      unlisten.then(f => f()); 
      unlistenScrolling.then(f => f());
      unlistenClose.then(f => f());
    };
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = (canvas.getContext("2d", { colorSpace: targetColorSpace } as any) || canvas.getContext("2d")) as CanvasRenderingContext2D | null;
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width ? canvas.width / rect.width : 1;
    const scaleY = rect.height ? canvas.height / rect.height : 1;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (baseImage) {
      ctx.drawImage(baseImage, 0, 0);
      
      ctx.save();
      ctx.scale(scaleX, scaleY);
      
      // Dimmer
      if (overlayMode === "SELECTING" || overlayMode === "SELECTING_WINDOW" || (overlayMode === "EDITING" && cropRegion)) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
        ctx.fillRect(0, 0, rect.width, rect.height);
      }
      
      // Punch hole for cropRegion or current selection
      if (overlayMode === "SELECTING" && startPos && currentPos) {
        const rx = Math.min(startPos.x, currentPos.x);
        const ry = Math.min(startPos.y, currentPos.y);
        const rw = Math.abs(currentPos.x - startPos.x);
        const rh = Math.abs(currentPos.y - startPos.y);
        
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx, ry, rw, rh);
        ctx.clip();
        ctx.drawImage(baseImage, 0, 0, rect.width, rect.height);
        ctx.restore();
        
        ctx.strokeStyle = "#818cf8";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(rx, ry, rw, rh);
      } else if (overlayMode === "SELECTING_WINDOW" && hoveredWindow) {
        const hx = hoveredWindow.x - monitorOffset.x;
        const hy = hoveredWindow.y - monitorOffset.y;
        const hw = hoveredWindow.width;
        const hh = hoveredWindow.height;
        
        ctx.save();
        ctx.beginPath();
        ctx.rect(hx, hy, hw, hh);
        ctx.clip();
        ctx.drawImage(baseImage, 0, 0, rect.width, rect.height);
        ctx.restore();
        
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        ctx.strokeRect(hx, hy, hw, hh);
        
        ctx.fillStyle = "rgba(59, 130, 246, 0.2)";
        ctx.fillRect(hx, hy, hw, hh);
      } else if (overlayMode === "EDITING" && cropRegion) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(cropRegion.x, cropRegion.y, cropRegion.w, cropRegion.h);
        ctx.clip();
        ctx.drawImage(baseImage, 0, 0, rect.width, rect.height);
        ctx.restore();
        
        // Don't draw the dashed border when editing, to keep it clean like Flameshot
      }

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
      ctx.lineCap = ann.tool === "highlighter" ? "butt" : "round";
      ctx.lineJoin = ann.tool === "highlighter" ? "miter" : "round";
      
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
          
          const sx = x * scaleX;
          const sy = y * scaleY;
          const sw = w * scaleX;
          const sh = h * scaleY;
          const temp = document.createElement("canvas");
          temp.width = canvas.width;
          temp.height = canvas.height;
          const tCtx = (temp.getContext("2d", { colorSpace: targetColorSpace } as any) || temp.getContext("2d")) as CanvasRenderingContext2D | null;
          if (tCtx && baseImage) {
            tCtx.drawImage(baseImage, sx, sy, sw, sh, 0, 0, dw, dh);
            
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
      } else if (ann.tool === "highlighter" && ann.points.length > 0) {
        ctx.save();
        ctx.globalCompositeOperation = ann.highlighterMode === "multiply" ? "multiply" : "source-over";
        ctx.globalAlpha = ann.highlighterMode === "multiply" ? 1.0 : 0.4;
        ctx.beginPath();
        ctx.moveTo(ann.points[0].x, ann.points[0].y);
        for (let i = 1; i < ann.points.length; i++) {
          ctx.lineTo(ann.points[i].x, ann.points[i].y);
        }
        ctx.stroke();
        ctx.restore();
      } else if (ann.tool === "arrow" && ann.points.length >= 2) {
         const start = ann.points[0];
         const end = ann.points[ann.points.length - 1];
         
         const headlen = Math.max(20, ann.lineWidth * 4);
         const angle = Math.atan2(end.y - start.y, end.x - start.x);
         
         // Linha principal
         const lineEndX = end.x - headlen * Math.cos(angle) * 0.8;
         const lineEndY = end.y - headlen * Math.sin(angle) * 0.8;

         ctx.lineCap = "butt";
         ctx.lineJoin = "miter";
         
         ctx.beginPath();
         ctx.moveTo(start.x, start.y);
         ctx.lineTo(lineEndX, lineEndY);
         ctx.stroke();
         
         // Cabeça da seta (triângulo preenchido)
         ctx.beginPath();
         ctx.moveTo(end.x, end.y);
         ctx.lineTo(end.x - headlen * Math.cos(angle - Math.PI / 6), end.y - headlen * Math.sin(angle - Math.PI / 6));
         ctx.lineTo(end.x - headlen * Math.cos(angle + Math.PI / 6), end.y - headlen * Math.sin(angle + Math.PI / 6));
         ctx.closePath();
         
         ctx.fillStyle = ann.color;
         ctx.fill();
      } else if (ann.tool === "text" && ann.text) {
          ctx.fillStyle = ann.color;
          ctx.font = `${ann.fontSize}px ${ann.fontFamily}`;
          ctx.textBaseline = "top";
          const lines = ann.text.split('\n');
          lines.forEach((line, i) => {
            ctx.fillText(line, ann.points[0].x, ann.points[0].y + (i * (ann.fontSize || 24) * 1.2));
          });
      }
    };

    if (cropRegion) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cropRegion.x, cropRegion.y, cropRegion.w, cropRegion.h);
      ctx.clip();
    }
    
    blurAnns.forEach(drawAnn);
    otherAnns.forEach(drawAnn);

    if (cropRegion) {
      ctx.restore();
    }
    if (baseImage) ctx.restore(); // Restore scale
  }, [baseImage, overlayMode, cropRegion, startPos, currentPos, annotations, currentAnnotation, hoveredWindow, monitorOffset]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    if (!isResizing) return;
    
    const onPointerMove = (e: PointerEvent) => {
      setCropRegion(prev => {
        if (!prev) return prev;
        let { x, y, w, h } = prev;
        
        if (isResizing.includes('w')) {
          const diff = e.clientX - x;
          x = e.clientX;
          w = w - diff;
        }
        if (isResizing.includes('e')) {
          w = e.clientX - x;
        }
        if (isResizing.includes('n')) {
          const diff = e.clientY - y;
          y = e.clientY;
          h = h - diff;
        }
        if (isResizing.includes('s')) {
          h = e.clientY - y;
        }
        
        // Prevent negative size
        if (w < 20) {
          x -= (20 - w);
          w = 20;
        }
        if (h < 20) {
          y -= (20 - h);
          h = 20;
        }
        
        return { x, y, w, h };
      });
    };
    
    const onPointerUp = () => setIsResizing(null);
    
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [isResizing]);

  useEffect(() => {
    if (currentTool !== "select") {
      setSelectedAnnotationId(null);
    }
  }, [currentTool]);

  useEffect(() => {
    if (!isMovingAnnotation || !selectedAnnotationId) return;

    const onPointerMove = (e: PointerEvent) => {
      hasEditedAnnotation.current = true;
      setAnnotations(prev => prev.map(ann => {
        if (ann.id !== selectedAnnotationId) return ann;
        if (!moveStartPos.current) return ann;
        
        const dx = e.clientX - moveStartPos.current.x;
        const dy = e.clientY - moveStartPos.current.y;
        
        let newAnn = { ...ann };
        if (newAnn.rect) {
          newAnn.rect = { ...newAnn.rect, x: newAnn.rect.x + dx, y: newAnn.rect.y + dy };
        }
        if (newAnn.points) {
          newAnn.points = newAnn.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
        }
        
        moveStartPos.current = { x: e.clientX, y: e.clientY };
        return newAnn;
      }));
    };

    const onPointerUp = () => {
      if (hasEditedAnnotation.current && historySnapshot.current) {
        const snap = historySnapshot.current;
        setUndoStack(prev => [...prev, snap]);
        setRedoStack([]);
        hasEditedAnnotation.current = false;
        historySnapshot.current = null;
      }
      setIsMovingAnnotation(false);
      moveStartPos.current = null;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [isMovingAnnotation, selectedAnnotationId]);

  useEffect(() => {
    if (!isResizingAnnotation || !selectedAnnotationId) return;
    
    const onPointerMove = (e: PointerEvent) => {
      hasEditedAnnotation.current = true;
      setAnnotations(prev => prev.map(ann => {
        if (ann.id !== selectedAnnotationId) return ann;
        if (!resizeStartAnnotation.current) return ann;
        
        let newAnn = { ...ann };
        
        if (ann.tool === "rect" || ann.tool === "circle") {
          let { x, y, w, h } = resizeStartAnnotation.current.rect!;
          
          if (isResizingAnnotation.includes('w')) {
            const diff = e.clientX - x;
            x = e.clientX;
            w = w - diff;
          }
          if (isResizingAnnotation.includes('e')) {
            w = e.clientX - x;
          }
          if (isResizingAnnotation.includes('n')) {
            const diff = e.clientY - y;
            y = e.clientY;
            h = h - diff;
          }
          if (isResizingAnnotation.includes('s')) {
            h = e.clientY - y;
          }
          
          if (e.shiftKey) {
            const size = Math.max(Math.abs(w), Math.abs(h));
            if (isResizingAnnotation.includes('w')) {
              x = (x + w) - size;
              w = size;
            } else if (isResizingAnnotation.includes('e')) {
              w = size;
            }
            if (isResizingAnnotation.includes('n')) {
              y = (y + h) - size;
              h = size;
            } else if (isResizingAnnotation.includes('s')) {
              h = size;
            }
          }
          
          // Allow negative width/height visually, but normalize by flipping coordinates.
          // Wait, the drawing logic works best with w/h >= 0.
          if (w < 0) { x += w; w = Math.abs(w); }
          if (h < 0) { y += h; h = Math.abs(h); }
          
          newAnn.rect = { x, y, w, h };
        } else if (ann.tool === "arrow") {
          // 'start' or 'end' handle
          let p1 = { ...resizeStartAnnotation.current.points[0] };
          let p2 = { ...resizeStartAnnotation.current.points[1] };
          
          let targetPoint = isResizingAnnotation === 'start' ? p1 : p2;
          let anchorPoint = isResizingAnnotation === 'start' ? p2 : p1;
          
          targetPoint.x = e.clientX;
          targetPoint.y = e.clientY;

          if (e.shiftKey) {
            const dx = targetPoint.x - anchorPoint.x;
            const dy = targetPoint.y - anchorPoint.y;
            const angle = Math.atan2(dy, dx);
            const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
            const dist = Math.hypot(dx, dy);
            targetPoint.x = anchorPoint.x + Math.cos(snappedAngle) * dist;
            targetPoint.y = anchorPoint.y + Math.sin(snappedAngle) * dist;
          }
          
          if (isResizingAnnotation === 'start') p1 = targetPoint;
          else p2 = targetPoint;
          
          newAnn.points = [p1, p2];
        }
        
        return newAnn;
      }));
    };
    
    const onPointerUp = () => {
      if (hasEditedAnnotation.current && historySnapshot.current) {
        const snap = historySnapshot.current;
        setUndoStack(prev => [...prev, snap]);
        setRedoStack([]);
        hasEditedAnnotation.current = false;
        historySnapshot.current = null;
      }
      setIsResizingAnnotation(null);
      resizeStartAnnotation.current = null;
    };
    
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [isResizingAnnotation, selectedAnnotationId]);

  useEffect(() => {
    if (!isDraggingToolbar) return;
    
    const onPointerMove = (e: PointerEvent) => {
      const dx = e.clientX - toolbarDragStart.current.x;
      const dy = e.clientY - toolbarDragStart.current.y;
      setToolbarOffset({
        x: initialOffsetStart.current.x + dx,
        y: initialOffsetStart.current.y + dy
      });
    };
    
    const onPointerUp = () => setIsDraggingToolbar(false);
    
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [isDraggingToolbar]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const handleWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
      }
    };
    
    // Use { passive: false } to allow e.preventDefault()
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, []);

  const getMousePos = useCallback((e: MouseEvent | React.MouseEvent | PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: e.clientX, y: e.clientY };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }, []);

  const getClientPos = useCallback((x: number, y: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { clientX: x, clientY: y };
    const rect = canvas.getBoundingClientRect();
    return {
      clientX: x + rect.left,
      clientY: y + rect.top
    };
  }, []);

  const getAnnotationAtPos = useCallback((x: number, y: number): Annotation | null => {
    // iterate backwards to find the top-most annotation
    for (let i = annotations.length - 1; i >= 0; i--) {
      const ann = annotations[i];
      if (ann.tool === "rect" || ann.tool === "circle" || ann.tool === "blur") {
        if (ann.rect) {
          const rx = Math.min(ann.rect.x, ann.rect.x + ann.rect.w);
          const ry = Math.min(ann.rect.y, ann.rect.y + ann.rect.h);
          const rw = Math.abs(ann.rect.w);
          const rh = Math.abs(ann.rect.h);
          if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
            return ann;
          }
        }
      } else if (ann.tool === "text") {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (ctx && ann.text && ann.points[0]) {
          ctx.font = `${ann.fontSize}px ${ann.fontFamily}`;
          const lines = ann.text.split('\n');
          let maxWidth = 0;
          let totalHeight = lines.length * (ann.fontSize || 24) * 1.2;
          for (const line of lines) {
            const metrics = ctx.measureText(line);
            if (metrics.width > maxWidth) maxWidth = metrics.width;
          }
          const tx = ann.points[0].x;
          const ty = ann.points[0].y;
          if (x >= tx && x <= tx + maxWidth && y >= ty && y <= ty + totalHeight) {
            return ann;
          }
        }
      } else if (ann.tool === "arrow") {
        if (ann.points.length >= 2) {
          const p1 = ann.points[0];
          const p2 = ann.points[1];
          const l2 = Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2);
          let dist = 0;
          if (l2 === 0) {
            dist = Math.hypot(x - p1.x, y - p1.y);
          } else {
            let t = ((x - p1.x) * (p2.x - p1.x) + (y - p1.y) * (p2.y - p1.y)) / l2;
            t = Math.max(0, Math.min(1, t));
            const projX = p1.x + t * (p2.x - p1.x);
            const projY = p1.y + t * (p2.y - p1.y);
            dist = Math.hypot(x - projX, y - projY);
          }
          if (dist <= (ann.lineWidth || 4) + 5) {
            return ann;
          }
        }
      } else if (ann.tool === "freehand" || ann.tool === "highlighter") {
        const radius = (ann.lineWidth || 4) + 10;
        for (let j = 0; j < ann.points.length; j++) {
          const pt = ann.points[j];
          if (Math.hypot(x - pt.x, y - pt.y) <= radius) {
            return ann;
          }
          if (j < ann.points.length - 1) {
            const p1 = pt;
            const p2 = ann.points[j + 1];
            const l2 = Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2);
            if (l2 > 0) {
              let t = ((x - p1.x) * (p2.x - p1.x) + (y - p1.y) * (p2.y - p1.y)) / l2;
              t = Math.max(0, Math.min(1, t));
              const projX = p1.x + t * (p2.x - p1.x);
              const projY = p1.y + t * (p2.y - p1.y);
              if (Math.hypot(x - projX, y - projY) <= radius) {
                return ann;
              }
            }
          }
        }
      }
    }
    return null;
  }, [annotations]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (!baseImage) return;
    
    // Eyedropper
    if (e.metaKey || e.ctrlKey || isEyedropperActive) {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = (canvas.getContext('2d', { colorSpace: targetColorSpace } as any) || canvas.getContext('2d')) as CanvasRenderingContext2D | null;
        const pos = getMousePos(e);
        const rect = canvas.getBoundingClientRect();
        const scaleX = rect.width ? canvas.width / rect.width : 1;
        const scaleY = rect.height ? canvas.height / rect.height : 1;
        
        if (ctx) {
          const pixel = ctx.getImageData(pos.x * scaleX, pos.y * scaleY, 1, 1).data;
          const hex = "#" + [pixel[0], pixel[1], pixel[2]].map(x => x.toString(16).padStart(2, '0')).join('');
          setCurrentColor(hex);
        }
      }
      setIsEyedropperActive(false);
      return;
    }
    
    if (overlayMode === "SELECTING_WINDOW") {
      if (hoveredWindow) {
        setCropRegion({
          x: hoveredWindow.x - monitorOffset.x,
          y: hoveredWindow.y - monitorOffset.y,
          w: hoveredWindow.width,
          h: hoveredWindow.height
        });
        setOverlayMode("EDITING");
        setHoveredWindow(null);
      }
      return;
    }
    
    if (overlayMode === "SELECTING") {
      setStartPos({ x: e.clientX, y: e.clientY });
      setCurrentPos({ x: e.clientX, y: e.clientY });
      return;
    }
    
    if (overlayMode !== "EDITING") return;
    
    if (!currentTool) return;

    const pos = getMousePos(e);

    if (currentTool === "eraser") {
      historySnapshot.current = annotations;
      const ann = getAnnotationAtPos(pos.x, pos.y);
      if (ann) {
        setAnnotations(prev => prev.filter(a => a.id !== ann.id));
        setRedoStack([]);
      }
      setIsDrawing(true);
      return;
    }

    if (currentTool === "select") {
      const ann = getAnnotationAtPos(pos.x, pos.y);
      if (ann) {
        setSelectedAnnotationId(ann.id);
        if (e.detail === 2 && ann.tool === "text") {
          historySnapshot.current = annotations;
          const { clientX, clientY } = getClientPos(ann.points[0].x, ann.points[0].y);
          setActiveText({ x: ann.points[0].x, y: ann.points[0].y, clientX, clientY, text: ann.text || "" });
          setCurrentColor(ann.color);
          setFontFamily(ann.fontFamily || "Inter");
          setFontSize(ann.fontSize || 24);
          setAnnotations(prev => prev.filter(a => a.id !== ann.id));
          setSelectedAnnotationId(null);
        }
      } else {
        setSelectedAnnotationId(null);
      }
      return;
    }
    
    if (currentTool === "text") {
      if (activeText) {
        if (historySnapshot.current) {
          const snap = historySnapshot.current;
          setUndoStack(prev => [...prev, snap]);
          setRedoStack([]);
          historySnapshot.current = null;
        }
        if (activeText.text.trim()) {
          setAnnotations(prev => [...prev, {
            id: crypto.randomUUID(), tool: "text", color: currentColor, lineWidth, points: [{ x: activeText.x, y: activeText.y }], text: activeText.text, fontSize, fontFamily
          }]);
        }
        setActiveText(null);
        setCurrentTool(null);
        return;
      }
      e.preventDefault();
      
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      setActiveText({ x: pos.x, y: pos.y, clientX: e.clientX, clientY: e.clientY, text: "" });
      return;
    }

    if (activeText) {
      if (historySnapshot.current) {
        const snap = historySnapshot.current;
        setUndoStack(prev => [...prev, snap]);
        setRedoStack([]);
        historySnapshot.current = null;
      }
      if (activeText.text.trim()) {
        setAnnotations(prev => [...prev, {
          id: crypto.randomUUID(), tool: "text", color: currentColor, lineWidth, points: [{ x: activeText.x, y: activeText.y }], text: activeText.text, fontSize, fontFamily
        }]);
      }
      setActiveText(null);
      setCurrentTool(null);
      return;
    }
    
    historySnapshot.current = annotations;
    setIsDrawing(true);
    setCurrentAnnotation({ id: crypto.randomUUID(), tool: currentTool!, color: currentColor, lineWidth, points: [pos], rect: { x: pos.x, y: pos.y, w: 0, h: 0 }, highlighterMode });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (overlayMode === "SELECTING_WINDOW") {
      const pos = getMousePos(e);
      const globalX = pos.x + monitorOffset.x;
      const globalY = pos.y + monitorOffset.y;

      const targetWindow = windows.find(w => 
        globalX >= w.x && globalX <= w.x + w.width &&
        globalY >= w.y && globalY <= w.y + w.height
      );
      
      setHoveredWindow(targetWindow || null);
      return;
    }

    if (overlayMode === "SELECTING" && startPos) {
      setCurrentPos({ x: e.clientX, y: e.clientY });
      return;
    }

    if (!isDrawing || !currentAnnotation) {
      if (isDrawing && currentTool === "eraser") {
        const pos = getMousePos(e);
        const ann = getAnnotationAtPos(pos.x, pos.y);
        if (ann) {
          setAnnotations(prev => prev.filter(a => a.id !== ann.id));
        }
      }
      return;
    }
    const pos = getMousePos(e);

    setCurrentAnnotation(prev => {
      if (!prev) return prev;
      if (prev.tool === "freehand") {
        return { ...prev, points: [...prev.points, pos] };
      }
      if (prev.tool === "highlighter") {
        if (!e.shiftKey) {
          return { ...prev, points: [...prev.points, pos] };
        } else {
          const startPos = prev.points[0];
          const diffX = pos.x - startPos.x;
          const diffY = pos.y - startPos.y;
          const isHorizontal = Math.abs(diffX) > Math.abs(diffY);
          
          const constrainedPos = isHorizontal 
            ? { x: pos.x, y: startPos.y } 
            : { x: startPos.x, y: pos.y };
            
          return { ...prev, points: [startPos, constrainedPos] };
        }
      }
      if (prev.tool === "rect" || prev.tool === "blur" || prev.tool === "circle") {
        const startPos = prev.points[0];
        let diffX = pos.x - startPos.x;
        let diffY = pos.y - startPos.y;

        if (e.shiftKey) {
          const size = Math.max(Math.abs(diffX), Math.abs(diffY));
          diffX = diffX < 0 ? -size : size;
          diffY = diffY < 0 ? -size : size;
        }

        return {
          ...prev,
          rect: {
            x: diffX < 0 ? startPos.x + diffX : startPos.x,
            y: diffY < 0 ? startPos.y + diffY : startPos.y,
            w: Math.abs(diffX),
            h: Math.abs(diffY)
          }
        };
      }
      if (prev.tool === "arrow") {
        let finalPos = { ...pos };
        if (e.shiftKey) {
          const startPos = prev.points[0];
          const dx = pos.x - startPos.x;
          const dy = pos.y - startPos.y;
          const angle = Math.atan2(dy, dx);
          // Snap angle to nearest 45 degrees (PI/4)
          const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
          const dist = Math.hypot(dx, dy);
          finalPos = {
            x: startPos.x + Math.cos(snappedAngle) * dist,
            y: startPos.y + Math.sin(snappedAngle) * dist
          };
        }
        return { ...prev, points: [prev.points[0], finalPos] };
      }
      return prev;
    });
  };

  const onMouseUp = async () => {
    if (overlayMode === "SELECTING" && startPos && currentPos) {
      const rx = Math.min(startPos.x, currentPos.x);
      const ry = Math.min(startPos.y, currentPos.y);
      const rw = Math.abs(currentPos.x - startPos.x);
      const rh = Math.abs(currentPos.y - startPos.y);
      if (rw > 10 && rh > 10) {
        if (captureModeState === "scrolling") {
          setStartPos(null);
          setCurrentPos(null);
          await getCurrentWindow().hide();
          
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const { currentMonitor } = await import('@tauri-apps/api/window');
            const monitor = await currentMonitor();
            const factor = monitor ? monitor.scaleFactor : 1;
            
            const settings = await loadSettings();
            await invoke("start_scrolling_capture", {
              x: Math.round(rx * factor),
              y: Math.round(ry * factor),
              w: Math.round(rw * factor),
              h: Math.round(rh * factor),
              maxDurationSeconds: settings.maxRecordingDuration || 30
            });
          } catch (err) {
            console.error("Failed to start scrolling capture", err);
            await getCurrentWindow().show();
            await getCurrentWindow().setFocus();
          }
        } else {
          setCropRegion({ x: rx, y: ry, w: rw, h: rh });
          setOverlayMode("EDITING");
          setStartPos(null);
          setCurrentPos(null);
        }
      }
      return;
    }

    if (isDrawing && currentAnnotation) {
      if (historySnapshot.current) {
        const snap = historySnapshot.current;
        setUndoStack(prev => [...prev, snap]);
        setRedoStack([]);
        historySnapshot.current = null;
      }
      setAnnotations(prev => [...prev, currentAnnotation]);
    }
    
    if (currentTool === "eraser" && historySnapshot.current) {
      if (historySnapshot.current !== annotations) {
        const snap = historySnapshot.current;
        setUndoStack(prev => [...prev, snap]);
        setRedoStack([]);
      }
      historySnapshot.current = null;
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

      const canvas = canvasRef.current;
      
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width ? canvas.width / rect.width : 1;
      const scaleY = rect.height ? canvas.height / rect.height : 1;
      
      let sourceCanvas = canvas;
      
      if (cropRegion || (activeText && activeText.text.trim())) {
        const offCanvas = document.createElement("canvas");
        const pw = cropRegion ? cropRegion.w * scaleX : canvas.width;
        const ph = cropRegion ? cropRegion.h * scaleY : canvas.height;
        const px = cropRegion ? cropRegion.x * scaleX : 0;
        const py = cropRegion ? cropRegion.y * scaleY : 0;
        
        offCanvas.width = pw;
        offCanvas.height = ph;
        const offCtx = offCanvas.getContext("2d");
        if (offCtx) {
          offCtx.drawImage(canvas, px, py, pw, ph, 0, 0, pw, ph);
          
          if (activeText && activeText.text.trim()) {
            offCtx.scale(scaleX, scaleY);
            offCtx.fillStyle = currentColor;
            offCtx.font = `${fontSize}px ${fontFamily}`;
            offCtx.textBaseline = "top";
            const lines = activeText.text.split('\n');
            lines.forEach((line, i) => {
              const lx = activeText.x - (cropRegion ? cropRegion.x : 0);
              const ly = activeText.y - (cropRegion ? cropRegion.y : 0) + (i * fontSize * 1.2);
              offCtx.fillText(line, lx, ly);
            });
            offCtx.setTransform(1, 0, 0, 1, 0, 0);
          }
          
          sourceCanvas = offCanvas;
        }
      }
      
      const blob = await new Promise<Blob>((resolve, reject) => {
        sourceCanvas.toBlob((b) => {
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
      
      resetEditorState();
      await getCurrentWindow().hide();
    } catch (e) {
      console.error(e);
      setErrorMsg("Failed to save: " + e);
    }
  }, [cropRegion]);

  const handleCopy = useCallback(async () => {
    if (!canvasRef.current) return;
    try {
      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width ? canvas.width / rect.width : 1;
      const scaleY = rect.height ? canvas.height / rect.height : 1;
      
      let sourceCanvas = canvas;
      
      if (cropRegion || (activeText && activeText.text.trim())) {
        const offCanvas = document.createElement("canvas");
        const pw = cropRegion ? cropRegion.w * scaleX : canvas.width;
        const ph = cropRegion ? cropRegion.h * scaleY : canvas.height;
        const px = cropRegion ? cropRegion.x * scaleX : 0;
        const py = cropRegion ? cropRegion.y * scaleY : 0;
        
        offCanvas.width = pw;
        offCanvas.height = ph;
        const offCtx = offCanvas.getContext("2d");
        if (offCtx) {
          offCtx.drawImage(canvas, px, py, pw, ph, 0, 0, pw, ph);
          
          if (activeText && activeText.text.trim()) {
            offCtx.scale(scaleX, scaleY);
            offCtx.fillStyle = currentColor;
            offCtx.font = `${fontSize}px ${fontFamily}`;
            offCtx.textBaseline = "top";
            const lines = activeText.text.split('\n');
            lines.forEach((line, i) => {
              const lx = activeText.x - (cropRegion ? cropRegion.x : 0);
              const ly = activeText.y - (cropRegion ? cropRegion.y : 0) + (i * fontSize * 1.2);
              offCtx.fillText(line, lx, ly);
            });
            offCtx.setTransform(1, 0, 0, 1, 0, 0);
          }
          
          sourceCanvas = offCanvas;
        }
      }

      const blobPromise = new Promise<Blob>((resolve, reject) => {
        sourceCanvas.toBlob((blob) => {
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
        resetEditorState();
        await getCurrentWindow().hide();
      }
    } catch (e) {
      setErrorMsg("Failed to copy: " + e);
    }
  }, [handleSave, cropRegion]);

  const handleUndo = useCallback(() => {
    if (isDrawing) {
      setIsDrawing(false);
      setCurrentAnnotation(null);
      return;
    }
    setUndoStack(currentUndo => {
      if (currentUndo.length === 0) return currentUndo;
      const previous = currentUndo[currentUndo.length - 1];
      
      setAnnotations(currentAnns => {
        setRedoStack(currentRedo => [...currentRedo, currentAnns || []]);
        return previous || [];
      });
      
      return currentUndo.slice(0, -1);
    });
  }, [isDrawing]);

  const handleRedo = useCallback(() => {
    if (isDrawing) return;
    setRedoStack(currentRedo => {
      if (currentRedo.length === 0) return currentRedo;
      const next = currentRedo[currentRedo.length - 1];
      
      setAnnotations(currentAnns => {
        setUndoStack(currentUndo => [...currentUndo, currentAnns || []]);
        return next || [];
      });
      
      return currentRedo.slice(0, -1);
    });
  }, [isDrawing]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isTyping = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const isBracketLeft = e.key === '[' || e.code === 'BracketLeft';
      const isBracketRight = e.key === ']' || e.code === 'BracketRight';

      // Handle [ and ] keys for thickness/font size
      if (isBracketLeft || isBracketRight) {
        // If typing, require Cmd/Ctrl so we don't interfere with normal text input
        if (isTyping && !e.metaKey && !e.ctrlKey) {
          // Do nothing, let the character be typed
        } else {
          e.preventDefault();
          const delta = isBracketLeft ? -1 : 1;
          
          if (currentTool === "text") {
            setFontSize(prev => {
              // Map to standard font sizes if possible, or just step by 2
              const steps = [8, 10, 12, 14, 16, 20, 24, 32, 48, 54, 72, 100];
              const currentIndex = steps.findIndex(s => s >= prev);
              
              if (delta > 0) {
                // Increase
                if (currentIndex === -1 || currentIndex === steps.length - 1) return prev;
                return steps[currentIndex + 1];
              } else {
                // Decrease
                if (currentIndex <= 0) return steps[0];
                return steps[currentIndex - 1];
              }
            });
          } else {
            setLineWidth(prev => Math.max(2, Math.min(30, prev + delta)));
          }
          return;
        }
      }

      // Input elements should not trigger tool shortcuts
      if (isTyping) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        if (activeText) {
          isCancellingText.current = true;
          setActiveText(null);
          return;
        }
        if (isDrawing) {
          setIsDrawing(false);
          setCurrentAnnotation(null);
          return;
        }
        setCurrentTool(prev => {
          if (prev) return null;
          resetEditorState();
          getCurrentWindow().hide();
          return null;
        });
      } else if (e.key === '1') {
        setCurrentTool("select");
      } else if (e.key === '2') {
        setCurrentTool("rect");
      } else if (e.key === '3') {
        setCurrentTool("circle");
      } else if (e.key === '4') {
        setCurrentTool("arrow");
      } else if (e.key === '5') {
        setCurrentTool("freehand");
      } else if (e.key === '6') {
        setCurrentTool("blur");
      } else if (e.key === '7') {
        setCurrentTool("text");
      } else if (e.key === '8') {
        setCurrentTool("highlighter");
      } else if (e.key === '9') {
        setCurrentTool("eraser");
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
  }, [handleSave, handleCopy, handleUndo, handleRedo, isDrawing, activeText]);

  return (
    <main className="w-screen h-screen bg-transparent overflow-hidden relative selection:bg-blue-500/30">
      {errorMsg && <div className="absolute top-0 left-0 w-full p-2 bg-red-900 text-red-100 border-b border-red-800 z-50 overflow-auto max-h-full font-mono text-[11px] text-center">{errorMsg}</div>}
      
      {baseImage ? (
        <>
          {overlayMode === "EDITING" && (
            <header 
              onMouseEnter={() => isHoveringHeader.current = true}
              onMouseLeave={() => isHoveringHeader.current = false}
              className="absolute h-12 px-4 flex items-center justify-between border border-zinc-800/80 bg-zinc-900/90 backdrop-blur-md shadow-lg z-20 rounded-lg pointer-events-auto"
              style={{
                top: captureModeState === "scrolling-result" ? undefined : ((
                  cropRegion 
                    ? (toolbarPosition === "top"
                        ? (cropRegion.y >= 60 ? cropRegion.y - 60 : Math.min(window.innerHeight - 60, cropRegion.y + 10))
                        : (cropRegion.y + cropRegion.h + 60 <= window.innerHeight 
                            ? cropRegion.y + cropRegion.h + 10 
                            : Math.max(10, cropRegion.y + cropRegion.h - 60)))
                    : (toolbarPosition === "top" ? 10 : window.innerHeight - 60)
                ) + toolbarOffset.y),
                bottom: captureModeState === "scrolling-result" ? (toolbarPosition === "top" ? undefined : `calc(24px - ${toolbarOffset.y}px)`) : undefined,
                left: captureModeState === "scrolling-result" ? `calc(50% + ${toolbarOffset.x}px)` : (cropRegion ? cropRegion.x + cropRegion.w / 2 : window.innerWidth / 2) + toolbarOffset.x,
                transform: 'translateX(-50%)'
              }}
            >
            <div className="flex gap-1">
              <div 
                className="cursor-move p-1 text-zinc-500 hover:text-zinc-300 mr-2 flex items-center"
                onPointerDown={(e) => {
                  toolbarDragStart.current = { x: e.clientX, y: e.clientY };
                  initialOffsetStart.current = { x: toolbarOffset.x, y: toolbarOffset.y };
                  setIsDraggingToolbar(true);
                  e.stopPropagation();
                }}
              >
                <GripVertical size={16} />
              </div>
              {[
                { id: "select", icon: <MousePointer2 size={16} /> },
                { id: "rect", icon: <Square size={16} /> },
                { id: "circle", icon: <Circle size={16} /> },
                { id: "arrow", icon: <ArrowRight size={16} /> },
                { id: "freehand", icon: <Pen size={16} /> },
                { id: "blur", icon: <Droplet size={16} /> },
                { id: "text", icon: <Type size={16} /> },
                { id: "highlighter", icon: <Highlighter size={16} /> },
                { id: "eraser", icon: <Eraser size={16} /> }
              ].map((toolObj, idx) => (
                <button 
                  key={toolObj.id}
                  onMouseDown={() => {
                    if (activeText && toolObj.id !== "text") {
                      if (activeText.text.trim()) {
                        setAnnotations(prev => [...prev, {
                          id: crypto.randomUUID(), tool: "text", color: currentColor, lineWidth, points: [{ x: activeText.x, y: activeText.y }], text: activeText.text, fontSize, fontFamily
                        }]);
                        setRedoStack([]);
                      }
                      setActiveText(null);
                    }
                  }}
                  onClick={() => setCurrentTool(toolObj.id as Tool)}
                  className={`p-1.5 rounded-md transition-all duration-200 relative group flex items-center justify-center ${currentTool === toolObj.id ? 'bg-blue-500/20 text-blue-400 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)]' : 'hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
                >
                  {toolObj.icon}
                  
                  <span className="absolute -top-1 -right-1 bg-zinc-900 text-zinc-400 text-[9px] w-3.5 h-3.5 rounded-full flex items-center justify-center border border-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    {idx + 1}
                  </span>
                  
                  <div className="absolute top-full mt-1.5 bg-zinc-800 text-zinc-200 text-[10px] font-medium px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none shadow-lg z-30 border border-zinc-700 flex items-center justify-center left-1/2 -translate-x-1/2">
                    {t(`app.${toolObj.id}`) !== `app.${toolObj.id}` ? t(`app.${toolObj.id}`) : toolObj.id.charAt(0).toUpperCase() + toolObj.id.slice(1)}
                  </div>
                </button>
              ))}
            </div>
            
            <div className="flex items-center gap-3">
              {currentTool === "text" ? (
                <div className="flex items-center ml-4 border-l border-zinc-700/50 pl-4 space-x-3">
                  <select
                    value={fontFamily}
                    onChange={(e) => setFontFamily(e.target.value)}
                    className="bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-500/50 transition-colors"
                  >
                    <option value="Inter">Inter</option>
                    <option value="Arial">Arial</option>
                    <option value="Courier New">Courier New</option>
                    <option value="Times New Roman">Times New Roman</option>
                    <option value="Comic Sans MS">Comic Sans MS</option>
                  </select>
                  
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-500 text-[11px] font-medium">{t('app.font_size')}:</span>
                    <input 
                      type="range" 
                      min="8" max="100" 
                      value={fontSize}
                      onChange={e => setFontSize(Number(e.target.value))}
                      className="w-20 accent-blue-500"
                    />
                    <span className="text-zinc-400 text-[11px] w-6 text-center">{fontSize}</span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 ml-4 border-l border-zinc-700/50 pl-4">
                  {currentTool === "highlighter" && (
                    <select
                      value={highlighterMode}
                      onChange={async (e) => {
                        const val = e.target.value as "normal" | "multiply";
                        setHighlighterMode(val);
                        const { saveSettings } = await import('./store');
                        const settings = await loadSettings();
                        settings.highlighterMode = val;
                        await saveSettings(settings);
                      }}
                      className="bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-500/50 transition-colors mr-2"
                    >
                      <option value="normal">{t('settings.highlighter_normal', 'Normal')}</option>
                      <option value="multiply">{t('settings.highlighter_multiply', 'Multiply')}</option>
                    </select>
                  )}
                  <span className="text-zinc-500 text-[11px] font-medium">{t('app.thickness')}:</span>
                  <input 
                    type="range" 
                    min="2" max="30" 
                    value={lineWidth}
                    onChange={e => setLineWidth(Number(e.target.value))}
                    className="w-20 accent-blue-500"
                  />
                  <span className="text-zinc-400 text-[11px] w-4 text-center">{lineWidth}</span>
                </div>
              )}
              
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-500 text-[11px] font-medium">{t('app.color')}:</span>
                <button 
                  onClick={() => setIsEyedropperActive(!isEyedropperActive)}
                  className={`p-1.5 rounded-md transition-colors duration-200 relative group flex items-center justify-center ${isEyedropperActive ? 'bg-blue-500/20 text-blue-400 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)]' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>
                  <div className="absolute top-full mt-1.5 bg-zinc-800 text-zinc-200 text-[10px] font-medium px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none shadow-lg z-30 border border-zinc-700 flex items-center justify-center left-1/2 -translate-x-1/2">
                    Eyedropper (Cmd+Click)
                  </div>
                </button>
                <input 
                  ref={colorInputRef}
                  type="color" 
                  value={currentColor}
                  onChange={e => setCurrentColor(e.target.value)}
                  className="w-6 h-6 rounded-full cursor-pointer bg-transparent border-0 outline-none hover:scale-110 transition-transform"
                />
              </div>
            </div>
            
            <div className="w-px h-6 bg-zinc-700/50 mx-4" />
            
            <div className="flex gap-1.5 items-center">
              <button onClick={handleUndo} disabled={undoStack.length === 0 && !isDrawing} className="p-1.5 text-xs font-medium rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 transition-colors relative group flex items-center justify-center">
                <Undo size={14} />
                <div className="absolute top-full mt-1.5 bg-zinc-800 text-zinc-200 text-[10px] font-medium px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none shadow-lg border border-zinc-700 z-30 flex items-center justify-center left-1/2 -translate-x-1/2">
                  Undo (Cmd+Z)
                </div>
              </button>
              <button onClick={handleRedo} disabled={redoStack.length === 0} className="p-1.5 text-xs font-medium rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 transition-colors relative group flex items-center justify-center">
                <Redo size={14} />
                <div className="absolute top-full mt-1.5 bg-zinc-800 text-zinc-200 text-[10px] font-medium px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none shadow-lg border border-zinc-700 z-30 flex items-center justify-center left-1/2 -translate-x-1/2">
                  Redo (Cmd+Y)
                </div>
              </button>
              <div className="w-px h-4 bg-zinc-800 mx-1"></div>
              <button onClick={handleCopy} className="px-3 py-1 text-[11px] font-medium rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700/50 transition-colors">
                Copy
              </button>
              <button onClick={handleSave} className="px-3 py-1 text-[11px] font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition-colors">
                Save
              </button>
            </div>
          </header>
          )}

          {/* Canvas Wrapper */}
          <div className={`absolute inset-0 w-full h-full cursor-crosshair ${captureModeState === "scrolling-result" ? "overflow-y-auto overflow-x-auto flex justify-center items-start bg-transparent" : ""}`}>
            <div className={`relative ${captureModeState === "scrolling-result" ? "shadow-2xl rounded-lg overflow-hidden bg-white w-full" : "w-full h-full"}`}>
              <canvas 
                ref={canvasRef} 
                width={canvasSize?.width}
                height={canvasSize?.height}
                onMouseDown={onMouseDown} 
                onMouseMove={onMouseMove} 
                onMouseUp={onMouseUp} 
                onMouseLeave={onMouseUp} 
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (colorInputRef.current) {
                    if (typeof (colorInputRef.current as any).showPicker === 'function') {
                      (colorInputRef.current as any).showPicker();
                    } else {
                      colorInputRef.current.click();
                    }
                  }
                }}
                className={`block ${captureModeState === "scrolling-result" ? "" : "w-full h-full"}`}
                style={
                  captureModeState === "scrolling-result"
                    ? { width: "100%", height: "auto" }
                    : undefined
                }
              />
              
              {overlayMode === "EDITING" && cropRegion && captureModeState === "region" && (
                <>
                  <div className="absolute w-3 h-3 bg-white border border-blue-500 cursor-nwse-resize z-30" style={{ left: cropRegion.x - 6, top: cropRegion.y - 6 }} onPointerDown={(e) => { e.stopPropagation(); setIsResizing('nw'); }} onMouseDown={e => e.preventDefault()} />
                  <div className="absolute w-3 h-3 bg-white border border-blue-500 cursor-nesw-resize z-30" style={{ left: cropRegion.x + cropRegion.w - 6, top: cropRegion.y - 6 }} onPointerDown={(e) => { e.stopPropagation(); setIsResizing('ne'); }} onMouseDown={e => e.preventDefault()} />
                  <div className="absolute w-3 h-3 bg-white border border-blue-500 cursor-nesw-resize z-30" style={{ left: cropRegion.x - 6, top: cropRegion.y + cropRegion.h - 6 }} onPointerDown={(e) => { e.stopPropagation(); setIsResizing('sw'); }} onMouseDown={e => e.preventDefault()} />
                  <div className="absolute w-3 h-3 bg-white border border-blue-500 cursor-nwse-resize z-30" style={{ left: cropRegion.x + cropRegion.w - 6, top: cropRegion.y + cropRegion.h - 6 }} onPointerDown={(e) => { e.stopPropagation(); setIsResizing('se'); }} onMouseDown={e => e.preventDefault()} />
                  
                  <div className="absolute h-3 bg-white border border-blue-500 cursor-ns-resize z-30" style={{ left: cropRegion.x + cropRegion.w / 2 - 6, top: cropRegion.y - 6, width: 12 }} onPointerDown={(e) => { e.stopPropagation(); setIsResizing('n'); }} onMouseDown={e => e.preventDefault()} />
                  <div className="absolute h-3 bg-white border border-blue-500 cursor-ns-resize z-30" style={{ left: cropRegion.x + cropRegion.w / 2 - 6, top: cropRegion.y + cropRegion.h - 6, width: 12 }} onPointerDown={(e) => { e.stopPropagation(); setIsResizing('s'); }} onMouseDown={e => e.preventDefault()} />
                  <div className="absolute w-3 bg-white border border-blue-500 cursor-ew-resize z-30" style={{ left: cropRegion.x - 6, top: cropRegion.y + cropRegion.h / 2 - 6, height: 12 }} onPointerDown={(e) => { e.stopPropagation(); setIsResizing('w'); }} onMouseDown={e => e.preventDefault()} />
                  <div className="absolute w-3 bg-white border border-blue-500 cursor-ew-resize z-30" style={{ left: cropRegion.x + cropRegion.w - 6, top: cropRegion.y + cropRegion.h / 2 - 6, height: 12 }} onPointerDown={(e) => { e.stopPropagation(); setIsResizing('e'); }} onMouseDown={e => e.preventDefault()} />
                </>
              )}

              {selectedAnnotationId && (() => {
                const ann = annotations.find(a => a.id === selectedAnnotationId);
                if (!ann) return null;
                
                let rx = 0, ry = 0, rw = 0, rh = 0;
                if (ann.tool === "rect" || ann.tool === "circle") {
                  if (!ann.rect) return null;
                  rx = Math.min(ann.rect.x, ann.rect.x + ann.rect.w);
                  ry = Math.min(ann.rect.y, ann.rect.y + ann.rect.h);
                  rw = Math.abs(ann.rect.w);
                  rh = Math.abs(ann.rect.h);
                } else if (ann.tool === "text") {
                  const canvas = document.createElement('canvas');
                  const ctx = canvas.getContext('2d');
                  if (ctx && ann.text && ann.points[0]) {
                    ctx.font = `${ann.fontSize}px ${ann.fontFamily}`;
                    const lines = ann.text.split('\n');
                    let maxWidth = 0;
                    let totalHeight = lines.length * (ann.fontSize || 24) * 1.2;
                    for (const line of lines) {
                      const metrics = ctx.measureText(line);
                      if (metrics.width > maxWidth) maxWidth = metrics.width;
                    }
                    rx = ann.points[0].x;
                    ry = ann.points[0].y;
                    rw = maxWidth;
                    rh = totalHeight;
                  }
                } else if (ann.tool === "arrow") {
                  rx = Math.min(ann.points[0].x, ann.points[1].x);
                  ry = Math.min(ann.points[0].y, ann.points[1].y);
                  rw = Math.abs(ann.points[1].x - ann.points[0].x);
                  rh = Math.abs(ann.points[1].y - ann.points[0].y);
                }

                if (ann.tool === "arrow") {
                  return (
                    <div className="absolute z-20 select-none" style={{ left: rx, top: ry, width: rw, height: rh }}>
                      <div className="absolute border border-blue-500/50 bg-blue-500/10 cursor-move" style={{ width: '100%', height: '100%' }} onPointerDown={(e) => {
                        e.stopPropagation();
                        historySnapshot.current = annotations;
                        setIsMovingAnnotation(true);
                        moveStartPos.current = { x: e.clientX, y: e.clientY };
                      }} />
                      <div className="absolute w-3 h-3 bg-white border border-blue-500 rounded-full cursor-crosshair z-30" style={{ left: ann.points[0].x - rx - 6, top: ann.points[0].y - ry - 6 }} onPointerDown={(e) => { e.stopPropagation(); historySnapshot.current = annotations; setIsResizingAnnotation('start'); resizeStartAnnotation.current = ann; }} onMouseDown={e => e.preventDefault()} />
                      <div className="absolute w-3 h-3 bg-white border border-blue-500 rounded-full cursor-crosshair z-30" style={{ left: ann.points[1].x - rx - 6, top: ann.points[1].y - ry - 6 }} onPointerDown={(e) => { e.stopPropagation(); historySnapshot.current = annotations; setIsResizingAnnotation('end'); resizeStartAnnotation.current = ann; }} onMouseDown={e => e.preventDefault()} />
                    </div>
                  );
                }

                return (
                  <div 
                    className={`absolute border border-blue-500 bg-blue-500/10 z-20 select-none ${ann.tool === 'text' ? 'cursor-text' : 'cursor-move'}`}
                    style={{ left: rx, top: ry, width: rw, height: rh }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      historySnapshot.current = annotations;
                      setIsMovingAnnotation(true);
                      moveStartPos.current = { x: e.clientX, y: e.clientY };
                    }}
                    onDoubleClick={(e) => {
                      if (ann.tool === "text") {
                        e.stopPropagation();
                        historySnapshot.current = annotations;
                        const { clientX, clientY } = getClientPos(ann.points[0].x, ann.points[0].y);
                        setActiveText({ x: ann.points[0].x, y: ann.points[0].y, clientX, clientY, text: ann.text || "" });
                        setCurrentColor(ann.color);
                        setFontFamily(ann.fontFamily || "Inter");
                        setFontSize(ann.fontSize || 24);
                        setAnnotations(prev => prev.filter(a => a.id !== ann.id));
                        setSelectedAnnotationId(null);
                      }
                    }}
                  >
                    {(ann.tool === "rect" || ann.tool === "circle") && (
                      <>
                        <div className="absolute w-3 h-3 bg-white border border-blue-500 cursor-nwse-resize z-30" style={{ left: -6, top: -6 }} onPointerDown={(e) => { e.stopPropagation(); historySnapshot.current = annotations; setIsResizingAnnotation('nw'); resizeStartAnnotation.current = ann; }} onMouseDown={e => e.preventDefault()} />
                        <div className="absolute w-3 h-3 bg-white border border-blue-500 cursor-nesw-resize z-30" style={{ left: rw - 6, top: -6 }} onPointerDown={(e) => { e.stopPropagation(); historySnapshot.current = annotations; setIsResizingAnnotation('ne'); resizeStartAnnotation.current = ann; }} onMouseDown={e => e.preventDefault()} />
                        <div className="absolute w-3 h-3 bg-white border border-blue-500 cursor-nesw-resize z-30" style={{ left: -6, top: rh - 6 }} onPointerDown={(e) => { e.stopPropagation(); historySnapshot.current = annotations; setIsResizingAnnotation('sw'); resizeStartAnnotation.current = ann; }} onMouseDown={e => e.preventDefault()} />
                        <div className="absolute w-3 h-3 bg-white border border-blue-500 cursor-nwse-resize z-30" style={{ left: rw - 6, top: rh - 6 }} onPointerDown={(e) => { e.stopPropagation(); historySnapshot.current = annotations; setIsResizingAnnotation('se'); resizeStartAnnotation.current = ann; }} onMouseDown={e => e.preventDefault()} />
                        
                        <div className="absolute h-3 bg-white border border-blue-500 cursor-ns-resize z-30" style={{ left: rw / 2 - 6, top: -6, width: 12 }} onPointerDown={(e) => { e.stopPropagation(); historySnapshot.current = annotations; setIsResizingAnnotation('n'); resizeStartAnnotation.current = ann; }} onMouseDown={e => e.preventDefault()} />
                        <div className="absolute h-3 bg-white border border-blue-500 cursor-ns-resize z-30" style={{ left: rw / 2 - 6, top: rh - 6, width: 12 }} onPointerDown={(e) => { e.stopPropagation(); historySnapshot.current = annotations; setIsResizingAnnotation('s'); resizeStartAnnotation.current = ann; }} onMouseDown={e => e.preventDefault()} />
                        <div className="absolute w-3 bg-white border border-blue-500 cursor-ew-resize z-30" style={{ left: -6, top: rh / 2 - 6, height: 12 }} onPointerDown={(e) => { e.stopPropagation(); historySnapshot.current = annotations; setIsResizingAnnotation('w'); resizeStartAnnotation.current = ann; }} onMouseDown={e => e.preventDefault()} />
                        <div className="absolute w-3 bg-white border border-blue-500 cursor-ew-resize z-30" style={{ left: rw - 6, top: rh / 2 - 6, height: 12 }} onPointerDown={(e) => { e.stopPropagation(); historySnapshot.current = annotations; setIsResizingAnnotation('e'); resizeStartAnnotation.current = ann; }} onMouseDown={e => e.preventDefault()} />
                      </>
                    )}
                  </div>
                );
              })()}
          
              {activeText && (
                <textarea
                  autoFocus
                  ref={(el) => {
                    if (el) {
                      el.style.height = 'auto';
                      el.style.height = el.scrollHeight + 'px';
                      el.style.width = 'auto';
                      el.style.width = el.scrollWidth + 'px';
                    }
                  }}
                  onFocus={(e) => {
                    const val = e.target.value;
                    e.target.value = '';
                    e.target.value = val;
                  }}
                  value={activeText.text}
                  onChange={(e) => {
                    setActiveText({ ...activeText, text: e.target.value });
                    e.target.style.height = 'auto';
                    e.target.style.height = `${e.target.scrollHeight}px`;
                    e.target.style.width = 'auto';
                    e.target.style.width = `${e.target.scrollWidth + 20}px`;
                  }}
                  onBlur={(e) => {
                    if (isCancellingText.current) {
                      isCancellingText.current = false;
                      setActiveText(null);
                      return;
                    }
                    if (e.relatedTarget && (e.relatedTarget as HTMLElement).closest('header')) {
                      return;
                    }
                    if (isHoveringHeader.current) {
                      // Clicked a non-focusable element in the header (e.g. range slider in WebKit)
                      setTimeout(() => {
                        if (e.target) (e.target as HTMLTextAreaElement).focus();
                      }, 0);
                      return;
                    }
                    if (activeText.text.trim() || historySnapshot.current) {
                      if (hasEditedAnnotation.current && historySnapshot.current) {
                        const snap = historySnapshot.current;
                        setUndoStack(prev => [...prev, snap]);
                        setRedoStack([]);
                        hasEditedAnnotation.current = false;
                        historySnapshot.current = null;
                      }
                      if (activeText.text.trim()) {
                        setAnnotations(prev => [...prev, {
                          id: crypto.randomUUID(), tool: "text", color: currentColor, lineWidth, points: [{ x: activeText.x, y: activeText.y }], text: activeText.text, fontSize, fontFamily
                        }]);
                      }
                    }
                    setActiveText(null);
                    setCurrentTool(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      isCancellingText.current = true;
                      setActiveText(null);
                      setCurrentTool(null);
                    }
                  }}
                  onWheel={(e) => {
                    if (e.metaKey || e.ctrlKey) {
                      setFontSize(prev => Math.max(8, Math.min(100, prev - Math.sign(e.deltaY))));
                    }
                  }}
                  style={{
                    position: 'fixed',
                    left: activeText.clientX,
                    top: activeText.clientY,
                    color: currentColor,
                    fontFamily: fontFamily,
                    fontSize: `${fontSize}px`,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    padding: 0,
                    margin: 0,
                    lineHeight: 1.2,
                    whiteSpace: 'pre',
                    overflow: 'hidden',
                    resize: 'none',
                    minWidth: '200px',
                    minHeight: '100px',
                    zIndex: 50
                  }}
                />
              )}
            </div>
          </div>
        </>
      ) : null}
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
          
          if (settings.language) {
            i18n.changeLanguage(settings.language);
          } else {
            i18n.changeLanguage('en');
          }
          
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('set_debug_logs_enabled', { enabled: settings.enableDebugLogs }).catch(console.warn);
            
            // Update system tray menu language
            invoke('update_tray_menu', {
              openCaptureMenu: i18n.t('settings.open_capture_menu') || 'Open Capture Menu',
              captureFullscreen: i18n.t('settings.capture_full_screen') || 'Capture Full Screen',
              captureRegion: i18n.t('settings.capture_region') || 'Capture Region',
              captureWindow: i18n.t('settings.capture_window') || 'Capture Window',
              scrollingCapture: i18n.t('settings.scrolling_capture') || 'Scrolling Capture',
              settingsText: i18n.t('settings.title') || 'Settings...',
              quitText: i18n.t('app.quit') || 'Quit',
            }).catch(console.warn);
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

          const executeAction = async (mode: string) => {
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

              if (mode === "capture_menu") {
                const cp = await Window.getByLabel("capture-menu");
                if (cp) {
                  const isVis = await cp.isVisible();
                  if (isVis) {
                    await cp.hide();
                  } else {
                    await cp.show();
                    await cp.setFocus();
                  }
                } else {
                  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                  new WebviewWindow('capture-menu', {
                    url: '/?mode=capture-menu',
                    title: 'Specture Options',
                    width: 400,
                    height: 160,
                    decorations: false,
                    transparent: true,
                    alwaysOnTop: true,
                    resizable: false,
                    shadow: false
                  });
                }
              } else if (mode === "settings") {
                const { Window } = await import('@tauri-apps/api/window');
                const existingSettings = await Window.getByLabel("settings");
                if (existingSettings) {
                  await existingSettings.show();
                  await existingSettings.setFocus();
                } else {
                  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                  new WebviewWindow('settings', {
                    url: '/?mode=settings',
                    title: 'Specture Settings',
                    width: 800,
                    height: 600,
                    resizable: false
                  });
                }
              } else {
                const cp = await Window.getByLabel("capture-menu");
                if (cp) await cp.hide();

                // slight delay to let CP hide
                await new Promise(r => setTimeout(r, 200));

                await invoke("take_screenshot");

                const isScrolling = mode === "scrolling";
                if (mode === "fullscreen" || mode === "region" || mode === "window" || mode === "scrolling") {
                  const captureMode = mode === "scrolling" ? "scrolling" : mode;
                  await emit("load-image", { target: "main", isScrolling, captureMode });
                }
              }
            } catch (actionErr) {
              console.error("Action failed", actionErr);
              await getCurrentWindow().show();
              await message(`Failed to execute shortcut action: ${actionErr}`, { title: 'Execution Error', kind: 'error' });
              await getCurrentWindow().hide();
            }
          };

          const handleShortcut = async (firedShortcut: string) => {
            let mode = null;
            const normFired = normalizeShortcut(firedShortcut);
            if (normFired === normalizeShortcut(settings.shortcutCaptureMenu)) mode = "capture_menu";
            else if (normFired === normalizeShortcut(settings.shortcutFullScreen)) mode = "fullscreen";
            else if (normFired === normalizeShortcut(settings.shortcutRegion)) mode = "region";
            else if (normFired === normalizeShortcut(settings.shortcutWindow)) mode = "window";
            else if (normFired === normalizeShortcut(settings.shortcutScrolling)) mode = "scrolling";
            
            if (mode) await executeAction(mode);
          };

          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('register_shortcuts', { 
            shortcuts: [
              settings.shortcutCaptureMenu, 
              settings.shortcutFullScreen, 
              settings.shortcutRegion,
              settings.shortcutWindow,
              settings.shortcutScrolling
            ]
          });

          // Bind our rock-solid Rust IPC fallback listener once
          // Using global listener because Rust app.emit is global
          const unlistenShortcut = await listen<string>("global-shortcut-triggered", async (e) => {
            const firedShortcut = e.payload;
            await handleShortcut(firedShortcut);
          });
          
          const unlistenTray = await listen<string>("tray-action", async (e) => {
            const action = e.payload;
            if (action) await executeAction(action);
          });
          
          return () => {
             unlistenShortcut();
             unlistenTray();
          };
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
      
      const applyLanguage = async () => {
         const settings = await loadSettings();
         if (settings.language) {
            i18n.changeLanguage(settings.language);
         } else {
            i18n.changeLanguage('en');
         }
      };
      
      const unlistenSettings = listen("settings-updated", () => {
         applyShortcuts();
         applyLanguage();
      });
      
      return () => {
         currentUnlisten();
         unlistenSettings.then(f => f());
      };
    } else {
      // For all other windows (Capture Menu, Editor), ensure language updates dynamically
      const applyLanguage = async () => {
         const settings = await loadSettings();
         if (settings.language) {
            i18n.changeLanguage(settings.language);
         } else {
            i18n.changeLanguage('en');
         }
      };
      
      applyLanguage();
      const unlistenSettings = listen("settings-updated", applyLanguage);
      return () => {
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

  if (label === "capture-menu") return <CaptureMenu />;
  if (label === "settings") return <Settings />;
  return <Editor />;
}

function StopRecording() {
  const { t } = useTranslation();
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
        title={t('app.stop')}
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

