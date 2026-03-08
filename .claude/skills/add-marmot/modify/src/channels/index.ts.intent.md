# Intent: src/channels/index.ts modifications

## What changed
Added a single import line for the Marmot channel module to trigger self-registration.

## Key sections
- Added `import './marmot.js';` with a `// marmot` comment, following the alphabetical pattern of other channels
- The import triggers `registerChannel('marmot', factory)` in marmot.ts as a module side effect

## Invariants
- All existing channel imports (commented or uncommented) remain unchanged
- New import is placed alphabetically between gmail and slack comments
- No other changes to this file

## Must-keep
- All existing channel comment placeholders
- All existing channel imports
