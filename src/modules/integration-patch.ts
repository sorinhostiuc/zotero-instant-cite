// Monkey-patch Zotero's citation dialog to use InstantCite instead
// When Word requests "Add Citation", we intercept displayDialog and show our UI

import { openSearchDialogForCitation, prepareSearchDialogForPendingCitation } from "./search-dialog";
import { isInterceptCitations } from "./preferences";
import { extractCitationItemIds, extractDocumentItemIds } from "./utils/document-priority";

let originalDisplayDialog: Function | null = null;
let originalAddCitation: Function | null = null;
let patchActive = false;

// Guards against rapid re-entry into addCitation (Word integration can fire duplicate calls)
let addCitationInProgress = false;

async function citeAndUpdateDocument(session: any, field: any) {
  const citations = await session.cite(field);
  if (!citations || citations.length === 0) return;

  if (session.data?.prefs?.delayCitationUpdates) {
    for (const citation of citations) {
      await session.writeDelayedCitation(citation.field, citation);
    }
    return;
  }

  return session.updateDocument(0 /* FORCE_CITATIONS_FALSE */, false, false);
}

/** Set of Zotero item IDs cited in the current Word document */
export let documentItemIds: Set<number> = new Set();

export function resetDocumentItemIds(seed?: Set<number>) {
  documentItemIds = new Set(seed ?? []);
}

export async function loadDocumentItemIdsFromCitationIO(
  io: any,
  options: { waitForFullScan?: boolean } = {},
): Promise<Set<number>> {
  const promise = io?._citationsByItemIDPromise ??
    io?.allCitedDataLoadedPromise?.then((result: unknown) => Array.isArray(result) ? result[1] : null);
  if (!promise || typeof promise.then !== "function" || options.waitForFullScan === false) {
    return documentItemIds;
  }

  try {
    const citationsByItemID = await promise;
    const ids = extractDocumentItemIds(citationsByItemID);
    resetDocumentItemIds(ids);
    if (typeof Zotero !== "undefined") {
      Zotero.log("[InstantCite] Document has " + documentItemIds.size + " cited items");
    }
  } catch (err) {
    if (typeof Zotero !== "undefined") {
      Zotero.log("[InstantCite] Failed to load document cited items: " + err);
    }
  }

  return documentItemIds;
}

export function patchCitationDialog() {
  if (patchActive) return;

  const integration = (Zotero as any).Integration;
  if (!integration || !integration.displayDialog) {
    Zotero.log("[InstantCite] Zotero.Integration.displayDialog not found, skipping patch");
    return;
  }

  // Patch 1: Intercept displayDialog to show InstantCite instead of native citation dialog
  originalDisplayDialog = integration.displayDialog;

  integration.displayDialog = async function (
    url: string,
    mode: string,
    io: any,
    windowType: string,
  ) {
    if (windowType === "citation" && isInterceptCitations()) {
      Zotero.log("[InstantCite] Intercepting citation dialog, mode=" + mode);
      try {
        resetDocumentItemIds(extractCitationItemIds(io?.citation?.citationItems));
        return await showInstantCiteForCitation(io);
      } catch (err) {
        Zotero.log("[InstantCite] Error in citation intercept: " + err);
        return originalDisplayDialog!.apply(this, arguments);
      }
    }
    return originalDisplayDialog!.apply(this, arguments);
  };

  // Patch 2: Make addCitation auto-edit when cursor is in existing citation field
  // Without this, Zotero shows "Replace this Zotero field?" prompt instead of editing
  patchAddCitationAutoEdit();

  patchActive = true;
  Zotero.log("[InstantCite] Citation dialog patch installed");
}

/**
 * Patch addCitation to behave like addEditCitation when cursor is in existing field.
 *
 * Zotero's addCitation() calls cite(null) → addField() which shows "Replace?" prompt.
 * But addEditCitation() calls cite(docField) which edits the existing citation.
 * We make addCitation check for existing field first, like addEditCitation does.
 */
function patchAddCitationAutoEdit() {
  try {
    const InterfaceProto = (Zotero as any).Integration?.Interface?.prototype;
    if (!InterfaceProto?.addCitation) {
      Zotero.log("[InstantCite] Integration.Interface.prototype.addCitation not found, skipping auto-edit patch");
      return;
    }

    originalAddCitation = InterfaceProto.addCitation;

    InterfaceProto.addCitation = async function () {
      if (!isInterceptCitations()) {
        return originalAddCitation!.apply(this, arguments);
      }

      // Guard: prevent re-entry while the current Word integration command is active.
      if (addCitationInProgress) {
        Zotero.log("[InstantCite] addCitation blocked: already in progress");
        return;
      }
      prepareSearchDialogForPendingCitation();
      addCitationInProgress = true;
      // Reset per-document state so the search dialog does not show stale
      // "already cited" badges left over from a previous document/session.
      resetDocumentItemIds();

      try {
        if (typeof this._session?.init !== "function") {
          Zotero.log("[InstantCite] addCitation fallback: session.init not available");
          return originalAddCitation!.apply(this, arguments);
        }

        await this._session.init(false, false);

        let docField = null;
        try {
          docField = await this._doc.cursorInField(this._session.data.prefs['fieldType']);
        } catch (err) {
          Zotero.log("[InstantCite] cursorInField failed, adding new citation: " + err);
        }
        if (!docField) {
          return citeAndUpdateDocument(this._session, null);
        }

        // Cursor in an existing field: edit via cite(docField). Do not fall back
        // to original addCitation here, because that can add/replace instead of
        // editing the selected citation.
        Zotero.log("[InstantCite] Cursor in existing field, auto-editing instead of replacing");
        try {
          const citsByItem = this._session.citationsByItemID;
          if (citsByItem) {
            resetDocumentItemIds(extractDocumentItemIds(citsByItem));
            Zotero.log("[InstantCite] Document has " + documentItemIds.size + " cited items");
          }
        } catch { /* ignore — session API may vary */ }
        return citeAndUpdateDocument(this._session, docField);
      } finally {
        addCitationInProgress = false;
      }
    };

    Zotero.log("[InstantCite] addCitation auto-edit patch installed");
  } catch (err) {
    Zotero.log("[InstantCite] Failed to install addCitation patch: " + err);
  }
}

export function unpatchCitationDialog() {
  if (!patchActive) return;

  if (originalDisplayDialog) {
    (Zotero as any).Integration.displayDialog = originalDisplayDialog;
    originalDisplayDialog = null;
  }

  if (originalAddCitation) {
    const InterfaceProto = (Zotero as any).Integration?.Interface?.prototype;
    if (InterfaceProto) {
      InterfaceProto.addCitation = originalAddCitation;
    }
    originalAddCitation = null;
  }

  addCitationInProgress = false;
  patchActive = false;
}

async function showInstantCiteForCitation(io: any): Promise<void> {
  return new Promise<void>((resolve) => {
    const safetyTimer = setTimeout(() => {
      if (typeof io.cancel === "function") io.cancel();
      resolve();
    }, 300000);

    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      resolve();
    };

    // Called by search-dialog when user clicks "Cite Selected"
    const acceptCitation = (citationItems: Array<Record<string, any>>) => {
      if (settled) {
        Zotero.log("[InstantCite] WARNING: acceptCitation called but session already settled! "
          + citationItems.length + " items DROPPED. This means cancel/close ran before cite completed.");
        return;
      }
      Zotero.log("[InstantCite] acceptCitation: " + citationItems.length + " items, ids=" + citationItems.map(i => i.id).join(","));
      try {
        io.citation.citationItems = citationItems;
        if (typeof io.accept === "function") io.accept();
      } finally {
        finish();
      }
    };

    // Called when dialog closes without accepting (cancel/close/escape)
    const cancelCitation = () => {
      if (!settled) {
        Zotero.log("[InstantCite] cancelCitation called");
        try {
          if (typeof io.cancel === "function") io.cancel();
        } finally {
          finish();
        }
        // Force-close green progress bar overlay
        try {
          setTimeout(() => {
            try {
              (Zotero as any).hideZoteroPaneOverlays?.();
            } catch { /* ignore */ }
            const mainWin = Zotero.getMainWindow();
            if (mainWin) {
              const overlay = mainWin.document.getElementById("zotero-overlay");
              if (overlay) (overlay as HTMLElement).style.display = "none";
            }
          }, 300);
        } catch { /* ignore */ }
      }
    };

    // Deep-copy existing citation items NOW before Zotero clears them
    const existingItems = (io?.citation?.citationItems ?? []).map((item: any) => ({ ...item }));

    try {
      openSearchDialogForCitation(io, existingItems, acceptCitation, cancelCitation);
    } catch (err) {
      clearTimeout(safetyTimer);
      if (typeof io.cancel === "function") io.cancel();
      resolve();
    }
  });
}
