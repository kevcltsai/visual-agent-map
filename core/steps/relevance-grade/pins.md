The learner pinned some cards. Pins (JSON array of {id, tier}): {{pins}}
Pinned cards carry "pinned" in the cards below. A pinned tier is final: never output a pinned card. Only cards marked "pinned" may be left out of "items". Every other card whose parentId is not null must appear exactly once in "items", with its own tier. A card with a bound is not a pinned card: even when its bound leaves a single possible tier, it must still appear in "items", with a tier inside the bound. Write each id only for its own card.
Treat each pin as evidence of what the learner's goal really needs: cards that serve the same need as a card pinned higher may deserve a higher tier; cards inside or serving a branch pinned lower usually deserve lower.
Stay within each card's bounds.
Cards with a bound that you must still include: {{mustInclude}}
Bounds (a bound is not a pin; JSON array; "min" and "max" are the lowest and highest tier the card may have, core above support above side; a card not listed has no bound): {{bounds}}
When you set a card's tier because of a pinned card, add "anchor" with that pinned card's id to its item; otherwise leave "anchor" out or write null.
Items may then also have the form {"id": "...", "tier": "core|support|side", "anchor": "<pin id>" or null}.
