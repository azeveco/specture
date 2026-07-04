use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager, Builder, Emitter
};
use xcap::Monitor;
use std::sync::Mutex;
use tauri::State;
use std::fs::File;
use std::io::Write;
use std::thread;
use std::time::Duration;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use image::ImageEncoder;
mod stitcher;

#[tauri::command]
fn register_shortcuts(app: tauri::AppHandle, shortcuts: Vec<String>) -> Result<(), String> {
    // Unregister any existing shortcuts
    let _ = app.global_shortcut().unregister_all();
    
    for s in shortcuts {
        if s.is_empty() { continue; }
        match s.parse::<Shortcut>() {
            Ok(sc) => {
                if let Err(e) = app.global_shortcut().register(sc) {
                    eprintln!("Failed to register shortcut {}: {}", s, e);
                }
            }
            Err(e) => {
                eprintln!("Failed to parse shortcut {}: {:?}", s, e);
            }
        }
    }
    Ok(())
}

struct AppState {
    image_buffer: Mutex<Option<Vec<u8>>>,
}

struct TrayStrings {
    open_control_panel: String,
    capture_fullscreen: String,
    capture_region: String,
    capture_window: String,
    scrolling_capture: String,
    settings_text: String,
    quit_text: String,
}

struct TrayState(Mutex<TrayStrings>);

impl Default for TrayState {
    fn default() -> Self {
        Self(Mutex::new(TrayStrings {
            open_control_panel: "Open Control Panel".into(),
            capture_fullscreen: "Capture Full Screen".into(),
            capture_region: "Capture Region".into(),
            capture_window: "Capture Window".into(),
            scrolling_capture: "Scrolling Capture".into(),
            settings_text: "Settings...".into(),
            quit_text: "Quit".into(),
        }))
    }
}

struct RecordingState {
    frames: Arc<Mutex<Vec<image::RgbaImage>>>,
    is_recording: Arc<AtomicBool>,
}

impl Default for RecordingState {
    fn default() -> Self {
        Self {
            frames: Arc::new(Mutex::new(Vec::new())),
            is_recording: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Command exposed to the frontend to trigger a screenshot.
/// Returns the image as a base64 string or raw byte array (Vec<u8>).
#[tauri::command]
async fn take_screenshot(state: State<'_, AppState>, window: tauri::WebviewWindow) -> Result<(), String> {
    let current_monitor_name = window.current_monitor()
        .unwrap_or(None)
        .and_then(|m| m.name().cloned())
        .unwrap_or_default();
    
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors.into_iter().find(|m| m.name().unwrap_or_default() == current_monitor_name).unwrap_or_else(|| {
        Monitor::all().unwrap().into_iter().next().unwrap()
    });
    
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    
    let width = image.width();
    let height = image.height();
    
    let mut buf = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new_with_quality(&mut buf, image::codecs::png::CompressionType::Fast, image::codecs::png::FilterType::NoFilter);
    encoder.write_image(&image.into_raw(), width, height, image::ExtendedColorType::Rgba8).map_err(|e| e.to_string())?;
    
    *state.image_buffer.lock().unwrap() = Some(buf);
    Ok(())
}

#[tauri::command]
fn get_image_buffer(state: State<'_, AppState>) -> Result<tauri::ipc::Response, String> {
    if let Some(bytes) = state.image_buffer.lock().unwrap().as_ref() {
        Ok(tauri::ipc::Response::new(bytes.clone()))
    } else {
        Err("No image buffer found".into())
    }
}

#[tauri::command]
fn start_scrolling_capture(state: State<'_, RecordingState>, window: tauri::WebviewWindow, app: tauri::AppHandle, x: u32, y: u32, w: u32, h: u32, max_duration_seconds: u64) -> Result<(), String> {
    log_debug(format!("start_scrolling_capture called. rect: {},{},{},{}", x, y, w, h));
    state.is_recording.store(true, Ordering::SeqCst);
    state.frames.lock().unwrap().clear();
    
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = app_clone.remove_tray_by_id("main_tray");
        
        let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/red_stop_icon.png")).unwrap();
        let _ = tauri::tray::TrayIconBuilder::with_id("main_tray_recording")
            .icon(tray_icon)
            .tooltip("Stop Recording")
            .on_tray_icon_event(|tray, event| {
                if let tauri::tray::TrayIconEvent::Click { .. } = event {
                    let app = tray.app_handle();
                    let state = app.state::<RecordingState>();
                    if state.is_recording.load(Ordering::SeqCst) {
                        state.is_recording.store(false, Ordering::SeqCst);
                        let _ = app.emit("scrolling-stopped", ());
                    }
                }
            })
            .build(&app_clone);
    });

    let current_monitor_name = window.current_monitor()
        .unwrap_or(None)
        .and_then(|m| m.name().cloned())
        .unwrap_or_default();

    let is_recording = state.is_recording.clone();
    let frames = state.frames.clone();

    thread::spawn(move || {
        let start_time = std::time::Instant::now();
        
        while is_recording.load(Ordering::SeqCst) {
            if start_time.elapsed().as_secs() >= max_duration_seconds {
                // Timeout reached
                is_recording.store(false, Ordering::SeqCst);
                let _ = app.emit("scrolling-stopped", ());
                break;
            }
            
            let monitors = match Monitor::all() {
                Ok(m) => m,
                Err(_) => break,
            };
            let monitor = monitors.into_iter().find(|m| m.name().unwrap_or_default() == current_monitor_name).unwrap_or_else(|| {
                Monitor::all().unwrap().into_iter().next().unwrap()
            });

            if let Ok(image) = monitor.capture_image() {
                let img_cropped = image::imageops::crop_imm(&image, x, y, w, h).to_image();
                frames.lock().unwrap().push(img_cropped);
            }
            thread::sleep(Duration::from_millis(200));
        }
        
        let app_clone = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = app_clone.remove_tray_by_id("main_tray_recording");
            
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/gray_icon.png")).unwrap();
            let mut builder = tauri::tray::TrayIconBuilder::with_id("main_tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Specture");
                
            let strings = {
                let s = app_clone.state::<TrayState>();
                let lock = s.0.lock().unwrap();
                (
                    lock.open_control_panel.clone(),
                    lock.capture_fullscreen.clone(),
                    lock.capture_region.clone(),
                    lock.capture_window.clone(),
                    lock.scrolling_capture.clone(),
                    lock.settings_text.clone(),
                    lock.quit_text.clone()
                )
            };
                
            use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
            if let Ok(quit_i) = MenuItemBuilder::with_id("quit", strings.6).build(&app_clone) {
                if let Ok(settings_i) = MenuItemBuilder::with_id("settings", strings.5).build(&app_clone) {
                    if let Ok(sep) = PredefinedMenuItem::separator(&app_clone) {
                        if let Ok(scrolling_i) = MenuItemBuilder::with_id("scrolling", strings.4).build(&app_clone) {
                            if let Ok(window_i) = MenuItemBuilder::with_id("window", strings.3).build(&app_clone) {
                                if let Ok(region_i) = MenuItemBuilder::with_id("region", strings.2).build(&app_clone) {
                                    if let Ok(full_i) = MenuItemBuilder::with_id("fullscreen", strings.1).build(&app_clone) {
                                        if let Ok(control_i) = MenuItemBuilder::with_id("control", strings.0).build(&app_clone) {
                                            if let Ok(menu) = MenuBuilder::new(&app_clone).items(&[
                                                &control_i, &full_i, &region_i, &window_i, &scrolling_i, &sep, &settings_i, &quit_i
                                            ]).build() {
                                                builder = builder.menu(&menu);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            let _ = builder
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => std::process::exit(0),
                    "settings" => {
                        if let Some(window) = app.get_webview_window("settings") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    action => {
                        let _ = app.emit("tray-action", action);
                    }
                })
                .build(&app_clone);
        });
    });

    Ok(())
}

#[tauri::command]
fn stop_scrolling_capture(state: State<'_, RecordingState>, app_state: State<'_, AppState>) -> Result<(), String> {
    state.is_recording.store(false, Ordering::SeqCst);
    
    // Give thread a moment to finish its last capture
    thread::sleep(Duration::from_millis(50));

    let frames = {
        let mut f = state.frames.lock().unwrap();
        let collected = f.clone();
        f.clear();
        collected
    };
    
    
    log_debug(format!("stop_scrolling_capture called. Frames collected: {}", frames.len()));

    if frames.is_empty() {
        log_debug("No frames collected!".to_string());
        return Ok(());
    }

    log_debug("Starting stitcher...".to_string());
    let stitched_opt = stitcher::stitch_frames(frames);
    if stitched_opt.is_none() {
        log_debug("Stitcher returned None!".to_string());
        return Err("Failed to stitch frames".to_string());
    }
    let stitched = stitched_opt.unwrap();
    log_debug("Stitcher succeeded!".to_string());

    let width = stitched.width();
    let height = stitched.height();
    let rgba = stitched.into_raw();

    let mut buf = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new_with_quality(&mut buf, image::codecs::png::CompressionType::Fast, image::codecs::png::FilterType::NoFilter);
    encoder.write_image(&rgba, width, height, image::ExtendedColorType::Rgba8).map_err(|e| e.to_string())?;
    
    *app_state.image_buffer.lock().unwrap() = Some(buf);

    Ok(())
}

#[tauri::command]
fn is_scrolling_active(state: State<'_, RecordingState>) -> bool {
    state.is_recording.load(Ordering::SeqCst)
}

static DEBUG_LOGS_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn set_debug_logs_enabled(enabled: bool) {
    DEBUG_LOGS_ENABLED.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn log_debug(message: String) {
    if !DEBUG_LOGS_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    use std::fs::OpenOptions;
    use std::io::Write;
    let log_path = std::path::PathBuf::from("/tmp/specture-debug.txt");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "[DEBUG] {}", message);
    }
}

#[derive(serde::Serialize)]
pub struct WindowInfo {
    pub id: u32,
    pub pid: u32,
    pub app_name: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub z: i32,
}

#[tauri::command]
fn store_cropped_image(bytes: Vec<u8>, state: State<'_, AppState>) -> Result<(), String> {
    log_debug("store_cropped_image called".to_string());
    *state.image_buffer.lock().unwrap() = Some(bytes);
    Ok(())
}

#[tauri::command]
fn get_windows() -> Result<Vec<WindowInfo>, String> {
    log_debug("get_windows called".to_string());
    let windows = xcap::Window::all().map_err(|e| e.to_string())?;
    
    let mut result = Vec::new();
    for w in windows {
        let app_name = w.app_name().unwrap_or_default();
        let title = w.title().unwrap_or_default();
        let width = w.width().unwrap_or(0);
        let height = w.height().unwrap_or(0);
        let is_minimized = w.is_minimized().unwrap_or(false);
        
        // filter out windows without size
        if width == 0 || height == 0 {
            continue;
        }
        
        if is_minimized {
            continue;
        }
        
        // Filter out macOS system background windows and specific apps
        let ignored_apps = [
            "Window Server", 
            "Dock", 
            "Control Center", 
            "Alcove", 
            "WallpaperAgent",
            "NotificationCenter",
            "Specture"
        ];
        
        if ignored_apps.contains(&app_name.as_str()) {
            continue;
        }
        
        // Optional: filter out completely empty app names
        if app_name.trim().is_empty() {
            continue;
        }
        
        log_debug(format!("Found window: {} - {} ({}x{})", app_name, title, width, height));
        
        result.push(WindowInfo {
            id: w.id().unwrap_or(0),
            pid: w.pid().unwrap_or(0),
            app_name,
            title,
            x: w.x().unwrap_or(0),
            y: w.y().unwrap_or(0),
            width,
            height,
            z: w.z().unwrap_or(0),
        });
    }
    
    Ok(result)
}

#[tauri::command]
fn activate_app(app_name: String) -> Result<(), String> {
    log_debug(format!("Activating app: {}", app_name));
    #[cfg(target_os = "macos")]
    {
        let script = format!("tell application \"{}\" to activate", app_name);
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output();
    }
    Ok(())
}

#[tauri::command]
fn capture_window(id: u32, state: State<'_, AppState>) -> Result<(), String> {
    log_debug(format!("capture_window called for id: {}", id));
    
    let windows = xcap::Window::all().map_err(|e| e.to_string())?;
    let target = windows.into_iter().find(|w| w.id().unwrap_or(0) == id);
    
    if let Some(w) = target {
        let image = w.capture_image().map_err(|e| {
            let msg = format!("Failed to capture window image: {}", e);
            log_debug(msg.clone());
            msg
        })?;
        
        let width = image.width();
        let height = image.height();
        let rgba = image.into_raw();
        
        let mut buf = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new_with_quality(&mut buf, image::codecs::png::CompressionType::Fast, image::codecs::png::FilterType::NoFilter);
        encoder.write_image(&rgba, width, height, image::ExtendedColorType::Rgba8).map_err(|e| e.to_string())?;
        
        *state.image_buffer.lock().unwrap() = Some(buf);
        
        log_debug("capture_window succeeded".to_string());
        Ok(())
    } else {
        let msg = format!("Window with id {} not found", id);
        log_debug(msg.clone());
        Err(msg)
    }
}

#[tauri::command]
fn update_tray_menu(
    app: tauri::AppHandle, 
    state: State<'_, TrayState>, 
    open_control_panel: String, 
    capture_fullscreen: String, 
    capture_region: String, 
    capture_window: String, 
    scrolling_capture: String, 
    settings_text: String, 
    quit_text: String
) -> Result<(), String> {
    {
        let mut s = state.0.lock().unwrap();
        s.open_control_panel = open_control_panel.clone();
        s.capture_fullscreen = capture_fullscreen.clone();
        s.capture_region = capture_region.clone();
        s.capture_window = capture_window.clone();
        s.scrolling_capture = scrolling_capture.clone();
        s.settings_text = settings_text.clone();
        s.quit_text = quit_text.clone();
    }
    
    if let Some(tray) = app.tray_by_id("main_tray") {
        use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
        let menu = MenuBuilder::new(&app)
            .items(&[
                &MenuItemBuilder::with_id("control", open_control_panel).build(&app).unwrap(),
                &MenuItemBuilder::with_id("fullscreen", capture_fullscreen).build(&app).unwrap(),
                &MenuItemBuilder::with_id("region", capture_region).build(&app).unwrap(),
                &MenuItemBuilder::with_id("window", capture_window).build(&app).unwrap(),
                &MenuItemBuilder::with_id("scrolling", scrolling_capture).build(&app).unwrap(),
                &PredefinedMenuItem::separator(&app).unwrap(),
                &MenuItemBuilder::with_id("settings", settings_text).build(&app).unwrap(),
                &MenuItemBuilder::with_id("quit", quit_text).build(&app).unwrap(),
            ])
            .build()
            .map_err(|e| e.to_string())?;
        let _ = tray.set_menu(Some(menu));
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--silently"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let shortcut_str = shortcut.into_string();
                        let _ = app.emit("global-shortcut-triggered", shortcut_str);
                    }
                })
                .build()
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let strings = {
                let s = app.state::<TrayState>();
                let lock = s.0.lock().unwrap();
                (
                    lock.open_control_panel.clone(),
                    lock.capture_fullscreen.clone(),
                    lock.capture_region.clone(),
                    lock.capture_window.clone(),
                    lock.scrolling_capture.clone(),
                    lock.settings_text.clone(),
                    lock.quit_text.clone()
                )
            };
            
            use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
            let quit_i = MenuItemBuilder::with_id("quit", strings.6).build(app)?;
            let settings_i = MenuItemBuilder::with_id("settings", strings.5).build(app)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let scrolling_i = MenuItemBuilder::with_id("scrolling", strings.4).build(app)?;
            let window_i = MenuItemBuilder::with_id("window", strings.3).build(app)?;
            let region_i = MenuItemBuilder::with_id("region", strings.2).build(app)?;
            let full_i = MenuItemBuilder::with_id("fullscreen", strings.1).build(app)?;
            let control_i = MenuItemBuilder::with_id("control", strings.0).build(app)?;
            
            let menu = MenuBuilder::new(app).items(&[
                &control_i, &full_i, &region_i, &window_i, &scrolling_i, &sep, &settings_i, &quit_i
            ]).build()?;

            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/gray_icon.png")).expect("Failed to load gray_icon.png");

            let _tray = TrayIconBuilder::with_id("main_tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => {
                        std::process::exit(0);
                    }
                    "settings" => {
                        if let Some(window) = app.get_webview_window("settings") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    action => {
                        let _ = app.emit("tray-action", action);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    let app = tray.app_handle();
                    
                    let event_name = match event {
                        tauri::tray::TrayIconEvent::Click { .. } => "Click",
                        tauri::tray::TrayIconEvent::DoubleClick { .. } => "DoubleClick",
                        tauri::tray::TrayIconEvent::Enter { .. } => "Enter",
                        tauri::tray::TrayIconEvent::Leave { .. } => "Leave",
                        _ => "Other",
                    };
                    
                    log_debug(format!("Tray event received: {}", event_name));

                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        let state = app.state::<RecordingState>();
                        if state.is_recording.load(Ordering::SeqCst) {
                            state.is_recording.store(false, Ordering::SeqCst);
                            let _ = app.emit("scrolling-stopped", ());
                        }
                    }
                })
                .build(app)?;
            
            Ok(())
        })
        .manage(AppState {
            image_buffer: Mutex::new(None),
        })
        .manage(RecordingState::default())
        .manage(TrayState::default())
        .invoke_handler(tauri::generate_handler![
            take_screenshot,
            get_image_buffer,
            start_scrolling_capture,
            stop_scrolling_capture,
            is_scrolling_active,
            register_shortcuts,
            log_debug,
            set_debug_logs_enabled,
            store_cropped_image,
            get_windows,
            capture_window,
            activate_app,
            update_tray_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
