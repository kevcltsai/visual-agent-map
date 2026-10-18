The detail is a knowledge page for a beginner, rendered in Obsidian. It has two parts: first a connected narrative that draws the reader into the topic, then the content sorted into the categories below.

Opening (lead-in): 2–4 flowing paragraphs with no heading at all, in this order: why the topic is worth learning and how it relates to the reader, then the core concepts in plain language (introduce a technical term only when needed and explain it right away), then one worked example followed from start to finish with real numbers or steps. A reader who reads only this part should already understand the gist.

Body: after the lead-in, use the level-three headings (###) below, with the heading text copied exactly and in this fixed order. Leave out a whole category that has no reliable material (no heading, and never write "No new content this time"):
### Core conclusions: Answer the research question directly, 3–5 points by default; give the conclusion first, then the reason. Do not repeat sentences the lead-in already said; write only the conclusions it did not cover.
### Key knowledge: The concepts, data, mechanisms and background needed to understand the conclusions.
### Evidence and sources: The facts and data that support the conclusions, with their sources; the source list is added to the end of this section automatically.
### Tradeoffs and limitations: Pros and cons of the options, when each applies, the risks, and the limits of this research.
### Open questions: Questions not yet verified or lacking data that are worth researching next.
### Update log: Add only one line saying what this page covers.

Closing: put common misconceptions in the category where they fit best, as one short `> [!warning]` callout in the form "beginners often think ..., but actually ...". Add a final short block at the very end, led by bold "**Self-check**" (no heading), with 2–3 questions the reader can use to test their understanding, optionally with a one-line hint.

Writing requirements:
1. Inside each category prefer short paragraphs (2–4 sentences each); use a list only when the content itself is a set of parallel items, and a Markdown table only when comparing two or more options or dimensions.
2. At most 7 level-three headings (###) in the whole piece; use level-four headings (####) only when really needed.
3. At most 3 callouts (`> [!summary]`, `> [!warning]`, `> [!tip]`, `> [!example]`, `> [!question]`) in the whole piece, reserved for the one or two sentences most worth remembering; write everything else as plain paragraphs.
4. A process, cause and effect, or dependencies between steps may use one ```mermaid``` flowchart (at most 12 nodes; TD by default, LR only for a short chain of at most 4 nodes); change over time may use one ```mermaid``` timeline. Use only the flowchart and timeline mermaid types, and only when the diagram makes the content easier to understand, never for looks.
5. Mermaid uses only text nodes and arrows; never use click, HTML tags, %%{}%% configuration, URLs, images or style directives. Wrap node text in double quotes when it contains parentheses or punctuation.
6. Numbers in charts and tables must come from the provided sources and findings; never invent or estimate them.
7. Do not output syntax Obsidian does not support (for example :::, <details>, custom HTML).
8. The detail is for the reader: do not write internal IDs (of nodes, evidence, sources or reports), review comments, or remarks about the draft or the research process itself.
9. Headings in the detail start at level-three headings (###) and go down one level at a time (####); never skip a level or use # or ##.
10. Do not write a part that has no reliable material; write less rather than padding with an empty paragraph such as "No new content this time".
