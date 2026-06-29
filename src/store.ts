import { Store } from "@tauri-apps/plugin-store";

let storeInstance: Store | null = null;
export async function getStore() {
  if (!storeInstance) {
    storeInstance = await Store.load("settings.json");
  }
  return storeInstance;
}

export interface SpectureSettings {
  shortcutControlPanel: string;
  shortcutFullScreen: string;
  shortcutRegion: string;
  shortcutWindow: string;
  shortcutScrolling: string;
  saveOnCopy: boolean;
  defaultSaveLocation: string;
  namingConvention: string;
  stopButtonPosition: "top" | "bottom" | "left" | "right" | "hidden";
  startAtLogin: boolean;
  maxRecordingDuration: number;
  enableDebugLogs: boolean;
}

export const defaultSettings: SpectureSettings = {
  shortcutControlPanel: "CommandOrControl+Alt+5",
  shortcutFullScreen: "CommandOrControl+Alt+3",
  shortcutRegion: "CommandOrControl+Alt+4",
  shortcutWindow: "CommandOrControl+Alt+7",
  shortcutScrolling: "CommandOrControl+Alt+6",
  saveOnCopy: false,
  defaultSaveLocation: "",
  namingConvention: "Specture_{YYYY-MM-DD}_{HH-MM-SS}",
  stopButtonPosition: "hidden",
  startAtLogin: false,
  maxRecordingDuration: 30,
  enableDebugLogs: false,
};

export async function loadSettings(): Promise<SpectureSettings> {
  let settings = { ...defaultSettings };
  try {
    const store = await getStore();
    for (const key of Object.keys(defaultSettings) as Array<keyof SpectureSettings>) {
      const val = await store.get<any>(key);
      if (val !== undefined && val !== null) {
        (settings as any)[key] = val;
      }
    }
  } catch (e) {
    console.error("Failed to load settings", e);
  }
  return settings;
}

export async function saveSettings(settings: SpectureSettings) {
  try {
    const store = await getStore();
    for (const [key, value] of Object.entries(settings)) {
      await store.set(key, value);
    }
    await store.save();
  } catch (e) {
    console.error("Failed to save settings", e);
  }
}
