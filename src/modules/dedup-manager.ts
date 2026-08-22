/**
 * Dedup / merge manager — fuses multiple Zotero items into one.
 *
 * The user selects 2+ items in the search dialog (all sourced from local Zotero),
 * picks a master, and we:
 *   1. Fill missing master fields from secondaries (no overwrites)
 *   2. Save the enriched master
 *   3. Call Zotero.Items.merge — moves attachments/notes/tags to master,
 *      adds dc:replaces relations, trashes secondaries
 *
 * The dc:replaces relation is what makes Word docs auto-redirect on Refresh:
 * the CSL processor follows the chain from a trashed item to the new master.
 *
 * Manual override mode — no automatic blocking on author/DOI mismatch.
 * The user is the domain expert; warnings are non-blocking hints only.
 */

/** Fields that are commonly populated and worth reconciling across items. */
const RECONCILE_FIELDS = [
  "DOI", "ISBN", "ISSN", "url", "abstractNote", "publicationTitle",
  "publisher", "place", "edition", "volume", "issue", "pages",
  "journalAbbreviation", "language", "callNumber", "rights",
  "court", "docketNumber", "history", "section", "code",
];

/** Heuristic score — higher = better master candidate */
export function scoreItemForMaster(item: Zotero.Item): number {
  let score = 0;

  // Populated fields
  for (const field of RECONCILE_FIELDS) {
    try {
      const val = item.getField(field as any);
      if (val && String(val).trim()) score += 10;
    } catch { /* unsupported field for this item type */ }
  }

  // Title length (more complete title = better)
  const title = item.getField("title") as string;
  if (title && title.length > 20) score += 5;

  // Authors
  const creators = item.getCreators();
  score += Math.min(creators.length, 10) * 3;

  // Attachments (especially PDFs)
  for (const attId of item.getAttachments()) {
    const att = Zotero.Items.get(attId);
    if (!att) continue;
    if (att.attachmentContentType === "application/pdf") score += 30;
    else score += 5;
  }

  // Notes
  score += item.getNotes().length * 4;

  // Tags
  score += item.getTags().length * 2;

  // Collections
  score += item.getCollections().length * 3;

  return score;
}

/** Fill missing fields on master from the first secondary that has them populated. */
export async function reconcileFields(master: Zotero.Item, secondaries: Zotero.Item[]) {
  let changed = false;

  for (const field of RECONCILE_FIELDS) {
    let masterVal: string;
    try {
      masterVal = String(master.getField(field as any) || "").trim();
    } catch {
      continue; // field not valid for master's item type
    }
    if (masterVal) continue; // already populated, never overwrite

    for (const sec of secondaries) {
      try {
        const secVal = String(sec.getField(field as any) || "").trim();
        if (secVal) {
          master.setField(field as any, secVal);
          changed = true;
          break;
        }
      } catch { /* not valid for this secondary's type */ }
    }
  }

  // Reconcile creators — if master has none, copy from first secondary that has any
  if (master.getCreators().length === 0) {
    for (const sec of secondaries) {
      const creators = sec.getCreators();
      if (creators.length > 0) {
        for (const c of creators) {
          master.setCreator(master.getCreators().length, c);
        }
        changed = true;
        break;
      }
    }
  }

  // Reconcile abstract — same rule via abstractNote already in RECONCILE_FIELDS,
  // but also fill `extra` if master lacks identifier markers (PMID, OpenAlex, etc.)
  let masterExtra = "";
  try { masterExtra = String(master.getField("extra") || ""); } catch { /* */ }
  const extraLines = new Set(masterExtra.split("\n").map(l => l.trim()).filter(Boolean));
  for (const sec of secondaries) {
    let secExtra = "";
    try { secExtra = String(sec.getField("extra") || ""); } catch { /* */ }
    for (const line of secExtra.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      // Only copy lines that look like identifier markers ("PMID: 12345", "ECLI: ...")
      if (/^[A-Z][A-Z0-9-]+:\s*\S/.test(t) && !extraLines.has(t)) {
        extraLines.add(t);
        changed = true;
      }
    }
  }
  if (changed) {
    try {
      master.setField("extra", Array.from(extraLines).join("\n"));
    } catch { /* */ }
  }

  if (changed) {
    await master.saveTx();
  }
}

/**
 * Perform the full merge: reconcile fields → save master → call Zotero.Items.merge.
 * Returns the merged master item.
 *
 * The Zotero.Items.merge call:
 * - Adds `dc:replaces` relations from secondaries to master (used by CSL on Refresh)
 * - Moves child attachments/notes from secondaries under master
 * - Adds master to the union of all collections
 * - Trashes the secondaries (NOT permanently deleted)
 */
export async function mergeItems(master: Zotero.Item, secondaries: Zotero.Item[]): Promise<Zotero.Item> {
  if (secondaries.length === 0) return master;

  Zotero.log("[InstantCite] Merging " + secondaries.length + " items into: " + master.getField("title"));

  // 1. Fill master gaps from secondaries before merge wipes them
  await reconcileFields(master, secondaries);

  // 2. Union of collections — Zotero.Items.merge in some versions doesn't union
  //    collection memberships. Do it explicitly.
  const masterCollections = new Set(master.getCollections());
  let collectionsChanged = false;
  for (const sec of secondaries) {
    for (const collId of sec.getCollections()) {
      if (!masterCollections.has(collId)) {
        masterCollections.add(collId);
        collectionsChanged = true;
      }
    }
  }
  if (collectionsChanged) {
    master.setCollections(Array.from(masterCollections));
    await master.saveTx();
  }

  // 3. Union of tags
  const masterTags = new Set(master.getTags().map(t => t.tag));
  let tagsChanged = false;
  for (const sec of secondaries) {
    for (const t of sec.getTags()) {
      if (!masterTags.has(t.tag)) {
        master.addTag(t.tag, t.type);
        masterTags.add(t.tag);
        tagsChanged = true;
      }
    }
  }
  if (tagsChanged) {
    await master.saveTx();
  }

  // 4. Standard Zotero merge API — handles relations + trashes secondaries
  const merge = (Zotero.Items as any).merge;
  if (typeof merge === "function") {
    await merge.call(Zotero.Items, master, secondaries);
  } else {
    // Fallback: manual relation + trash for older Zotero versions
    Zotero.log("[InstantCite] Zotero.Items.merge unavailable — using manual fallback");
    await fallbackMerge(master, secondaries);
  }

  Zotero.log("[InstantCite] Merge complete. Master id=" + master.id);
  return master;
}

/** Manual fallback when Zotero.Items.merge is unavailable */
async function fallbackMerge(master: Zotero.Item, secondaries: Zotero.Item[]) {
  const masterURI = Zotero.URI.getItemURI(master);

  for (const sec of secondaries) {
    // Move child attachments to master
    for (const attId of sec.getAttachments()) {
      const att = Zotero.Items.get(attId);
      if (!att) continue;
      try {
        att.parentID = master.id;
        await att.saveTx();
      } catch (e) {
        Zotero.log("[InstantCite] Failed to move attachment " + attId + ": " + e);
      }
    }

    // Move child notes to master
    for (const noteId of sec.getNotes()) {
      const note = Zotero.Items.get(noteId);
      if (!note) continue;
      try {
        note.parentID = master.id;
        await note.saveTx();
      } catch (e) {
        Zotero.log("[InstantCite] Failed to move note " + noteId + ": " + e);
      }
    }

    // Add dc:replaces relation — secondary -> master
    try {
      sec.addRelation("dc:replaces", masterURI);
      await sec.saveTx();
    } catch (e) {
      Zotero.log("[InstantCite] Failed to add dc:replaces relation: " + e);
    }

    // Trash secondary
    try {
      sec.deleted = true;
      await sec.saveTx();
    } catch (e) {
      Zotero.log("[InstantCite] Failed to trash secondary: " + e);
    }
  }
}
