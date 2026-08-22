export type InstantCitePlatform = "windows" | "macos" | "linux" | "unsupported";

function getRuntimeOS(): string {
  try {
    return Services.appinfo.OS;
  } catch {
    return "";
  }
}

export function detectPlatform(os: string = getRuntimeOS()): InstantCitePlatform {
  if (os === "WINNT") return "windows";
  if (os === "Darwin") return "macos";
  if (os === "Linux") return "linux";
  return "unsupported";
}

export function getDefaultOfficeShortcut(
  platform: InstantCitePlatform = detectPlatform(),
): string {
  return platform === "macos" ? "Cmd+Shift+I" : "Ctrl+Shift+I";
}

export function getOfficeIntegrationVisibility(
  platform: InstantCitePlatform = detectPlatform(),
): { word: boolean; libreOffice: boolean } {
  return {
    word: platform === "windows" || platform === "macos",
    libreOffice: platform === "windows" || platform === "macos" || platform === "linux",
  };
}
