import { useState, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getVersion } from '@tauri-apps/api/app';
import { loadSettings, saveSettings, SpectureSettings, defaultSettings } from './store';
import { useTranslation } from 'react-i18next';

export default function Settings() {
  const [settings, setSettingsState] = useState<SpectureSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState<string>("");
  const { t, i18n } = useTranslation();

  useEffect(() => {
    loadSettings().then(s => {
      setSettingsState(s);
      i18n.changeLanguage(s.language || 'en');
      setLoading(false);
    });

    getVersion().then(setVersion).catch(console.error);

    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      await getCurrentWindow().hide();
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  const handleResetSettings = async () => {
    try {
      const resetSettings: SpectureSettings = { ...defaultSettings };
      setSettingsState(resetSettings);
      await saveSettings(resetSettings);
      
      const { emit } = await import('@tauri-apps/api/event');
      await emit('settings-updated');
    } catch (e) {
      console.error("Failed to reset settings", e);
    }
  };

  const updateSetting = async <K extends keyof SpectureSettings>(key: K, value: SpectureSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettingsState(next);
    await saveSettings(next);
    
    // Broadcast setting changes so the main window can re-register shortcuts instantly
    const { emit } = await import('@tauri-apps/api/event');
    await emit('settings-updated');
  };

  const handleSelectFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
    });
    if (selected && typeof selected === 'string') {
      updateSetting('defaultSaveLocation', selected);
    }
  };

  const handleExport = async () => {
    try {
      const filePath = await save({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        defaultPath: 'specture-settings.json',
      });
      if (filePath) {
        await writeTextFile(filePath, JSON.stringify(settings, null, 2));
      }
    } catch (e) {
      console.error("Export failed", e);
    }
  };

  const handleImport = async () => {
    try {
      const selected = await open({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false,
      });
      if (selected && typeof selected === 'string') {
        const content = await readTextFile(selected);
        const parsed = JSON.parse(content) as SpectureSettings;
        setSettingsState(parsed);
        await saveSettings(parsed);
        
        const { emit } = await import('@tauri-apps/api/event');
        await emit('settings-updated');
      }
    } catch (e) {
      console.error("Import failed", e);
    }
  };

  if (loading) return <div className="h-screen w-screen bg-navy-900 flex items-center justify-center text-white">{t('settings.loading')}</div>;

  return (
    <div className="h-screen w-screen bg-navy-900 flex flex-col p-6 overflow-auto custom-scrollbar">
      <h1 className="text-2xl font-bold text-white mb-6">{t('settings.title')}</h1>
      
      <div className="space-y-6 pb-6">
        {/* Language Selection */}
        <section className="bg-navy-800 p-5 rounded-lg border border-navy-700 shadow-sm">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <span>🌐</span> {t('settings.language')}
          </h2>
          <select 
            value={settings.language || "en"}
            onChange={(e) => {
              const lang = e.target.value;
              updateSetting('language', lang);
              i18n.changeLanguage(lang);
            }}
            className="w-full bg-navy-900 border border-navy-700 rounded p-2 text-white text-sm focus:outline-none focus:border-emerald-500 transition-colors"
          >
            <option value="en">English</option>
            <option value="pt-BR">Português (Brasil)</option>
            <option value="es">Español</option>
          </select>
        </section>

        {/* Global Shortcuts */}
        <section className="bg-navy-800 p-5 rounded-lg border border-navy-700 shadow-sm">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <span>⌨️</span> {t('settings.global_shortcuts')}
          </h2>
          <div className="space-y-4">
            <ShortcutInput 
              label={t('settings.open_control_panel')} 
              value={settings.shortcutControlPanel}
              onChange={(val) => updateSetting('shortcutControlPanel', val)}
            />
            <ShortcutInput 
              label={t('settings.capture_full_screen')} 
              value={settings.shortcutFullScreen}
              onChange={(val) => updateSetting('shortcutFullScreen', val)}
            />
            <ShortcutInput 
              label={t('settings.capture_region')} 
              value={settings.shortcutRegion}
              onChange={(val) => updateSetting('shortcutRegion', val)}
            />
            <ShortcutInput 
              label={t('settings.capture_window')} 
              value={settings.shortcutWindow}
              onChange={(val) => updateSetting('shortcutWindow', val)}
            />
            <ShortcutInput 
              label={t('settings.scrolling_capture')} 
              value={settings.shortcutScrolling}
              onChange={(val) => updateSetting('shortcutScrolling', val)}
            />
            <p className="text-xs text-navy-300 mt-2">
              {t('settings.shortcut_modifiers_hint')}
            </p>
          </div>
          
          <div className="mt-6 pt-6 border-t border-navy-700">
            <label className="flex items-center gap-3 cursor-pointer">
              <input 
                type="checkbox" 
                checked={settings.startAtLogin || false}
                onChange={async (e) => {
                  const checked = e.target.checked;
                  updateSetting('startAtLogin', checked);
                  try {
                    const { enable, disable } = await import('@tauri-apps/plugin-autostart');
                    if (checked) {
                      await enable();
                    } else {
                      await disable();
                    }
                  } catch (err) {
                    console.error("Failed to set autostart", err);
                  }
                }}
                className="w-5 h-5 accent-emerald-500 bg-navy-900 border-navy-600 rounded cursor-pointer"
              />
              <span className="text-white text-sm font-medium">{t('settings.start_at_login')}</span>
            </label>
            <p className="text-xs text-navy-400 mt-1 ml-8">
              {t('settings.start_at_login_hint')}
            </p>
          </div>
        </section>

        {/* Save Options */}
        <section className="bg-navy-800 p-5 rounded-lg border border-navy-700 shadow-sm">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <span>💾</span> {t('settings.save_options')}
          </h2>

          <div className="space-y-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input 
                type="checkbox" 
                checked={settings.saveOnCopy}
                onChange={(e) => updateSetting('saveOnCopy', e.target.checked)}
                className="w-5 h-5 accent-emerald-500 bg-navy-900 border-navy-600 rounded cursor-pointer"
              />
              <span className="text-white text-sm">{t('settings.save_on_copy')}</span>
            </label>

            <div>
              <label className="block text-sm font-medium text-navy-200 mb-1">{t('settings.default_save_location')}</label>
              <div className="flex gap-2">
                <input 
                  type="text" 
                  readOnly 
                  value={settings.defaultSaveLocation} 
                  placeholder={t('settings.select_folder_placeholder')}
                  className="flex-1 bg-navy-900 border border-navy-700 rounded p-2 text-white text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                />
                <button 
                  onClick={handleSelectFolder}
                  className="px-4 py-2 bg-navy-700 hover:bg-navy-600 text-white rounded text-sm transition-colors cursor-pointer"
                >
                  {t('settings.browse_button')}
                </button>
                <button 
                  onClick={() => updateSetting('defaultSaveLocation', '')}
                  className="px-4 py-2 bg-red-900/30 hover:bg-red-900/60 text-red-300 rounded text-sm transition-colors cursor-pointer border border-red-900/50"
                  title={t('settings.clear_folder_title')}
                >
                  {t('settings.clear_button')}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-navy-200 mb-1">{t('settings.naming_convention')}</label>
              <input 
                type="text" 
                value={settings.namingConvention}
                onChange={(e) => updateSetting('namingConvention', e.target.value)}
                placeholder="Specture_{YYYY-MM-DD}_{HH-MM-SS}"
                className="w-full bg-navy-900 border border-navy-700 rounded p-2 text-white text-sm focus:outline-none focus:border-emerald-500 transition-colors"
              />
              <p className="text-xs text-navy-400 mt-1">
                {t('settings.available_tags')} <code>{"{YYYY-MM-DD}"}</code>, <code>{"{HH-MM-SS}"}</code>, <code>{"{TIMESTAMP}"}</code>
              </p>
            </div>
            
          </div>
        </section>

        {/* Scrolling Capture Options */}
        <section className="bg-navy-800 p-5 rounded-lg border border-navy-700 shadow-sm mt-6">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <span>📜</span> {t('settings.scrolling_capture')}
          </h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-navy-200 mb-2">{t('settings.stop_button_position')}</label>
              <select 
                value={settings.stopButtonPosition || "hidden"}
                onChange={(e) => updateSetting('stopButtonPosition', e.target.value as any)}
                className="w-full bg-navy-900 border border-navy-700 rounded p-2 text-white text-sm focus:outline-none focus:border-emerald-500 transition-colors"
              >
                <option value="top">{t('settings.position_top')}</option>
                <option value="bottom">{t('settings.position_bottom')}</option>
                <option value="left">{t('settings.position_left')}</option>
                <option value="right">{t('settings.position_right')}</option>
                <option value="hidden">{t('settings.position_hidden')}</option>
              </select>
              <p className="text-xs text-navy-400 mt-1">
                {t('settings.stop_button_hint')}
              </p>
            </div>
            
            <div className="pt-4 border-t border-navy-700">
              <label className="block text-sm font-medium text-navy-200 mb-2">{t('settings.max_duration')}</label>
              <input 
                type="number" 
                min="1"
                max="300"
                value={settings.maxRecordingDuration || 30}
                onChange={(e) => updateSetting('maxRecordingDuration', parseInt(e.target.value) || 30)}
                className="w-full bg-navy-900 border border-navy-700 rounded p-2 text-white text-sm focus:outline-none focus:border-emerald-500 transition-colors"
              />
              <p className="text-xs text-navy-400 mt-1">
                {t('settings.max_duration_hint')}
              </p>
            </div>
          </div>
        </section>

        <section className="bg-navy-800 p-5 rounded-lg border border-navy-700 shadow-sm mt-6">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <span>⚙️</span> {t('settings.advanced_options')}
          </h2>

          <div className="mb-6">
            <label className="block text-sm font-medium text-navy-200 mb-2">{t('settings.color_space_mode')}</label>
            <select 
              value={settings.colorSpaceMode || "auto"}
              onChange={(e) => updateSetting('colorSpaceMode', e.target.value as any)}
              className="w-full bg-navy-900 border border-navy-700 rounded p-2 text-white text-sm focus:outline-none focus:border-emerald-500 transition-colors"
            >
              <option value="auto">{t('settings.color_space_auto')}</option>
              <option value="srgb">{t('settings.color_space_srgb')}</option>
              <option value="display-p3">{t('settings.color_space_p3')}</option>
            </select>
            <p className="text-xs text-navy-400 mt-1">
              {t('settings.color_space_hint')}
            </p>
          </div>

          <div className="pt-4 border-t border-navy-700 mb-6">
            <label className="flex items-center gap-3 cursor-pointer">
              <div className="relative">
                <input 
                  type="checkbox" 
                  className="sr-only" 
                  checked={settings.enableDebugLogs}
                  onChange={(e) => {
                    updateSetting('enableDebugLogs', e.target.checked);
                    import('@tauri-apps/api/core').then(({ invoke }) => {
                      invoke('set_debug_logs_enabled', { enabled: e.target.checked }).catch(console.warn);
                    });
                  }}
                />
                <div className={`block w-10 h-6 rounded-full transition-colors ${settings.enableDebugLogs ? 'bg-emerald-500' : 'bg-navy-700'}`}></div>
                <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${settings.enableDebugLogs ? 'translate-x-4' : ''}`}></div>
              </div>
              <div className="text-sm font-medium text-navy-200">
                {t('settings.enable_debug_logs')}
                <p className="text-xs text-navy-400 font-normal mt-1">
                  {t('settings.enable_debug_logs_hint')}
                </p>
              </div>
            </label>
          </div>

          <div className="flex gap-4 border-t border-navy-700 pt-6">
            <button 
              className="px-4 py-2 bg-navy-700 hover:bg-navy-600 text-white rounded text-sm transition-colors cursor-pointer"
              onClick={handleImport}
            >
              {t('settings.import_settings')}
            </button>
            <button 
              className="px-4 py-2 bg-navy-700 hover:bg-navy-600 text-white rounded text-sm transition-colors cursor-pointer"
              onClick={handleExport}
            >
              {t('settings.export_settings')}
            </button>

            <button 
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded text-sm transition-colors cursor-pointer"
              onClick={handleResetSettings}
            >
              {t('settings.reset_to_defaults')}
            </button>
          </div>
        </section>
      </div>
      
      <div className="mt-auto pt-6 text-center text-xs text-navy-400 font-mono">
        v{version || "0.1.0"}
      </div>
    </div>
  );
}

function ShortcutInput({ label, value, onChange }: { label: string, value: string, onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startRecording = () => {
    setIsRecording(true);
    if (inputRef.current) inputRef.current.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isRecording) return;
    e.preventDefault();
    
    // Ignore standalone modifiers
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    
    // Cancel on raw escape
    if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
       setIsRecording(false);
       if (inputRef.current) inputRef.current.blur();
       return;
    }
    
    // Backspace to clear shortcut
    if (e.key === 'Backspace' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
       onChange('');
       setIsRecording(false);
       if (inputRef.current) inputRef.current.blur();
       return;
    }

    const keys = [];
    if (e.metaKey) keys.push("CommandOrControl");
    if (e.ctrlKey) keys.push("Control");
    if (e.altKey) keys.push("Alt");
    if (e.shiftKey) keys.push("Shift");
    
    let keyStr = e.key;
    const code = e.code; // e.g., 'KeyX', 'Digit3', 'Minus', 'Equal'

    if (code.startsWith('Key')) {
      keyStr = code.replace('Key', '');
    } else if (code.startsWith('Digit')) {
      keyStr = code.replace('Digit', '');
    } else if (code === 'Space') {
      keyStr = 'Space';
    } else if (code === 'Enter') {
      keyStr = 'Enter'; // or Return
    } else {
      // fallback to key but normalized
      if (keyStr.length === 1) keyStr = keyStr.toUpperCase();
      else keyStr = keyStr.charAt(0).toUpperCase() + keyStr.slice(1);
    }
    
    keys.push(keyStr);
    onChange(keys.join('+'));
    setIsRecording(false);
    if (inputRef.current) inputRef.current.blur();
  };

  const formatDisplay = (val: string) => {
    if (!val) return t('settings.unassigned');
    let formatted = val;
    // Format for macOS if applicable
    formatted = formatted.replace("CommandOrControl", "Command");
    formatted = formatted.replace("Alt", "Option");
    return formatted.split('+').join(' + ');
  };

  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-navy-100">{label}</span>
      <input 
        ref={inputRef}
        type="text" 
        readOnly
        value={isRecording ? t('settings.listening') : formatDisplay(value)}
        onFocus={startRecording}
        onClick={startRecording}
        onBlur={() => setIsRecording(false)}
        onKeyDown={handleKeyDown}
        className={`w-64 bg-navy-900 border rounded p-1.5 text-sm focus:outline-none font-mono text-center transition-colors cursor-pointer ${
          isRecording 
            ? 'border-indigo-500 text-indigo-300 shadow-[0_0_8px_rgba(99,102,241,0.5)]' 
            : 'border-navy-700 text-white hover:border-navy-600'
        }`}
        placeholder={t('settings.click_to_set')}
      />
    </div>
  );
}
