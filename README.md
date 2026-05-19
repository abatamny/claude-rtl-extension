# Claude.ai RTL Fix — Edge Extension

> ⚡ Vibe coded with [Claude](https://claude.ai)

A Microsoft Edge browser extension that fixes Right-to-Left (RTL) text direction on [Claude.ai](https://claude.ai) for Arabic and Hebrew users.

## The Problem

Claude.ai defaults all text to LTR (Left-to-Right), which breaks the reading and writing experience for Arabic and Hebrew speakers. The chat input box types in the wrong direction, and AI responses containing Arabic or Hebrew text render incorrectly.

## What It Does

- **Auto-detects** Arabic and Hebrew text in both the chat input and conversation messages
- **Switches direction to RTL** automatically — no manual toggling needed
- **Handles mixed content** correctly: English words, numbers, code, and math expressions inside Arabic/Hebrew text stay LTR (handled by the browser's Unicode Bidirectional Algorithm)
- **Keeps code blocks LTR** always, regardless of surrounding language
- **Works with streaming responses** as Claude types out its reply
- **Survives SPA navigation** between conversations without needing a page reload
- **Enable/disable toggle** via the extension popup

## How It Works

The extension uses a character-ratio heuristic: if 25% or more of the letter characters in a paragraph are Arabic or Hebrew Unicode codepoints, it sets `dir="rtl"` on that element. Otherwise it sets `dir="auto"` and lets the browser's built-in Unicode Bidi Algorithm handle the rest.

A `MutationObserver` watches for new message nodes (new responses, streaming updates). A separate `input` event listener handles direction changes while typing. These two paths are intentionally kept separate to avoid feedback loops.

## Files

```
claude-rtl-extension/
├── manifest.json       # Extension manifest (Manifest V3)
├── content.js          # Core logic: detection, direction stamping, observer
├── styles.css          # CSS: RTL defaults, code block LTR enforcement
├── popup.html          # Extension popup UI
├── popup.js            # Popup toggle logic
├── icons/              # Extension icons (16, 48, 128px)
└── generate-icons.js   # Script used to generate the icons (Node.js)
```

## Installation (Developer Mode)

1. Clone or download this repo
2. Open Edge and go to `edge://extensions/`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the `claude-rtl-extension` folder
6. Navigate to [claude.ai](https://claude.ai) and start typing in Arabic or Hebrew

## Browser Support

Built for **Microsoft Edge** (Manifest V3). Should also work in **Chrome** without modification.

---

*This extension was vibe coded with Claude — an AI helping fix its own website for RTL users.*
