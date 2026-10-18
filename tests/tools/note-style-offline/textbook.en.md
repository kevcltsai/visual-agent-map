The detail is a textbook-style article for a beginner, rendered in Obsidian. Use connected prose that takes the reader from "why this matters" to "have I learned it", covering the five parts below in order. Start each part with one level-three heading (###); name the headings naturally for the topic instead of copying the part names:

1. Why it matters: what problem this topic solves and how it relates to the reader, in 2–3 paragraphs.
2. Concepts: explain the core concepts and how they relate in plain language; introduce a technical term only when needed and explain it right away.
3. A worked example: one example followed from start to finish (with real numbers or steps) that ties the concepts together, so the reader sees how they are used.
4. Common misconceptions: the mistakes beginners make most often, with the correct understanding.
5. Self-check: 2–4 questions the reader can use to test their understanding, with short hints for the answers if useful.

Writing requirements:
1. Prefer flowing paragraphs; do not chop the content into fragmentary bullets. Use lists only for truly parallel items.
2. At most 7 level-three headings (###) in the whole piece; use level-four headings (####) only when really needed.
3. At most 3 callouts (`> [!summary]`, `> [!warning]`, `> [!tip]`, `> [!example]`, `> [!question]`) in the whole piece, reserved for the one or two sentences most worth remembering; write everything else as plain paragraphs.
4. Use a Markdown table only when comparing two or more options or dimensions.
5. A process, cause and effect, or dependencies between steps may use one ```mermaid``` flowchart (at most 12 nodes; TD by default, LR only for a short chain of at most 4 nodes); change over time may use one ```mermaid``` timeline. Use only the flowchart and timeline mermaid types, and only when the diagram makes the content easier to understand, never for looks.
6. Mermaid uses only text nodes and arrows; never use click, HTML tags, %%{}%% configuration, URLs, images or style directives. Wrap node text in double quotes when it contains parentheses or punctuation.
7. Numbers in charts and tables must come from the provided sources and findings; never invent or estimate them.
8. Do not output syntax Obsidian does not support (for example :::, <details>, custom HTML).
9. The detail is for the reader: do not write internal IDs (of nodes, evidence, sources or reports), review comments, or remarks about the draft or the research process itself.
10. Headings in the detail start at level-three headings (###) and go down one level at a time (####); never skip a level or use # or ##.
11. Do not write a part that has no reliable material; write less rather than padding with an empty paragraph such as "No new content this time".
