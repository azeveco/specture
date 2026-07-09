import { useState, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getVersion } from '@tauri-apps/api/app';
import { loadSettings, saveSettings, SpectureSettings, defaultSettings } from './store';
import { useTranslation } from 'react-i18next';
import { Settings as SettingsIcon, Monitor, Save, Sliders, Keyboard } from 'lucide-react';
import React from 'react';

type Tab = 'general' | 'shortcuts' | 'capture' | 'export' | 'advanced';

export default function Settings() {
  const [settings, setSettingsState] = useState<SpectureSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState<string>("");
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t, i18n } = useTranslation();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [activeTab]);

  useEffect(() => {
    loadSettings().then(s => {
      setSettingsState(s);
      i18n.changeLanguage(s.language || 'en');
      setLoading(false);
    });

    getVersion().then(setVersion).catch(console.error);

    const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      setActiveTab('general');
      await getCurrentWindow().hide();
    });
    
    let unlistenHide: (() => void) | undefined;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('tauri://hide', () => {
        setActiveTab('general');
      }).then((f) => {
        unlistenHide = f;
      });
    });

    return () => { 
      unlistenClose.then(f => f()); 
      if (unlistenHide) unlistenHide();
    };
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

  if (loading) return <div className="h-screen w-screen bg-zinc-950 flex items-center justify-center text-zinc-400">{t('settings.loading')}</div>;

  return (
    <div className="h-screen w-screen bg-zinc-950 flex overflow-hidden text-zinc-100 font-sans selection:bg-blue-500/30" style={{ colorScheme: 'dark' }}>
      
      {/* Sidebar */}
      <div className="w-48 bg-zinc-900 border-r border-zinc-800 flex flex-col">
        <div className="p-4 pt-6 pb-2">
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-2 mb-2">Settings</h2>
        </div>
        <nav className="flex-1 px-2 space-y-1">
          <TabButton 
            active={activeTab === 'general'} 
            onClick={() => setActiveTab('general')} 
            icon={<SettingsIcon size={16} />} 
            label={t('settings.general') || "General"} 
          />
          <TabButton 
            active={activeTab === 'shortcuts'} 
            onClick={() => setActiveTab('shortcuts')} 
            icon={<Keyboard size={16} />} 
            label={t('settings.shortcuts') || "Shortcuts"} 
          />
          <TabButton 
            active={activeTab === 'capture'} 
            onClick={() => setActiveTab('capture')} 
            icon={<Monitor size={16} />} 
            label="Capture"
          />
          <TabButton 
            active={activeTab === 'export'} 
            onClick={() => setActiveTab('export')} 
            icon={<Save size={16} />} 
            label={t('settings.save_options')}
          />
          <TabButton 
            active={activeTab === 'advanced'} 
            onClick={() => setActiveTab('advanced')} 
            icon={<Sliders size={16} />} 
            label={t('settings.advanced_options')}
          />
        </nav>
        
        <div className="p-4 mt-auto">
          <div className="text-[10px] text-zinc-600 font-mono text-center w-full">
            v{version || "0.1.0"}
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-full bg-zinc-950 relative">
        <div className="h-12 border-b border-zinc-900 flex items-center px-6">
          <h1 className="text-sm font-medium text-zinc-300">
            {activeTab === 'general' && "General Settings"}
            {activeTab === 'shortcuts' && "Shortcuts"}
            {activeTab === 'capture' && "Capture Settings"}
            {activeTab === 'export' && "Export & Saving"}
            {activeTab === 'advanced' && "Advanced"}
          </h1>
        </div>
        
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-6 custom-scrollbar" ref={scrollRef}>
          <div className="max-w-2xl mx-auto space-y-8">
            
            {/* GENERAL TAB */}
            {activeTab === 'general' && (
              <div className="space-y-6 animate-in fade-in duration-200">
                <Panel title="General" description="Basic application preferences.">
                  <SettingRow label={t('settings.language')}>
                    <select 
                      value={settings.language || "en"}
                      onChange={(e) => {
                        const lang = e.target.value;
                        updateSetting('language', lang);
                        i18n.changeLanguage(lang);
                      }}
                      className="w-48 h-8 bg-zinc-900 border border-zinc-800 rounded-md px-3 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors cursor-pointer"
                    >
                      <option value="en">English</option>
                      <option value="pt-BR">Português (Brasil)</option>
                      <option value="es">Español</option>
                    </select>
                  </SettingRow>
                  
                  <SettingRow label={t('settings.start_at_login')}>
                    <Toggle 
                      checked={settings.startAtLogin || false}
                      onChange={async (checked) => {
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
                    />
                  </SettingRow>

                </Panel>
              </div>
            )}

            {/* SHORTCUTS TAB */}
            {activeTab === 'shortcuts' && (
              <div className="space-y-6 animate-in fade-in duration-200">
                <Panel title={t('settings.global_shortcuts')} description={t('settings.shortcut_modifiers_hint')}>
                  <ShortcutInput label={t('settings.open_capture_menu')} value={settings.shortcutCaptureMenu} onChange={(val) => updateSetting('shortcutCaptureMenu', val)} />
                  <ShortcutInput label={t('settings.capture_full_screen')} value={settings.shortcutFullScreen} onChange={(val) => updateSetting('shortcutFullScreen', val)} />
                  <ShortcutInput label={t('settings.capture_region')} value={settings.shortcutRegion} onChange={(val) => updateSetting('shortcutRegion', val)} />
                  <ShortcutInput label={t('settings.capture_window')} value={settings.shortcutWindow} onChange={(val) => updateSetting('shortcutWindow', val)} />
                  <ShortcutInput label={t('settings.scrolling_capture')} value={settings.shortcutScrolling} onChange={(val) => updateSetting('shortcutScrolling', val)} />
                </Panel>

                <Panel title={t('settings.editor_cheatsheet', 'Editor Cheat Sheet')} description={t('settings.editor_cheatsheet_desc', 'Quick keyboard and mouse shortcuts for the annotation editor.')}>
                  {(() => {
                    const isMac = navigator.userAgent.toLowerCase().includes('mac');
                    const ctrl = isMac ? '⌘' : 'Ctrl';
                    const shift = isMac ? '⇧' : 'Shift';
                    return (
                      <>
                        <CheatSheetRow label={t('settings.cheat_tools', 'Select Tools (1-9)')} shortcut={<><Kbd>1</Kbd><span className="text-zinc-600 text-xs">..</span><Kbd>9</Kbd></>} />
                        <CheatSheetRow label={t('settings.cheat_size', 'Change Tool Size (or Font Size if not typing)')} shortcut={<><Kbd>[</Kbd><span className="text-zinc-600 text-xs">/</span><Kbd>]</Kbd></>} />
                        <CheatSheetRow label={t('settings.cheat_fontsize', 'Change Font Size (while typing)')} shortcut={<><Kbd>{ctrl}</Kbd><span className="text-zinc-600 text-xs">+</span><Kbd>[</Kbd><span className="text-zinc-600 text-xs">/</span><Kbd>]</Kbd></>} />
                        <CheatSheetRow label={t('settings.cheat_color', 'Open Color Picker')} shortcut={<Kbd>Right Click</Kbd>} />
                        <CheatSheetRow label={t('settings.cheat_eyedropper', 'Eyedropper Tool')} shortcut={<><Kbd>{ctrl}</Kbd><span className="text-zinc-600 text-xs">+</span><Kbd>Click</Kbd></>} />
                        <CheatSheetRow label={t('settings.cheat_undo', 'Undo Action')} shortcut={<><Kbd>{ctrl}</Kbd><span className="text-zinc-600 text-xs">+</span><Kbd>Z</Kbd></>} />
                        <CheatSheetRow label={t('settings.cheat_redo', 'Redo Action')} shortcut={<><Kbd>{ctrl}</Kbd><span className="text-zinc-600 text-xs">+</span><Kbd>{shift}</Kbd><span className="text-zinc-600 text-xs">+</span><Kbd>Z</Kbd></>} />
                        <CheatSheetRow label={t('settings.cheat_save', 'Save Image')} shortcut={<><Kbd>{ctrl}</Kbd><span className="text-zinc-600 text-xs">+</span><Kbd>S</Kbd></>} />
                        <CheatSheetRow label={t('settings.cheat_copy', 'Copy to Clipboard')} shortcut={<><Kbd>{ctrl}</Kbd><span className="text-zinc-600 text-xs">+</span><Kbd>C</Kbd></>} />
                        <CheatSheetRow label={t('settings.cheat_cancel', 'Cancel / Deselect')} shortcut={<Kbd>Esc</Kbd>} />
                      </>
                    );
                  })()}
                </Panel>
              </div>
            )}

            {/* CAPTURE TAB */}
            {activeTab === 'capture' && (
              <div className="space-y-6 animate-in fade-in duration-200">
                <Panel title={t('settings.editor_tools', 'Editor Tools')} description={t('settings.editor_tools_hint', 'Configure the default behavior for the capture editor.')}>
                  <SettingRow label={t('settings.highlighter_mode', 'Highlighter Default Mode')}>
                    <select 
                      value={settings.highlighterMode || "normal"}
                      onChange={(e) => updateSetting('highlighterMode', e.target.value as "normal" | "multiply")}
                      className="w-48 h-8 bg-zinc-900 border border-zinc-800 rounded-md px-3 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors cursor-pointer"
                    >
                      <option value="normal">{t('settings.highlighter_normal', 'Normal Transparency')}</option>
                      <option value="multiply">{t('settings.highlighter_multiply', 'Multiply Blend')}</option>
                    </select>
                  </SettingRow>

                  <SettingRow label={t('settings.toolbar_position', 'Default Toolbar Position')}>
                    <select 
                      value={settings.toolbarPosition || "bottom"}
                      onChange={(e) => updateSetting('toolbarPosition', e.target.value as "bottom" | "top")}
                      className="w-48 h-8 bg-zinc-900 border border-zinc-800 rounded-md px-3 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors cursor-pointer"
                    >
                      <option value="bottom">{t('settings.position_bottom', 'Bottom')}</option>
                      <option value="top">{t('settings.position_top', 'Top')}</option>
                    </select>
                  </SettingRow>
                </Panel>
                
                <Panel title={t('settings.scrolling_capture')} description={t('settings.max_duration_hint')}>
                  <SettingRow label={t('settings.stop_button_position')}>
                    <select 
                      value={settings.stopButtonPosition || "hidden"}
                      onChange={(e) => updateSetting('stopButtonPosition', e.target.value as any)}
                      className="w-48 h-8 bg-zinc-900 border border-zinc-800 rounded-md px-3 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors cursor-pointer"
                    >
                      <option value="top">{t('settings.position_top')}</option>
                      <option value="bottom">{t('settings.position_bottom')}</option>
                      <option value="left">{t('settings.position_left')}</option>
                      <option value="right">{t('settings.position_right')}</option>
                      <option value="hidden">{t('settings.position_hidden')}</option>
                    </select>
                  </SettingRow>
                  
                  <SettingRow label={t('settings.max_duration')}>
                    <input 
                      type="number" 
                      min="1" max="300"
                      value={settings.maxRecordingDuration || 30}
                      onChange={(e) => updateSetting('maxRecordingDuration', parseInt(e.target.value) || 30)}
                      className="w-24 h-8 bg-zinc-900 border border-zinc-800 rounded-md px-3 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors text-center"
                    />
                  </SettingRow>
                </Panel>
              </div>
            )}

            {/* EXPORT TAB */}
            {activeTab === 'export' && (
              <div className="space-y-6 animate-in fade-in duration-200">
                <Panel title={t('settings.save_options')} description="Configure how and where your captures are saved.">
                  <SettingRow label={t('settings.save_on_copy')}>
                    <Toggle 
                      checked={settings.saveOnCopy}
                      onChange={(checked) => updateSetting('saveOnCopy', checked)}
                    />
                  </SettingRow>

                  <SettingRow label={t('settings.default_save_location')}>
                    <div className="flex gap-2 w-full max-w-[450px]">
                      <input 
                        type="text" 
                        readOnly 
                        value={settings.defaultSaveLocation} 
                        placeholder={t('settings.select_folder_placeholder')}
                        className="flex-1 min-w-0 h-8 bg-zinc-900 border border-zinc-800 rounded-md px-3 text-sm text-zinc-300 focus:outline-none focus:border-blue-500/50 text-ellipsis overflow-hidden whitespace-nowrap"
                      />
                      <button onClick={handleSelectFolder} className="shrink-0 px-3 h-8 flex items-center bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 rounded-md text-sm transition-colors cursor-pointer">
                        {t('settings.browse_button')}
                      </button>
                      <button onClick={() => updateSetting('defaultSaveLocation', '')} className="shrink-0 px-3 h-8 flex items-center bg-red-950/30 hover:bg-red-900/40 text-red-400 border border-red-900/30 rounded-md text-sm transition-colors cursor-pointer" title={t('settings.clear_folder_title')}>
                        {t('settings.clear_button')}
                      </button>
                    </div>
                  </SettingRow>

                  <SettingRow label={t('settings.naming_convention')}>
                    <input 
                      type="text" 
                      value={settings.namingConvention}
                      onChange={(e) => updateSetting('namingConvention', e.target.value)}
                      placeholder="Specture_{YYYY-MM-DD}_{HH-MM-SS}"
                      className="w-full max-w-[450px] h-8 bg-zinc-900 border border-zinc-800 rounded-md px-3 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50"
                    />
                  </SettingRow>
                </Panel>
              </div>
            )}

            {/* ADVANCED TAB */}
            {activeTab === 'advanced' && (
              <div className="space-y-6 animate-in fade-in duration-200">
                <Panel title="Advanced & Maintenance" description="System options and configuration data management.">
                  <SettingRow label={t('settings.color_space_mode')}>
                    <select 
                      value={settings.colorSpaceMode || "auto"}
                      onChange={(e) => updateSetting('colorSpaceMode', e.target.value as any)}
                      className="w-48 h-8 bg-zinc-900 border border-zinc-800 rounded-md px-3 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors cursor-pointer"
                    >
                      <option value="auto">{t('settings.color_space_auto')}</option>
                      <option value="srgb">{t('settings.color_space_srgb')}</option>
                      <option value="display-p3">{t('settings.color_space_p3')}</option>
                    </select>
                  </SettingRow>

                  <SettingRow label={t('settings.enable_debug_logs')}>
                    <Toggle 
                      checked={settings.enableDebugLogs}
                      onChange={(checked) => {
                        updateSetting('enableDebugLogs', checked);
                        import('@tauri-apps/api/core').then(({ invoke }) => {
                          invoke('set_debug_logs_enabled', { enabled: checked }).catch(console.warn);
                        });
                      }}
                    />
                  </SettingRow>

                  <SettingRow label="Configuration Data">
                    <div className="flex gap-2">
                      <button onClick={handleImport} className="px-4 h-8 flex items-center bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded-md text-sm transition-colors cursor-pointer">
                        Import
                      </button>
                      <button onClick={handleExport} className="px-4 h-8 flex items-center bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded-md text-sm transition-colors cursor-pointer">
                        Export
                      </button>
                      <button onClick={handleResetSettings} className="px-4 h-8 flex items-center bg-red-950/30 hover:bg-red-900/40 border border-red-900/50 text-red-400 rounded-md text-sm transition-colors cursor-pointer">
                        Reset
                      </button>
                    </div>
                  </SettingRow>
                </Panel>
              </div>
            )}
            
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Reusable Sub-components
// ----------------------------------------------------------------------

function TabButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
        active ? 'bg-blue-600/10 text-blue-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
      }`}
    >
      <span className={active ? 'text-blue-500' : 'text-zinc-500'}>{icon}</span>
      {label}
    </button>
  );
}

function Panel({ title, description, children }: { title: string, description: string, children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-4">
        <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
        <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{description}</p>
      </div>
      <div className="bg-zinc-900/30 border border-zinc-800/50 rounded-xl overflow-hidden shadow-sm flex flex-col">
        {children}
      </div>
    </section>
  );
}

function SettingRow({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 px-4 border-b border-zinc-800/40 last:border-0 hover:bg-zinc-800/20 transition-colors">
      <span className="text-sm font-medium text-zinc-300 whitespace-nowrap mr-4 shrink-0">{label}</span>
      <div className="flex items-center justify-end gap-2 flex-1 min-w-0">
        {children}
      </div>
    </div>
  );
}

function CheatSheetRow({ label, shortcut }: { label: string, shortcut: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 px-4 border-b border-zinc-800/40 last:border-0 hover:bg-zinc-800/20 transition-colors">
      <span className="text-sm font-medium text-zinc-300">{label}</span>
      <div className="flex items-center gap-1">
        {shortcut}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-[11px] font-mono text-zinc-200 shadow-sm whitespace-nowrap">{children}</kbd>;
}

function Toggle({ checked, onChange }: { checked: boolean, onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
        checked ? 'bg-blue-500' : 'bg-zinc-700'
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform ${
          checked ? 'translate-x-2' : '-translate-x-2'
        }`}
      />
    </button>
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

  const isMac = navigator.userAgent.toLowerCase().includes('mac');

  const formatDisplay = (val: string) => {
    if (!val) return val;
    if (isMac) {
      return val.split('+').map(p => {
        return p
          .replace(/CommandOrControl/gi, '⌘')
          .replace(/Command/gi, '⌘')
          .replace(/Cmd/gi, '⌘')
          .replace(/Control/gi, '⌃')
          .replace(/Ctrl/gi, '⌃')
          .replace(/Option/gi, '⌥')
          .replace(/Alt/gi, '⌥')
          .replace(/Shift/gi, '⇧');
      }).join(' ');
    }
    return val.replace(/CommandOrControl/gi, 'Ctrl').split('+').join(' + ');
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
    
    const modifiers = [];
    if (e.ctrlKey) modifiers.push('CommandOrControl');
    if (e.altKey) modifiers.push('Option');
    if (e.shiftKey) modifiers.push('Shift');
    
    const keyMap: Record<string, string> = {
      ' ': 'Space',
      'ArrowUp': 'Up',
      'ArrowDown': 'Down',
      'ArrowLeft': 'Left',
      'ArrowRight': 'Right',
      'Enter': 'Return'
    };
    
    let key = keyMap[e.key] || e.key.toUpperCase();
    if (key.length === 1 && key >= 'a' && key <= 'z') key = key.toUpperCase();
    
    if (modifiers.length === 0 && key.length === 1) return;
    
    const shortcut = [...modifiers, key].join('+');
    onChange(shortcut);
    setIsRecording(false);
    if (inputRef.current) inputRef.current.blur();
  };

  return (
    <div className="flex items-center justify-between py-3 px-4 border-b border-zinc-800/40 last:border-0 hover:bg-zinc-800/20 transition-colors">
      <span className="text-sm font-medium text-zinc-300">{label}</span>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={isRecording ? t('settings.press_shortcut') : formatDisplay(value)}
          readOnly
          onFocus={startRecording}
          onBlur={() => setIsRecording(false)}
          onKeyDown={handleKeyDown}
          placeholder={t('settings.shortcut_placeholder')}
          className={`w-56 bg-zinc-900/80 border rounded-md py-1.5 px-2 text-[11px] text-center font-mono cursor-pointer transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500 ${
            isRecording ? 'border-blue-500 text-blue-400 bg-blue-500/10' : 'border-zinc-700 text-zinc-300 hover:border-zinc-600'
          }`}
        />
        {value && !isRecording && (
          <button 
            onClick={(e) => { e.stopPropagation(); onChange(''); }}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-0.5"
            title="Clear"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
