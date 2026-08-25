# Architecture

This document records the intended system boundaries. Only the HTTP application and health route are implemented at this stage; the integrations described below are future layers, not active connections.

## Layers

1. **Communication channels** — adapters will translate messages from the selected pilot channel into a common internal format and send replies back. Instagram, WhatsApp, Facebook and Telegram are not connected yet.
2. **Order core** — domain logic will own customers, menu references, carts, totals, fulfilment details and order-state transitions. It must calculate prices deterministically and must not rely on a language model for authoritative order data.
3. **Database** — a future persistence layer will store channel identities, conversations, payment-to-order links, idempotency data and delivery state. No database has been selected or added yet.
4. **Payment provider** — a future adapter for one selected provider will create payment sessions and accept verified payment events. SumUp sandbox is the first candidate. Customer messages will never count as proof of payment. No payment connection or flow exists yet.
5. **Poster** — the read-only adapter now verifies the separate `sushi-planet-bot.joinposter.com` test account and reads account settings, menu identifiers and per-spot prices. Order submission is not implemented and no Poster data has been created or changed. A future write path will submit each confirmed paid order exactly once; the restaurant's production account is not connected.
6. **Event journal** — a future append-only record will capture important order, payment, integration and handoff events for support and auditing. It will avoid card data and unnecessary personal data.

The existing ChoiceQR website remains separate from this application and is paused as an integration option unless direct Poster API use proves unsuitable. External adapters should depend on stable interfaces exposed by the order core so that channel, payment and POS concerns do not leak into domain rules.
