The learner pinned some cards. Pins (JSON array of {id, tier}): {{pins}}
Treat each pin as evidence of what the learner's goal really needs: cards that serve the same need as a card pinned higher may deserve a higher tier; cards inside or serving a branch pinned lower usually deserve lower. Cards that have nothing to do with a pin keep their tier.
When you set a card's tier because of a pinned card, add "anchor" with that pinned card's id to its item; otherwise leave "anchor" out or write null.
Items may then also have the form {"id": "...", "tier": "core|support|side", "anchor": "<pin id>" or null}.

