/**
 * Zotero InstantCite - Bootstrap entry point
 * Based on windingwind/zotero-plugin-template pattern (Zotero 7/8/9 compatible)
 */

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "chrome/content/"],
    ["locale", "__addonRef__", "en-US", rootURI + "chrome/locale/en-US/"],
    ["locale", "__addonRef__", "ro-RO", rootURI + "chrome/locale/ro-RO/"],
  ]);

  try {
    Services.scriptloader.loadSubScript(rootURI + "index.js");
    await Zotero.__addonInstance__.hooks.onStartup();
  } catch (e) {
    // Components.utils.reportError deprecated in newer Gecko — use console.error fallback
    try { Components.utils.reportError(e); } catch (_) { console.error("[InstantCite] Startup error:", e); }
    throw e;
  }
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.__addonInstance__?.hooks?.onMainWindowLoad({ window });
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks?.onMainWindowUnload({ window });
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.__addonInstance__?.hooks?.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
