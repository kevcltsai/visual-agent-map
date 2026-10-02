# Product Contract

Visual Agent Map is evolving into a thinking environment with multiple complementary experiences.

## Core promise

Help people think, and let valuable thinking compound into reusable knowledge.

AI may actively explore, challenge, connect, research, validate and synthesize. Humans steer direction, interpretation and final judgment. A good result is not just a polished answer; it should leave the user with clearer understanding and, when useful, durable knowledge they can revisit.

## Thinking jobs

The long-term product direction is organized around six thinking jobs:

- **Discover** — find directions, tensions and ideas worth exploring.
- **Understand** — build a structured understanding of a question and how its parts relate.
- **Challenge** — pressure-test a claim, position or proposal against strong opposition.
- **Validate** — test assumptions and claims against evidence.
- **Synthesize** — combine distributed evidence, viewpoints and disagreements into a coherent understanding.
- **Decide** — reason through alternatives, trade-offs, constraints and uncertainty.

This is a product-direction map, not a feature list. The current product implements **Visual Map** primarily for Understand and **Coffee Tables** primarily for Discover. Other thinking jobs are not current implementation claims.

## Human and AI roles

- AI drives useful work; humans steer direction.
- AI may propose, connect, challenge, research, validate and synthesize.
- AI output does not automatically become the user's position or decision.
- AI must not silently hide uncertainty or overwrite the user's thinking without an explicit review or save boundary.
- Do not require manual interaction merely to prove that the user is thinking; reading, comparing and absorbing can also be valid participation.

## Product model

The Obsidian plugin is one product shell with multiple experiences. Visual Map and Coffee Tables are experiences, not separate application cores. Future experiences should follow the same boundary.

Each experience:
- owns its interaction model and view state;
- uses shared AI, context, storage and navigation services where practical;
- can exchange structured thinking artifacts with other experiences;
- must not reach directly into another experience's private implementation.

## Shared-core invariants

Heavy resources are shared. Do not create one AI runtime, vault index or background watcher per experience.

Prefer:
- register many experiences, initialize heavy work on demand;
- deferred views;
- plugin-level shared services;
- event-driven work over polling;
- explicit context budgets;
- durable Markdown for user-owned output.

Shared abstractions should follow demonstrated needs across experiences rather than pre-building a universal thinking framework.

## Knowledge compounding

Valuable thinking should not disappear when one interaction ends.

When an experience produces knowledge that remains useful later, prefer clean, readable, editable and reusable Markdown that can be searched, linked and reused by people or future LLM/agent workflows. This can include important context, evidence, assumptions, insights, disagreements, synthesis, decisions and unresolved questions.

Do not persist every UI state, debug trace or raw runtime artifact merely because it exists. Markdown is a user-owned knowledge base, not a dumping ground.

## Cross-experience handoff

The current implementation exchanges versioned `ThinkingArtifact` values through the shared experience router. Handoffs carry semantic meaning and provenance, not another view's private state. User-owned durable results remain Markdown in the vault.

The product direction also includes a hidden, target-aware **Reframing Layer**: the same source insight may need to become a research question for Understand, a claim for Challenge, a testable hypothesis for Validate, or decision context for Decide. Reframing must preserve provenance, uncertainty and important conditions.

The Reframing Layer is a product-direction contract, not a claim that a generic reframing engine is already implemented. Current handoffs remain explicit experience-specific conversions until that capability is built and verified.

## Safety against architecture drift

A feature is not complete if it requires:
- importing another experience's view internals;
- duplicating a shared AI runtime or vault-wide index;
- adding experience-internal UI or business logic back into `main.ts`;
- bypassing review/save boundaries for AI-generated user content;
- presenting future Intent as already implemented product behavior.

`main.ts` is the composition root. It may coordinate plugin lifecycle, navigation and cross-experience handoffs, but experience-internal UI and business logic belong under `experiences/`.
