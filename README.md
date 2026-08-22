# Zotero Instant Cite

Zotero Instant Cite searches scholarly and library catalogues from inside Zotero. A result can be added to the library or inserted into the active Word or LibreOffice document without opening a browser.

## What it does

The search window accepts titles, authors, DOI values, PMID values, ISBN values, and supported legal identifiers. Results from several sources are merged with records already held in Zotero. The plugin detects duplicates, can repair DOI metadata, and gives Zotero items priority when the same work appears more than once.

`Add to Library` saves the selected records. `Add & Cite Selected` also sends them to the active word-processor integration. Menu commands are available under `Tools`, with English and Romanian interface text.

## Installation

Download `zotero-instant-cite-0.6.11.xpi` from the latest release. In Zotero, open `Tools > Plugins`, select `Install Add-on From File`, and choose the XPI.

The current release supports Zotero 7, 8, and 9.

## Development

Install Node.js, clone the repository, and run `npm ci`. Use `npm test` for the Vitest suite and `npm run build` to create the XPI. The test suite covers query detection, result ranking, duplicate handling, DOI repair, Zotero integration, and the Word and LibreOffice shortcuts.

## License

Zotero Instant Cite is released under the MIT License. See [LICENSE](LICENSE).
