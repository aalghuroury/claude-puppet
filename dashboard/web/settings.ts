// Persisted per-user UI settings (localStorage). Subscribe via Zustand so
// components re-render when toggled.

import { create } from "zustand";

const KEY = "claude-puppet-dashboard.settings.v1";

export type Settings = {
  reduceMotion: boolean;
  showToolArgsInline: boolean;
  autoReplayNewSessions: boolean;
};

const defaults: Settings = {
  reduceMotion: false,
  showToolArgsInline: false,
  autoReplayNewSessions: false,
};

function loadSettings(): Settings {
  if (typeof localStorage === "undefined") return defaults;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

type SettingsStore = Settings & {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
};

export const useSettings = create<SettingsStore>((set, get) => ({
  ...loadSettings(),
  set: (key, value) => {
    set({ [key]: value } as Partial<Settings>);
    saveSettings({ ...get(), [key]: value } as Settings);
  },
  reset: () => {
    set(defaults);
    saveSettings(defaults);
  },
}));
