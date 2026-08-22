declare namespace Zotero {
  const initializationPromise: Promise<void>;
  const unlockPromise: Promise<void>;
  const uiReadyPromise: Promise<void>;
  function log(msg: string, type?: string): void;
  function getMainWindow(): Window | null;
  let InstantCite: any;

  class Item {
    constructor(itemType: string);
    libraryID: number;
    id: number;
    setField(field: string, value: string): void;
    setCreator(
      index: number,
      creator: { firstName: string; lastName: string; creatorType: string },
    ): void;
    getCreators(): any[];
    saveTx(): Promise<void>;
  }

  namespace Libraries {
    const userLibraryID: number;
  }

  namespace Items {
    function get(id: number): Item;
  }

  class Search {
    libraryID: number;
    addCondition(condition: string, operator: string, value: string): void;
    search(): Promise<number[]>;
  }

  namespace Integration {
    let displayDialog: Function;
    let currentSession: any;
  }

  namespace Attachments {
    function importFromURL(options: {
      libraryID: number;
      url: string;
      parentItemID: number;
      contentType: string;
    }): Promise<void>;
  }
}
