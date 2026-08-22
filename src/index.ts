import Addon from "./addon";
import * as hooks from "./hooks";

// Register global addon instance
if (!Zotero.InstantCite) {
  const addon = new Addon();
  Zotero.InstantCite = addon;
  // Expose lifecycle hooks for bootstrap.js
  (Zotero.InstantCite as any).hooks = hooks;
}
