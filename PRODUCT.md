# Product Contract

Visual Agent Map is evolving into a thinking environment with multiple complementary experiences.

## Core promise

Start with a question. Use AI to explore, challenge, connect, research and synthesize without giving up human control.

## Human and AI roles

- AI drives exploration.
- Humans steer direction.
- AI may propose, connect, challenge, research and synthesize.
- AI must not silently decide for the user, hide uncertainty, or overwrite the user's thinking without an explicit review or save step.

## Product model

The Obsidian plugin is one product shell with multiple experiences. Visual Map and Coffee Tables are experiences, not separate application cores. Future experiences should follow the same boundary.

Each experience:
- owns its interaction model and view state;
- uses shared AI, context, storage and navigation services where practical;
- can exchange durable thinking artifacts with other experiences;
- must not reach directly into another experience's private implementation.

## Shared-core invariants

Heavy resources are shared. Do not create one AI runtime, vault index or background watcher per experience.

Prefer:
- install many, load one;
- deferred views;
- plugin-level shared services;
- event-driven work over polling;
- explicit context budgets;
- durable Markdown for user-owned output.

## Cross-experience handoff

Experiences exchange `ThinkingArtifact` values through the shared experience router. Handoffs describe meaning (question, insight, argument, evidence, disagreement, conclusion, synthesis or decision), not another view's internal state.

## Safety against architecture drift

A feature is not complete if it requires:
- importing another experience's view internals;
- duplicating a shared AI runtime or vault-wide index;
- adding product orchestration back into `main.ts`;
- bypassing review/save boundaries for AI-generated user content.

`main.ts` is the composition root. It should register views, commands and shared services, not own feature logic.
