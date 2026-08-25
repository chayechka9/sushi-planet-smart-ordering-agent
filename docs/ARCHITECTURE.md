# Architecture

This document records the intended system boundaries. The HTTP application, health route, order core, local order/payment persistence and dependency-injected local payment-notification flow are implemented; external channel, SumUp verification and Poster write connections are not active.

## Layers

1. **Communication channels** — adapters will translate messages from the selected pilot channel into a common internal format and send replies back. Instagram, WhatsApp, Facebook and Telegram are not connected yet.
2. **Order core** — domain logic will own customers, menu references, carts, totals, fulfilment details and order-state transitions. It must calculate prices deterministically and must not rely on a language model for authoritative order data.
3. **Database** — file-backed SQLite now stores the local order-to-SumUp-payment link. A versioned schema enforces unique order, checkout, checkout-reference and successful-transaction identities; the repository atomically commits the verified `paid` transition for both records. Channel identities, conversations, delivery state and the wider event journal remain future storage work.
4. **Payment provider** — the transport-neutral SumUp webhook contract, local application service and optional Fastify route now coordinate an injected checkout verifier with atomic SQLite reconciliation. The verifier interface has no HTTP implementation, and the route is not registered by the server bootstrap without explicit dependencies; no public URL or external SumUp connection exists. Customer messages and webhook bodies alone never count as proof of payment.
5. **Poster** — the read-only adapter now verifies the separate `sushi-planet-bot.joinposter.com` test account and reads account settings, menu identifiers and per-spot prices. Order submission is not implemented and no Poster data has been created or changed. A future write path will submit each confirmed paid order exactly once; the restaurant's production account is not connected.
6. **Event journal** — a future append-only record will capture important order, payment, integration and handoff events for support and auditing. It will avoid card data and unnecessary personal data.

The existing ChoiceQR website remains separate from this application and is paused as an integration option unless direct Poster API use proves unsuitable. External adapters should depend on stable interfaces exposed by the order core so that channel, payment and POS concerns do not leak into domain rules.
