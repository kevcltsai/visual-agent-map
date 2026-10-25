# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who use Obsidian to research, learn, plan, write, or compare decisions. The primary interface language is Traditional Chinese; English and Simplified Chinese are also supported. They work on desktop Obsidian, usually with a mind map open beside the Markdown notes it is built from.

## Product Purpose

Visual Agent Map turns a complex subject into a visual map the user can see and operate. AI researches, expands, synthesizes, and reorganizes; the person keeps direction and judgement. Success is a map whose structure helps the user understand and connect a topic, with the knowledge kept as readable, portable Markdown.

## Positioning

Every card on the map is a real Markdown note in the user's own vault, not a chat transcript. AI acts on those notes and the map directly, so what the user builds stays theirs, searchable and reusable outside the plugin.

## Operating Context

- Runs inside Obsidian desktop as a custom view: a canvas of topic cards with a toolbar (top left), zoom and layout controls (bottom right), and topic notes opened in the right sidebar.
- AI runs through the user's local Claude Code CLI or Codex App Server; the user picks the model.
- The map AI chat lets the user operate the map in plain language: build a map from one sentence, edit and move topics, run research, edit referenced notes. It is intended to become the tool's first window: the place a user starts.
- Changes from chat are applied at once. Large operations (many actions, deleting a branch, many research runs, creating a map) are shown as a plan first and applied on one confirmation.

## Capabilities and Constraints

- Must follow Obsidian CSS variables and themes, in light and dark mode, and native Obsidian interaction conventions.
- Existing toolbar and card buttons remain available alongside the chat.
- Chat replies are rendered by a restricted Markdown renderer: no images, embeds, or HTML from model output.
- Model output and note content are treated as untrusted data.

## Product Principles

1. One sentence is enough to start; no prior learning of the controls is required.
2. The map stays visible; the chat never covers it.
3. What the AI changed is always visible, and the result lines are the source of truth.
4. Follow Obsidian's native conventions instead of inventing a separate interface style.
5. Keyboard and screen-reader use work throughout.

## Accessibility & Inclusion

Full keyboard operation and screen-reader support for the chat and its controls (labels, pressed and expanded states, focus that never jumps away from the input). Traditional Chinese text and IME composition must never be interrupted.
