/**
 * InstantCite preferences — centralized get/set with defaults.
 * All keys are stored under `extensions.zotero.InstantCite.*` via Zotero.Prefs.
 */

import { detectPlatform, getDefaultOfficeShortcut, type InstantCitePlatform } from "./platform";

const PREFIX = "InstantCite.";
const DEFAULT_SEARCH_DIALOG_WIDTH = 1050;
const DEFAULT_SEARCH_DIALOG_HEIGHT = 800;
const MIN_SEARCH_DIALOG_WIDTH = 760;
const MIN_SEARCH_DIALOG_HEIGHT = 520;
const MAX_SEARCH_DIALOG_WIDTH = 3200;
const MAX_SEARCH_DIALOG_HEIGHT = 2200;

/** Default values for all preferences */
const DEFAULTS: Record<string, string | number | boolean> = {
  // Sources: JSON array of disabled source names (e.g. ["OpenLibrary"]).
  // LoC often blocks automated JSON requests with Cloudflare, so keep it opt-in.
  "disabledSources": "[\"LoC\"]",

  // Search timeout in seconds (1–30)
  "searchTimeout": 15,

  // Max results per source (10–200)
  "maxResults": 100,

  // InstantCite search window size in pixels
  "searchDialogWidth": DEFAULT_SEARCH_DIALOG_WIDTH,
  "searchDialogHeight": DEFAULT_SEARCH_DIALOG_HEIGHT,

  // Auto-download PDF when adding papers to library
  "autoDownloadPDF": true,

  // Instant local search (My Library) as you type
  "localSearchEnabled": true,

  // Intercept Word's Add/Edit Citation dialog with InstantCite
  "interceptCitations": true,

  // Default sort field: "relevance", "citations", or "date"
  "defaultSort": "relevance",

  // Default sort direction: "desc" or "asc"
  "defaultSortDir": "desc",

  // Word shortcut (Windows and macOS)
  "wordShortcut": "Ctrl+Shift+I",

  // LibreOffice shortcut (Windows, macOS, and Linux)
  "libreOfficeShortcut": "Ctrl+Shift+I",

  // AutoUpdate mode: "silent", "preview", "hybrid"
  "autoUpdateMode": "hybrid",

  // AutoUpdate sort order: "modified-desc" | "title-asc" | "modified-asc"
  "autoUpdateSortOrder": "modified-desc",
};

function key(name: string): string {
  return PREFIX + name;
}

export function getDefaultWordShortcut(platform: InstantCitePlatform = detectPlatform()): string {
  return getDefaultOfficeShortcut(platform);
}

export function getDefaultLibreOfficeShortcut(platform: InstantCitePlatform = detectPlatform()): string {
  return getDefaultOfficeShortcut(platform);
}

function getDefaultValue(name: string): string | number | boolean {
  if (name === "wordShortcut") return getDefaultWordShortcut();
  if (name === "libreOfficeShortcut") return getDefaultLibreOfficeShortcut();
  return DEFAULTS[name];
}

export function getPref<T extends string | number | boolean>(name: string): T {
  try {
    const val = Zotero.Prefs.get(key(name));
    if (val === undefined || val === null) return getDefaultValue(name) as T;
    return val as T;
  } catch {
    return getDefaultValue(name) as T;
  }
}

export function setPref(name: string, value: string | number | boolean): void {
  Zotero.Prefs.set(key(name), value);
}

// --- Typed getters for common use ---

export function getSearchTimeoutMs(): number {
  const secs = getPref<number>("searchTimeout");
  return Math.max(1, Math.min(30, secs)) * 1000;
}

export function getMaxResults(): number {
  const n = getPref<number>("maxResults");
  return Math.max(10, Math.min(200, n));
}

function getClampedNumberPref(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(getPref<number>(name));
  if (!Number.isFinite(raw)) return fallback;
  return Math.round(Math.max(min, Math.min(max, raw)));
}

export function getSearchDialogWindowSize(): { width: number; height: number } {
  return {
    width: getClampedNumberPref(
      "searchDialogWidth",
      DEFAULT_SEARCH_DIALOG_WIDTH,
      MIN_SEARCH_DIALOG_WIDTH,
      MAX_SEARCH_DIALOG_WIDTH,
    ),
    height: getClampedNumberPref(
      "searchDialogHeight",
      DEFAULT_SEARCH_DIALOG_HEIGHT,
      MIN_SEARCH_DIALOG_HEIGHT,
      MAX_SEARCH_DIALOG_HEIGHT,
    ),
  };
}

export function isAutoDownloadPDF(): boolean {
  return getPref<boolean>("autoDownloadPDF");
}

export function isLocalSearchEnabled(): boolean {
  return getPref<boolean>("localSearchEnabled");
}

export function isInterceptCitations(): boolean {
  return getPref<boolean>("interceptCitations");
}

export function getDefaultSort(): string {
  return getPref<string>("defaultSort");
}

export function getDefaultSortDir(): "asc" | "desc" {
  const v = getPref<string>("defaultSortDir");
  return v === "asc" ? "asc" : "desc";
}

export function getDisabledSources(): string[] {
  try {
    const raw = getPref<string>("disabledSources");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export type AutoUpdateMode = "silent" | "preview" | "hybrid";
export type AutoUpdateSortOrder = "modified-desc" | "modified-asc" | "title-asc";

export function getAutoUpdateMode(): AutoUpdateMode {
  const v = getPref<string>("autoUpdateMode");
  if (v === "silent" || v === "preview" || v === "hybrid") return v;
  return "hybrid";
}

export function getAutoUpdateSortOrder(): AutoUpdateSortOrder {
  const v = getPref<string>("autoUpdateSortOrder");
  if (v === "modified-desc" || v === "modified-asc" || v === "title-asc") return v;
  return "modified-desc";
}

export function setDisabledSources(sources: string[]): void {
  setPref("disabledSources", JSON.stringify(sources));
}

/** All preference definitions for the settings dialog */
export interface PrefDef {
  name: string;
  label: string;
  type: "number" | "boolean" | "select" | "sources";
  min?: number;
  max?: number;
  unit?: string;
  options?: Array<{ value: string; label: string }>;
  description?: string;
}

export const PREF_DEFS: PrefDef[] = [
  {
    name: "searchTimeout",
    label: "Search timeout",
    type: "number",
    min: 1, max: 30,
    unit: "seconds",
    description: "How long to wait for each API source to respond",
  },
  {
    name: "maxResults",
    label: "Max results per source",
    type: "number",
    min: 10, max: 200,
    unit: "results",
    description: "Maximum number of papers fetched from each API",
  },
  {
    name: "searchDialogWidth",
    label: "InstantCite window width",
    type: "number",
    min: MIN_SEARCH_DIALOG_WIDTH, max: MAX_SEARCH_DIALOG_WIDTH,
    unit: "px",
    description: "Width of the InstantCite search window",
  },
  {
    name: "searchDialogHeight",
    label: "InstantCite window height",
    type: "number",
    min: MIN_SEARCH_DIALOG_HEIGHT, max: MAX_SEARCH_DIALOG_HEIGHT,
    unit: "px",
    description: "Height of the InstantCite search window",
  },
  {
    name: "defaultSort",
    label: "Default sort",
    type: "select",
    options: [
      { value: "relevance", label: "Relevance" },
      { value: "citations", label: "Citation count" },
      { value: "date", label: "Publication date" },
    ],
  },
  {
    name: "defaultSortDir",
    label: "Sort direction",
    type: "select",
    options: [
      { value: "desc", label: "Descending (highest first)" },
      { value: "asc", label: "Ascending (lowest first)" },
    ],
  },
  {
    name: "autoDownloadPDF",
    label: "Auto-download PDF",
    type: "boolean",
    description: "Try to find and download PDFs when adding papers",
  },
  {
    name: "localSearchEnabled",
    label: "Instant local search",
    type: "boolean",
    description: "Search My Library as you type (before pressing Search)",
  },
  {
    name: "interceptCitations",
    label: "Intercept Word citations",
    type: "boolean",
    description: "Replace Zotero's Add/Edit Citation dialog with InstantCite",
  },
  {
    name: "autoUpdateMode",
    label: "AutoUpdate mode",
    type: "select",
    options: [
      { value: "hybrid", label: "Hybrid (auto-fill empty, confirm changes)" },
      { value: "preview", label: "Preview all changes" },
      { value: "silent", label: "Apply all changes automatically" },
    ],
    description: "How AutoUpdate applies corrections from external databases (per-item)",
  },
  {
    name: "autoUpdateSortOrder",
    label: "AutoUpdate sort order",
    type: "select",
    options: [
      { value: "modified-desc", label: "Most recently modified first" },
      { value: "modified-asc", label: "Oldest modified first" },
      { value: "title-asc", label: "By title (A-Z)" },
    ],
    description: "Order in which items are processed during batch AutoUpdate",
  },
];

export const ALL_SOURCE_NAMES = [
  { id: "Zotero", label: "My Library" },
  { id: "PubMed", label: "PubMed" },
  { id: "EuropePMC", label: "Europe PMC" },
  { id: "CrossRef", label: "CrossRef" },
  { id: "DOAJ", label: "DOAJ" },
  { id: "OpenLibrary", label: "Open Library" },
  { id: "GoogleBooks", label: "Google Books" },
  { id: "LoC", label: "Library of Congress" },
  { id: "ECHR", label: "ECHR (Case Law)" },
  { id: "EUR-Lex", label: "EUR-Lex (Legislation)" },
  { id: "CourtListener", label: "CourtListener (US Case Law)" },
];
