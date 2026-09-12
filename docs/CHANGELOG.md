# Sushi Planet Smart Ordering Agent — Changelog

Здесь хранится подробная техническая история завершённых изменений. README
описывает проект и его границы, а PLAN — крупные этапы и их высокий уровень.

## 12 сентября 2026

### Исправлена загрузка локального environment в OpenAI smoke CLI

- Публичный wrapper `src/scripts/run-openai-smoke.ts` теперь первым импортирует
  `dotenv/config`, следуя уже используемой в `src/server.ts` и внешних scripts
  конвенции. Поэтому будущий отдельно разрешённый запуск `openai:smoke` сможет
  получить локальные `OPENAI_RUNTIME_ENABLED` и `OPENAI_API_KEY` из `.env` до
  вызова существующего runner.
- Runtime gate, обязательный `--confirm-one-request`, synthetic данные,
  временная SQLite с cleanup в `finally`, one-request limit, отсутствие retry и
  безопасный summary не менялись. Runner не подключался к server, routes,
  каналам, SumUp, Poster, ChoiceQR или production wiring.
- Существующий synthetic test статически читает wrapper и подтверждает точный
  side-effect import `dotenv/config`; wrapper, runner и реальная сеть тестом не
  запускаются.
- `.env` и `.sumup-e2e` не открывались, не выводились и не изменялись. Реальный
  `openai:smoke`, OpenAI request и другие внешние запросы не выполнялись.
- Проверки: `npm test` — 289 тестов в 29 файлах прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — launch-wiring defect исправлен без изменения остальных
  safety boundaries.
- Commit: текущий коммит, содержащий эту запись.

### Добавлен controlled OpenAI smoke-runner без фактического запуска

- Добавлены отдельные `src/scripts/run-openai-smoke.ts` и npm-команда
  `openai:smoke`. Runner повторно использует существующую цепочку
  `createOpenAIConversationRuntime → AIConversationLayerService`, не дублируя
  transport, interpreter или deterministic conversation core.
- До единственного service-вызова обязательны одновременно точный
  `OPENAI_RUNTIME_ENABLED=true`, локальный `OPENAI_API_KEY` и единственный
  аргумент `--confirm-one-request`. Без любого gate возвращается только
  безопасный error summary, provider fetch не выполняется; enabled runtime без
  key даёт безопасный `configuration_error`.
- Для будущего разрешённого запуска используются только фиксированные
  synthetic channel/user/conversation/message IDs и сообщение `покажи меню`.
  Existing local conversation service получает пустой synthetic menu и новую
  SQLite в системной временной директории; store закрывается, а директория
  удаляется в `finally`. Checkout и delivery dependencies являются локальными
  блокирующими заглушками.
- Fetch обёрнут one-shot guard: допускается не более одной provider attempt,
  retry, циклов и автоматического повторного запуска нет. Вывод содержит только
  success/error, command type либо clarification/error reason и факт provider
  attempt; key, Authorization, request/response body, исходный текст и IDs не
  выводятся.
- Synthetic tests с injected fake fetch подтверждают блокировку без runtime
  gate, confirmation и key, ровно один fetch при успешной конфигурации,
  отсутствие retry после network error, отсутствие global fetch, секрета в
  summary, checkout-вызова и остаточного временного state. Статическая проверка
  подтверждает отдельную npm-команду и отсутствие wiring к `src/server.ts`,
  SumUp webhook, Poster handoff или `createApp`.
- `src/server.ts`, HTTP routes, channels, production wiring, deterministic core,
  SumUp, Poster, ChoiceQR, checkout и payment flows не менялись и не
  подключались. `.env`, `.sumup-e2e`, реальные credentials, customer/card data
  и новые dependencies не открывались и не добавлялись. `PLAN.md` не менялся,
  потому что крупный этап не завершён.
- Реальный runner не запускался, реальный OpenAI request и любые другие внешние
  запросы не выполнялись. Первый запуск по-прежнему требует отдельного явного
  разрешения непосредственно перед provider action.
- Проверки: `npm test` — 289 тестов в 29 файлах прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — локальная bounded smoke boundary подготовлена; первый
  controlled provider request и любое ordinary-server/production подключение
  остаются отдельными неподтверждёнными этапами.
- Commit: текущий коммит, содержащий эту запись.

### Добавлена disabled-by-default OpenAI runtime composition

- Добавлена явная factory `createOpenAIConversationRuntime`, которая только
  после успешного opt-in собирает существующую цепочку `OpenAIConfig →
  OpenAIResponsesHttpTransport → OpenAIConversationInterpreter →
  AIConversationLayerService`. Существующие deterministic
  `conversationAgent` и state-store read port принимаются через injection;
  order/payment/checkout/Poster logic не дублируется и не меняется.
- Новый config gate `OPENAI_RUNTIME_ENABLED` по умолчанию отключён. Отсутствие
  флага, явное `false` и наличие одного `OPENAI_API_KEY` возвращают disabled
  runtime до загрузки credentials и создания transport. Только точное
  case-insensitive `true` включает composition; enabled runtime без key либо с
  невалидной OpenAI-конфигурацией завершается фиксированной типизированной
  `invalid_configuration` ошибкой без значения настройки или секрета.
- `.env.example` документирует только пустой key и безопасные defaults:
  runtime `false`, модель `gpt-5.6-luna`, reasoning `high`. Composition не
  подключена к `src/server.ts`, `createApp` или HTTP route и сама не выполняет
  provider request.
- Synthetic tests используют injected fake fetch и deterministic dependencies.
  Они подтверждают default/explicit disabled, отсутствие требования key и
  fetch, запрет auto-enable от key, безопасную ошибку enabled-without-key,
  успешную command composition, default model/reasoning, существующий
  `store: false`, отсутствие key в body и неизменный health-only ordinary
  server с отсутствующим AI route. Реальный global fetch не вызывается.
- README и `docs/ARCHITECTURE.md` фиксируют новую локальную границу. `PLAN.md`,
  deterministic conversation core, социальные каналы, SumUp, Poster, ChoiceQR,
  checkout, payment и production wiring не менялись и не подключались.
- `.env` и `.sumup-e2e` не открывались; API keys, secrets, customer/card data,
  реальные provider responses и новые dependencies не добавлялись. Реальные
  OpenAI и другие внешние запросы не выполнялись.
- Проверки: `npm test` — 283 теста в 28 файлах прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — локальная opt-in composition реализована; первый
  controlled provider request и любое ordinary-server/production подключение
  остаются отдельными явно разрешаемыми этапами.
- Commit: текущий коммит, содержащий эту запись.

### Добавлен локальный OpenAI Responses API HTTP transport

- `OpenAIResponsesHttpTransport` реализует существующий
  `OpenAIConversationResponseTransport`: выполняет ровно один
  `POST https://api.openai.com/v1/responses`, передаёт без преобразований
  существующие `model`, `reasoning`, `instructions`, `input`, `text.format` и
  обязательный `store: false`. API key используется только в Bearer header;
  в request body и безопасные ошибки он не попадает.
- Transport имеет общий ограниченный timeout для запроса и разбора ответа,
  использует `AbortController` и не выполняет retry. Non-2xx provider body не
  читается; HTTP failure, network error, timeout и invalid JSON преобразуются
  в фиксированные типизированные ошибки без provider response или исходного
  exception message.
- Fetch boundary инъецируется. Synthetic tests проверяют точный URL, метод,
  headers и полный body, успешный JSON, все четыре failure path, отсутствие
  утечки key, отсутствие retry и запрет обращения к реальному global fetch.
- README и `docs/ARCHITECTURE.md` фиксируют новую локальную границу. Transport
  не подключён к обычному `src/server.ts`, interpreter/runtime или production;
  реальные OpenAI API, social, SumUp, Poster, ChoiceQR, checkout и payment
  запросы не выполнялись. Deterministic conversation core и `PLAN.md` не
  менялись; новые dependencies не добавлялись.
- `.env` и `.sumup-e2e` не открывались; secrets, customer/card data и unrelated
  changes не добавлялись.
- Проверки: `npm test` — 276 тестов в 27 файлах прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — bounded HTTP transport реализован и проверен локально;
  controlled runtime composition и первый отдельно разрешённый provider call
  остаются следующими неподтверждёнными этапами.
- Commit: текущий коммит, содержащий эту запись.

### Устранены подтверждённые замечания AI-layer аудита

- OpenAI Responses strict schema теперь объявляет `additionalProperties:
  false` для каждого object node, включает каждое property в `required` и
  представляет неактуальные command arguments, `command` или `reason` через
  совместимые nullable-типы. Strict envelope нормализуется в существующий
  `ConversationAgentCommand` или `needs_clarification`, после чего по-прежнему
  проходит provider-neutral runtime allowlist; extra и authoritative price,
  total, availability, delivery fee, payment/order status и Poster fields
  отклоняются.
- Добавлен выполняемый локально recursive schema-contract guard. Он проверяет
  object nodes, exact required/property sets, `additionalProperties: false` и
  nullable type/union shape; synthetic tests также доказывают отказ на
  нарушенных schema fixtures. Реальный OpenAI API не вызывался.
- Responses-shaped request boundary расширен literal-полем `store: false`;
  тест фиксирует его обязательное значение вместе с прежними model/reasoning и
  safe-context ограничениями. Request body, API key, customer text и provider
  response не логируются.
- AI orchestration до interpreter проверяет identity и существующий message ID.
  Для новых AI-created processed messages сохраняются только SHA-256 fingerprint
  NFC/whitespace-нормализованного текста, canonical command и уже существующий
  deterministic response; raw message text не сохраняется. Совпадающий
  duplicate возвращает cached result, другой текст даёт `message_conflict`, а
  другая identity — `invalid_identity`, во всех случаях без interpreter call.
- SQLite state JSON сохраняет новые optional processed-message fields без новой
  table migration; decoder остаётся совместимым со старыми записями, где этих
  полей нет. Tests подтверждают duplicate/conflict/identity guards после
  закрытия и повторного открытия SQLite; существующая command-fingerprint
  защита deterministic conversation core сохранена.
- README и `docs/ARCHITECTURE.md` исправляют доказанный drift: один успешный
  100-cent SumUp sandbox webhook → server verification → `PAID` → одна
  `SUCCESSFUL` transaction → local `paid` → duplicate указан только как
  историческое доказательство. Новый текущий запуск, Poster prepayment/точное
  сохранение всех полей и kitchen visibility остаются неподтверждёнными.
- `.env` и `.sumup-e2e` не открывались; secrets, customer/card data и новые
  зависимости не добавлялись. OpenAI API, SumUp, Poster, ChoiceQR, production
  и social requests не выполнялись; `src/server.ts` не менялся.
- Проверки: `npm test` — 270 тестов в 26 файлах прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — четыре подтверждённых замечания исправлены локально;
  реальный OpenAI HTTP transport и новый SumUp E2E остаются отдельными явно
  разрешаемыми этапами.
- Commit: текущий коммит, содержащий эту запись.

### SumUp sandbox E2E остановлен на local configuration gate

- Перед внешними действиями подтверждены чистый `main`, исходный HEAD
  `d61319365ac23dae1cfd4e9502b7cac57fcf24d6`, совпадение с `origin/main` и
  отсутствие recovery, database, preflight, attempt-marker и hosted-checkout
  artifacts от незавершённой попытки. Содержимое private artifacts и `.env`
  не просматривалось и не выводилось.
- Безопасная локальная проверка конфигурации показала, что обязательные
  `SUMUP_E2E_RETURN_URL` и `SUMUP_E2E_PORT` отсутствуют. HTTPS endpoint с
  точным pathname `/webhooks/sumup` поэтому не подтверждён; согласно safety
  gate работа остановлена до запуска webhook server и до checkout creation.
- Request counts: checkout POST — `0`; payment attempts — `0`; реальные
  webhook deliveries — `0`; verifier GET — `0`; recovery GET — `0`; local
  duplicate replays — `0`; Poster requests — `0`. Retry, второй checkout,
  production и social/ChoiceQR actions не выполнялись.
- `PAID`, единственная `SUCCESSFUL` transaction, local `paid` и duplicate этой
  попыткой не подтверждены. Cleanup status: `not_run`; recovery artifacts не
  создавались, поэтому очищать или сохранять было нечего.
- Result: partial — E2E корректно остановлен на обязательном pre-check без
  внешних SumUp действий. Для новой попытки нужен заранее настроенный HTTPS
  return URL `/webhooks/sumup` и валидный local port; новый checkout требует
  отдельного продолжения в рамках оставшегося лимита пользователя.

### Read-only аудит сегодняшнего AI-слоя

- Проверены сегодняшние коммиты `01a0391`, `88954e0` и `d613193`, весь
  добавленный AI/application/config/adapter code, synthetic tests и связанная
  документация. `npm test` — 261 тест в 26 файлах прошёл;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно. Secrets,
  `.env`, `.sumup-e2e`, customer/card data и production wiring в tracked diff
  не добавлены.
- Confirmed: provider-neutral runtime allowlist отклоняет неизвестные и
  authoritative fields; customer report об оплате не меняет order на `paid`;
  OpenAI adapter не подключён к network transport или обычному `server.ts`.
  Default `gpt-5.6-luna` соответствует предыдущему явному требованию и не
  меняется от выбора модели текущего Codex-чата.
- Review finding: strict OpenAI response schema объявляет множество command
  properties optional и не включает их в `required`; текущие Structured
  Outputs требуют обязательного описания всех fields, включая nullable.
  Fake transport tests не проверяют принятие schema реальным API, поэтому
  provider contract остаётся неподтверждённым и вероятно потребует исправления
  до первого реального OpenAI request.
- Review finding: Responses-shaped request не задаёт `store: false`; реальный
  transport без дополнительной политики мог бы использовать provider default
  retention. До подключения network transport требуется явное решение по
  storage/privacy.
- Review finding: identity mismatch и duplicate message проходят через
  interpreter до authoritative deterministic guard. State другого пользователя
  не раскрывается и command повторно не применяется, но возможен лишний платный
  provider call; недетерминированный повтор того же message ID может завершиться
  `message_conflict` вместо cached response.
- Documentation finding: README и `docs/ARCHITECTURE.md` всё ещё называют
  server-verified SumUp payment/duplicate неподтверждёнными, хотя историческая
  запись ниже фиксирует один успешный 100-cent sandbox flow. Этот drift не
  исправлялся в рамках текущего запрета на изменения вне changelog.
- Result: partial — локальные checks зелёные и основные safety boundaries
  логичны, но сегодняшний AI-layer нельзя считать полностью безошибочным до
  устранения перечисленных contract/idempotency/privacy risks и повторной
  проверки.

### Свежий read-only sandbox preflight SumUp и Poster

- SumUp: существующий `src/scripts/check-sumup-access.ts` выполнен через
  локальный `tsx`-runner ровно один раз. Успешно подтверждены
  `authenticated: true`, `sandbox: true`, страна `IE`, валюта `EUR` и
  `configured-and-matched` для merchant из локальной конфигурации. Выполнен
  ровно один `GET /v1/merchants/{merchant_code}`, `retry: false`, `writes: 0`.
  Checkout, payment, webhook и POST не выполнялись.
- Poster: существующий `src/scripts/check-poster-menu.ts` выполнен через
  локальный `tsx`-runner. Read-only settings/menu check подтвердил совпадение
  ответа с настроенным аккаунтом, `EUR`, timezone `Europe/Dublin`, venue spot
  `1` и три видимых menu entries с текущими ценами: product `1` — `1000`
  евроцентов, product `3` — `300` евроцентов, product `5` — `400`
  евроцентов. Выполнены только `GET settings.getAllSettings` и `GET
  menu.getProducts`; writes: `0`.
- Confirmed этим preflight: актуальный доступ к read-only SumUp merchant,
  sandbox/IE/EUR и merchant match; актуальный read-only Poster account match,
  EUR, timezone/venue spot `1`, product IDs `1`, `3`, `5` и их spot prices.
  Вывод был ограничен безопасными полями; tokens, API keys, raw responses,
  customer/card data и secret URLs не выводились и не сохранялись.
- Unconfirmed: payment, checkout, webhook delivery, server-side verification,
  local `paid`, duplicate/retry behavior, Poster incoming-order creation,
  kitchen visibility, production identity, ChoiceQR и social channels. Их
  запросы в этом preflight не выполнялись.
- `.env` и `.sumup-e2e` не открывались. Код, `src/server.ts`, production
  wiring, menu data и внешние системы не изменялись. README, PLAN и
  `docs/ARCHITECTURE.md` не менялись: доказанного documentation drift для
  этого preflight не обнаружено.
- Проверка: `git diff --check` — успешно.
- Result: complete — read-only sandbox preflight завершён; полученные факты
  безопасно зафиксированы, а все write/payment/production границы сохранены.
- Commit: текущий коммит, содержащий эту запись.

### Provider-specific OpenAI conversation adapter

- Добавлен `OpenAIConversationInterpreter`, реализующий существующий
  `AIConversationInterpreter` без изменения deterministic conversation core.
  Adapter получает только `AIConversationContext` и текст клиента, строит
  Responses-shaped structured request и передаёт его через injected
  `OpenAIConversationResponseTransport`.
- Добавлен модуль `src/config/openai.ts`: `OPENAI_API_KEY` читается только из
  переданного локального `ProcessEnv`, обязательный ключ не включается в
  request body или диагностический вывод; `OPENAI_MODEL` и
  `OPENAI_REASONING_EFFORT` настраиваются там же, defaults —
  `gpt-5.6-luna` и `high`.
- Ответ модели извлекается только из структурированного output, проходит
  существующую runtime allowlist `validateAIConversationInterpretation` и
  превращается только в существующую команду или `needs_clarification`.
  Malformed, unknown и authoritative fields (price, total, availability,
  delivery fee, payment/order status и Poster data) безопасно отклоняются.
- Добавлены synthetic tests для structured command, malformed/unknown output,
  missing API key, model/reasoning settings, exact safe context payload и
  authoritative-field rejection. Transport является fake; внешняя сеть,
  OpenAI API, обычный `src/server.ts`, каналы, SumUp, Poster, ChoiceQR,
  checkout и payment flow не подключались.
- Новых зависимостей, API keys, customer data или card data в repository не
  добавлялось; `.env` и `.sumup-e2e` не открывались.
- Проверки: `npm test` — 261 тест в 26 файлах прошёл;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — локальный provider-specific adapter и его injected
  transport boundary готовы для последующего контролируемого подключения;
  реальный HTTP transport, production wiring и каналы остаются отдельными
  этапами.
- Commit: текущий коммит, содержащий эту запись.

### Provider-neutral AI conversation orchestration boundary

- Добавлен injected `AIConversationInterpreter` и
  `AIConversationLayerService`: interpreter получает только безопасные
  conversation context и текст клиента, а application service принимает
  channel/user/conversation/message identity, проверяет результат и передаёт
  разрешённую существующую `ConversationAgentCommand` в
  `LocalConversationAgentService`.
- Safe context ограничен identity, фазой conversation, ID и количеством
  позиций корзины, fulfilment, наличием обязательных customer fields и фактом
  checkout. Цены, availability, суммы, delivery fee, raw customer data,
  payment details и Poster data в него не передаются; runtime allowlist
  отвергает неизвестные команды, лишние поля и попытки задать authoritative
  значения.
- Безопасный результат `needs_clarification` возвращается без изменения
  deterministic core. Identity check, duplicate message guard и
  message-conflict остаются в SQLite-backed `LocalConversationAgentService`.
  Сообщение о самостоятельной оплате не вызывает payment verification или
  Poster handoff и не переводит order в `paid`.
- Добавлены synthetic tests с fake interpreter и временной SQLite для
  allowlisted free-text command, malformed/unknown result, clarification,
  duplicate message, message conflict, channel/user mismatch и запрета
  прямого вызова payment/Poster/network boundaries.
- Реальный AI provider, API keys, внешняя сеть, социальные каналы, SumUp,
  Poster, ChoiceQR, обычный `src/server.ts` и production wiring не
  подключались; новые зависимости не добавлялись. `.env` и `.sumup-e2e` не
  открывались.
- Проверки: `npm test` — 247 тестов в 25 файлах прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — локальная безопасная orchestration boundary подготовлена
  для последующего выбора provider; реальный interpreter/provider, каналы,
  handoff, production wiring и внешняя верификация остаются отдельными
  этапами.
- Commit: текущий коммит, содержащий эту запись.

## 11 сентября 2026

### Persistent conversation storage на SQLite

- Добавлена migration v3 `create_conversation_storage` в существующую
  последовательность SQLite migrations; отдельная архитектура или база не
  создавались. Новый `SqliteConversationStateStore` реализует прежний
  `LocalConversationStateStore` и работает с тем же versioned schema runner.
- После reopen сохраняются conversation ID, безопасная channel/user identity,
  единый order ID, checkout ID/reference/link, текущий conversation status,
  payment/order-submission snapshot, корзина, pickup/delivery, обязательные
  customer fields, processed message history, последний message ID и
  timestamps.
- Запись выполняется параметризованными SQL-запросами внутри
  `BEGIN IMMEDIATE`. Уникальные order/checkout references, неизменяемая
  conversation/checkout identity, неперезаписываемая история сообщений и
  optimistic update guard блокируют чужие связи, повторное применение message
  ID и lost update; constraint/error откатывает транзакцию без изменения ранее
  сохранённого conversation.
- Runtime decoder сверяет типизированный payload с индексными колонками и
  проверяет согласованность conversation, order, fulfilment и безопасных
  backend statuses. Подтверждённый payment snapshot не может вернуться в
  unverified, а `order_submitted` обязан соответствовать
  `submitted_to_poster`.
- Checkout boundary теперь возвращает существующие checkout ID/reference
  вместе со ссылкой, чтобы conversation мог восстановить корреляцию после
  restart. Это не меняет создание payment, webhook verification,
  reconciliation или paid-only Poster guards.
- Существующие bridge integration-тесты переведены с in-memory conversation
  store на временный SQLite и по-прежнему подтверждают, что только verified
  backend flow даёт `payment_confirmed`/`order_submitted`, а pending,
  not-paid, duplicate и uncertain не обходят прежние guards.
- Добавлены 7 synthetic SQLite integration-тестов: reopen, identity/timestamps,
  cart/customer/fulfilment и checkout/status snapshots, duplicate message после
  reopen, `payment_confirmed`, `order_submitted`, pending/uncertain, unknown
  conversation и rollback при конфликте уникальной checkout reference.
- Card data, secrets, raw webhook/provider responses и реальные customer data
  не сохраняются. LLM, соцсети, production `server.ts`, SumUp/Poster transport
  и production wiring не подключались; внешние checkout, payment, Poster POST
  и другие сетевые запросы не выполнялись. `.env` и приватные sandbox-файлы не
  открывались.
- Проверки: `npm test` — 238 тестов в 24 файлах прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — bounded persistent conversation storage готов и сохраняет
  существующие payment/idempotency/Poster boundaries; transport adapters, LLM,
  production wiring и более широкий event journal остаются отдельными этапами.
- Commit: текущий коммит, содержащий эту запись.

### Локальная связь conversation с verified backend statuses

- Добавлен тонкий application bridge между существующими conversation state,
  `LocalBackendFlowService` и order/payment repository. Checkout по-прежнему
  создаётся conversation-service через существующий backend flow, который
  атомарно сохраняет order/payment с единым order ID.
- До обработки bridge использует существующий webhook decision boundary только
  для безопасной корреляции payment → order → conversation. Unknown payment и
  order останавливаются до verifier/reconciliation и не меняют состояние
  другого conversation; Poster handoff вызывается только самим backend flow.
- Conversation state получил отдельный безопасный status snapshot для payment
  и Poster submission. После authoritative repository reconciliation bridge
  синхронизирует сохранённый order и выдаёт `payment_confirmed`; успешный Poster
  handoff дополнительно выдаёт `order_submitted`.
- `pending` отображается как `payment_pending`, non-paid — как
  `payment_not_confirmed`, duplicate — только как `already_processed` без
  повторного `payment_confirmed`. Poster `in_progress` и `uncertain`
  отображаются как `order_submission_pending` и
  `order_submission_uncertain`; verifier/backend errors преобразуются в
  `processing_error` без исходного текста ошибки.
- Bridge не вызывает `markPaid`, reconciliation или Poster submitter напрямую.
  Он принимает paid только когда существующий verifier и repository уже
  сохранили связанную paid-пару с successful transaction и `paidAt`, а статус
  Poster берёт из durable handoff state. Сообщение клиента об оплате сохраняет
  прежнее поведение и оставляет conversation/order в `awaiting_payment`.
- In-memory store теперь поддерживает поиск conversation по order ID и запрещает
  связывать один order ID с разными conversations. Production durability и
  атомарность SQLite с conversation store остаются отдельным будущим этапом.
- Добавлены только synthetic integration-тесты с настоящим временным SQLite и
  injected fake checkout/verifier/Poster boundaries. Они покрывают checkout и
  ожидание оплаты, verified confirmation, duplicate, pending/not-paid,
  submitted/uncertain Poster outcomes, unknown identity, customer payment claim,
  verifier error и запрет Poster handoff до verified payment.
- LLM, социальные каналы, обычный `src/server.ts`, real transport и production
  wiring не подключались. Внешние SumUp, Poster и ChoiceQR запросы не
  выполнялись; `.env`, sandbox artifacts, secrets, customer/card data, raw
  responses, URL и tokens не читались и не добавлялись. PLAN не менялся:
  roadmap и крупные границы этапов остались прежними.
- Проверки: `npm test` — 231 тест в 23 файлах прошёл;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — bounded локальная conversation ↔ verified backend связь
  готова; channel adapters, persistent conversation storage и production
  wiring остаются отдельными этапами.
- Commit: текущий коммит, содержащий эту запись.

### Локальный transport-neutral conversation use case

- Добавлен детерминированный application-service для conversation-команд поверх
  существующего `Order` и checkout-границы `LocalBackendFlowService`. Он не
  интерпретирует свободный текст и получает menu snapshot, delivery fee,
  conversation state, checkout creation, часы и создание order только через
  injected dependencies.
- Локальный flow показывает актуальный synthetic menu snapshot, добавляет и
  удаляет позиции, меняет только положительное целое quantity, показывает
  промежуточную корзину и точные суммы в EUR cents, собирает pickup либо
  delivery и запрашивает адрес только для delivery.
- Обязательные `first_name` и phone, а также delivery address проверяются до
  checkout. Финальный review явно сообщает readiness и недостающие поля;
  checkout link создаётся только для готового заказа через существующий local
  backend use case.
- In-memory state связывает conversation с единым order ID и возвращённым
  checkout link; существующая checkout-граница сохраняет payment с тем же
  order ID. Message ID и fingerprint команды обеспечивают безопасный replay
  без повторного добавления позиции или второго checkout effect, а конфликтное
  повторное использование message ID отклоняется.
- Сообщение клиента об оплате оставляет order в `awaiting_payment` и возвращает
  только ожидание verified payment. Новый conversation-service не имеет метода
  webhook verification или Poster handoff; переход в `paid` и вызов Poster
  остаются исключительно в существующем verified webhook flow.
- Ошибки menu, delivery, checkout и state boundaries преобразуются в безопасные
  локальные коды без вывода upstream details. Добавлены только synthetic
  unit-тесты для menu/cart, add/remove, quantity и invalid quantity,
  pickup/delivery, обязательных customer fields и адреса, точного расчёта,
  checkout gating, payment-report guard и повторных сообщений.
- Социальные сети, LLM/API provider, обычный `src/server.ts`, SumUp/Poster
  network transports, ChoiceQR и production wiring не подключались. Внешний
  I/O не выполнялся; Poster inspector, README, PLAN и архитектура не менялись.
  In-memory conversation store предназначен только для текущего локального
  этапа и не объявляется production durability.
- Проверки: `npm test` — 221 тест в 22 файлах прошёл;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — bounded локальная conversation state machine готова для
  следующего слоя адаптера; transport channels, language interpretation и
  production persistence остаются отдельными будущими этапами.
- Commit: текущий коммит, содержащий эту запись.

### Дополнительный read-only аудит Poster incoming order `4`

- Исходный Git status был чистым. Через существующий sandbox client выполнен
  ровно один дополнительный `GET incomingOrders.getOwnIncomingOrders` без
  retry; order `4` найден как объект. Другие Poster endpoints, POST, SumUp,
  ChoiceQR, checkout, оплата, server, tunnel и production не использовались.
- Без вывода или сохранения значений подтверждены имена и типы основных полей:
  `incoming_order_id`, `status`, `spot_id`, `client_id`,
  `client_address_id`, `service_mode`, `transaction_id` и `type` — number;
  `products` — array; `products[].product_id`, `products[].price` и
  `products[].incoming_order_id` — number; `products[].count` — string;
  `first_name`, `phone`, `comment`, `delivery_time` и timestamps — string;
  `last_name`, `address`, `delivery_price`, `payment_method_id`, `email` и
  `table_id` — null.
- Correlation comment присутствует и соответствует ожидаемой безопасной форме.
  Значения contact-полей не сравнивались и не выводились. Наличие numeric
  `service_mode`, null `address`/`delivery_price` и string `delivery_time` без
  подтверждённого контракта значений не доказывает pickup либо delivery.
- Распознаваемые payment-подобные поля ограничены
  `payment_method_id: null` и числовым `transaction_id`. Отдельных
  подтверждённых payment type, prepayment sum, order amount или currency нет;
  поэтому endpoint не доказывает сохранение или применение предоплаты.
- Полей kitchen/cook/production/workshop не найдено. Числовой `status` сам по
  себе не доказывает появление заказа в кухонном интерфейсе; для этого нужен
  другой подтверждённый официальный read-only endpoint либо ограниченный
  просмотр Poster UI.
- Текущий decoder не построил нормализованный snapshot строки. Наблюдённые
  типы совместимы с большей частью decoder boundary, но единственный запуск не
  сохранял raw values и потому не изолировал конкретный value-format guard.
  Строгий inspector остаётся `unknown`: его критерий `confirmed` не ослаблялся,
  а payment/currency/prepayment evidence в этом endpoint отсутствует. Второй
  GET для дополнительной диагностики не выполнялся.
- `docs/CHANGELOG.md` — единственный изменённый файл; код, tests, README, PLAN
  и архитектура не менялись. Raw response/body, URL/query, token, phone, names,
  comment value и customer data не выводились и не сохранялись.
- Result: partial — структура order `4` и ограничения endpoint подтверждены;
  exact spot/product/quantity/price/contact mapping, fulfilment semantics,
  prepayment и kitchen visibility остаются неподтверждёнными.
- Commit: текущий коммит, содержащий эту запись.

### Одна разрешённая SumUp → Poster sandbox E2E-проверка

- Исходный Git status был чистым. Обязательный read-only preflight script одним
  SumUp Get Merchant подтвердил настроенный IE/EUR sandbox; bootstrap E2E
  harness повторил собственную такую же guarded merchant-проверку. Poster
  settings/menu подтвердили отдельный тестовый аккаунт, EUR, spot `1` и
  актуальный видимый product `1` по цене `1000` евроцентов. Незавершённых SumUp
  или Poster recovery-артефактов перед попыткой не было.
- Существующий E2E harness поднял только loopback webhook receiver за временным
  HTTPS tunnel. Создан ровно один SumUp sandbox checkout на `100` евроцентов;
  пользователь завершил официальный Test mode сценарий без передачи card data
  в проект или журнал.
- Receiver получил webhook. Существующий server-side verifier подтвердил
  `PAID`, ровно одну связанную `SUCCESSFUL` transaction, совпадение checkout,
  order, reference, merchant, суммы и EUR; локальные order/payment атомарно
  перешли в `paid`. Duplicate replay вернул `duplicate`, не вызвал повторную
  внешнюю verification и не изменил timestamps, `paidAt` или transaction.
- Только после этого создана отдельная synthetic paid order/payment-пара для
  Poster. Через существующий durable handoff и one-shot sandbox submitter
  выполнен ровно один `POST incomingOrders.createIncomingOrder` без retry со
  свежими spot `1`, product `1`, quantity `1`, price и prepayment по `1000`
  евроцентов. Poster вернул строгий HTTP `200` и order ID `4`; локальные order
  и handoff завершились как `submitted_to_poster`/`submitted`.
- Выполнен ровно один последующий read-only lookup. Он нашёл строку по точному
  correlation reference и безопасно показал top-level типы: числовые order ID,
  status и spot ID, массив products, строковые `first_name`, phone и comment,
  а также `last_name: null`. Raw response и значения contact-полей не
  выводились и не сохранялись.
- Текущий decoder не построил snapshot найденной строки, поэтому строгий
  inspector вернул `unknown`. Точное соответствие order ID, spot, product,
  quantity, price, synthetic names и phone этим запуском не подтверждено;
  второй lookup не выполнялся. Единственное распознанное payment-подобное поле
  `payment_method_id` имело тип `null`; сохранение payment type, prepayment sum
  и currency по-прежнему не доказано.
- Подтверждённого read-only способа проверить kitchen visibility в текущих
  интерфейсах нет, поэтому кухня не проверялась и остаётся неподтверждённой.
  Production и ChoiceQR не использовались. После успешных SumUp duplicate и
  подтверждённого Poster HTTP-ответа временные tunnel/recovery/SQLite artifacts
  удалены; незавершённого transport outcome для recovery не осталось.
- Проверки: `npm test` — 210 тестов в 21 файле прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: partial — SumUp webhook, server-side payment verification, local
  `paid`, duplicate и один принятый Poster POST подтверждены; строгая проверка
  полей Poster, prepayment и kitchen visibility не завершена.
- Commit: текущий коммит, содержащий эту запись.

### Единый локальный backend-flow

- Добавлен тонкий application-service, который использует существующие SumUp
  checkout builder, payment repository, verified webhook processor и durable
  Poster handoff без нового transport или параллельной архитектуры.
- Checkout creation, server-side verification и Poster submission остаются
  injected boundaries. Локальные тесты используют только synthetic fixtures и
  fakes; обычный `src/server.ts`, внешние интеграции и production wiring не
  менялись.
- Единый flow сохраняет pending order/payment после подготовки checkout link,
  передаёт заказ в Poster только после нового verified `paid`, не делает handoff
  для pending/not-paid и не повторяет его для duplicate webhook.
- `uncertain` результат Poster сохраняет paid order и durable recovery marker;
  повторный webhook не вызывает automatic retry. Несовпадение verified payment
  со связанной локальной парой отклоняется до Poster handoff.
- `PLAN.md` дополнен согласованным восьмиэтапным roadmap и явными production,
  ChoiceQR/site и pilot readiness границами без переписывания исторических
  этапов. README и архитектурные границы не менялись.
- Проверки: `npm test` — 210 тестов в 21 файле прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — минимальный локальный order-to-Poster flow собран на
  injected dependencies; sandbox E2E, prepayment и kitchen visibility остаются
  неподтверждёнными отдельными этапами.
- Commit: текущий коммит, содержащий эту запись.

### Локальная нормализация подтверждённой Poster incoming-order схемы

- На основании отдельно завершённого read-only аудита добавлен чистый decoder
  только для подтверждённых полей `incomingOrders.getOwnIncomingOrders`.
  `incoming_order_id`, `spot_id` и `product_id` принимаются только как
  положительные числовые safe integer; строковые идентификаторы отклоняются.
  Количество товара принимается как положительное safe integer либо как
  каноническая строка положительного целого; ноль, отрицательные и дробные
  числа, пробелы, знаки, ведущие нули, exponent form, пустые и unsafe значения
  отклоняются без частичного разбора.
- `last_name: null` и отсутствующее поле безопасно нормализуются в отсутствие;
  другие нестроковые значения отклоняются. Точное совпадение `first_name` и
  `last_name` с исходным payload вынесено в отдельный обязательный guard и не
  считается подтверждённым при несовпадении или отсутствии ожидаемой фамилии.
- Decoder намеренно не выводит и не синтезирует currency, order amount,
  payment type или prepayment sum: read-only endpoint не подтвердил такие
  поля. Inspector по-прежнему требует все эти значения для `confirmed`, поэтому
  snapshot из текущей raw-схемы без payment evidence остаётся `unknown`.
- Добавлены только синтетические unit-тесты для number/string quantity,
  number-only ID boundaries, `null`/отсутствующего `last_name`,
  неподдерживаемого типа фамилии, всех перечисленных отрицательных
  quantity-форматов, отсутствующего payment evidence и точных name/payment
  mismatch guards.
- Payload builder, transport, обычный `src/server.ts`, README, PLAN и
  архитектура не менялись. `.env` и приватные sandbox-файлы не читались;
  внешние Poster, SumUp или ChoiceQR requests, server, checkout и webhook не
  запускались. Использованы только синтетические fixtures без реальных имён,
  телефонов, customer/card data, credentials или raw response.
- Проверки: `npm test` — 204 теста в 20 файлах прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — подтверждённые raw quantity/name форматы нормализуются
  локально без ослабления inspector; Poster prepayment и kitchen visibility
  остаются неподтверждёнными.
- Commit: не создавался по прямому указанию пользователя.

## 10 сентября 2026

### Одна разрешённая Poster sandbox-попытка с verified prepayment

- Read-only preflight непосредственно перед попыткой подтвердил отдельный
  тестовый аккаунт `sushi-planet-bot`, EUR, `Europe/Dublin`, spot `1` и три
  видимых товара. Для попытки использован актуальный product `1` с ценой `1000`
  евроцентов; незавершённого Poster recovery/SQLite state не обнаружено.
- В изолированной ignored SQLite создана синтетическая order/payment-пара.
  Payment локально прошёл существующую verified reconciliation: order и payment
  имели статус `paid`, совпадающие order ID, сумму `1000` евроцентов, EUR,
  checkout reference, `paidAt` и одну synthetic `SUCCESSFUL` transaction.
- Текущий verified-prepayment builder сформировал один pickup product `1` с
  количеством `1`, ценой `1000` и `payment: { type: 1, sum: 1000, currency:
  EUR }`, а также только синтетические contact/comment fields. Все guards были
  проверены до разрешения transport.
- Через existing sandbox-only one-shot submitter выполнен ровно один
  `POST incomingOrders.createIncomingOrder`: retry и второго POST не было.
  Poster вернул строгий HTTP `200`, JSON envelope содержал безопасный
  `incoming_order_id: 3`. Полный URL, token и response body не выводились и не
  сохранялись. Локальный durable handoff атомарно завершился состояниями
  `submitted_to_poster` и `submitted`.
- Единственный последующий read-only `incomingOrders.getOwnIncomingOrders`
  однозначно нашёл order `3` и подтвердил initial status `0`, spot `1`, ровно
  одну позицию product `1`, цену `1000`, synthetic phone после безопасной
  нормализации и correlation comment. Лишних позиций не обнаружено.
- Строгий inspector вернул `unknown`: safe decoder не подтвердил quantity в
  своём строгом integer-формате, а возвращённые first/last name не совпали с
  отправленными synthetic значениями. Raw response не сохранялся, поэтому это
  не объявляется доказанным изменением количества или установленной причиной
  нормализации имён.
- В read-only результате не обнаружены распознаваемые payment type,
  prepayment sum или payment currency. HTTP `200` подтверждает принятие request
  envelope с этими полями, но не доказывает, что Poster сохранил или применил
  предоплату. Kitchen visibility этим API не подтверждена.
- После подтверждённого ответа временные локальные SQLite и runner удалены.
  Production, SumUp, ChoiceQR и обычный `src/server.ts` не использовались.
  `.env`, credentials, response body, synthetic contact values и card data не
  выводились, не сохранялись в журнале и не добавлялись в Git.
- Проверки: `npm test` — 174 теста в 20 файлах прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: partial — один prepaid sandbox request создал order `3`, но
  prepayment, quantity representation, exact name mapping и kitchen visibility
  остаются неподтверждёнными.
- Commit: текущий коммит, содержащий эту запись.

### Verified prepayment для локального Poster handoff

- Стандартный Poster payload builder теперь принимает связанный
  `PaymentRecord` и добавляет `payment` только после локальной проверки статусов
  `order: paid` и `payment: paid`, order ID, непустых checkout reference,
  successful transaction ID и `paidAt`, точного совпадения итоговой суммы и
  валюты EUR.
- Подтверждённая предоплата формируется как `type: 1`, сумма заказа в целых
  евроцентах и `currency: EUR`. Отсутствующая, pending, относящаяся к другому
  заказу, несовпадающая по сумме/валюте или не имеющая transaction/reference
  payment-запись отклоняется до injected submitter.
- Application service и SQLite claim/completion повторно проверяют связанную
  paid-пару. Существующие durable fingerprint, claim, duplicate и uncertain
  правила не менялись; минимальный диагностический payload без prepayment
  остаётся отдельным sandbox-only профилем.
- Unit и SQLite integration-тесты используют только синтетические fixtures и
  injected fake transports. Они покрывают корректный verified prepayment,
  отсутствие/неподтверждённость payment, несовпадение суммы и валюты,
  несвязанные order/transaction/reference, отсутствие HTTP и сохранение
  единственной отправки с duplicate-защитой после перезапуска.
- Обычный `src/server.ts` не менялся; Poster, SumUp и ChoiceQR requests, новый
  заказ, checkout, tunnel и production actions не выполнялись. `.env`, token,
  credentials и реальные customer/card data не читались и не сохранялись.
- Проверки: `npm test` — 174 теста в 20 файлах прошли;
  `npm run typecheck`; `npm run build`; `git diff --check` — успешно.
- Result: complete — локальная verified-payment граница для prepaid Poster
  payload готова; следующая sandbox-попытка требует отдельного разрешения.
- Commit: текущий коммит, содержащий эту запись.

### Успешная минимальная Poster sandbox-попытка

- После отдельного явного разрешения через committed sandbox-only one-shot
  boundary выполнен ровно один `POST incomingOrders.createIncomingOrder` в
  подтверждённый аккаунт `sushi-planet-bot`. Body содержал только spot `1`,
  локальный синтетический phone и один product `1` с `count: 1`; `price`,
  `payment`, `first_name`, `last_name` и `comment` не отправлялись.
- Первая локальная команда запуска завершилась на TypeScript transform до
  выполнения кода и сетевого I/O. Исправленный запуск выполнил единственный
  POST; retry и второго POST не было.
- Poster вернул строгий успешный HTTP `200` с безопасным
  `response.incoming_order_id: 2`. Response body, token, query string и
  синтетический phone не выводились и не сохранялись.
- Последующий read-only `incomingOrders.getOwnIncomingOrders` однозначно нашёл
  заказ `2` и подтвердил initial status `0`, spot `1`, ровно одну позицию
  product `1`, количество `1`, применённую цену `1000` евроцентов и совпадение
  синтетического phone после безопасной нормализации. Лишних товарных позиций
  не обнаружено.
- Предоплата в минимальном body отсутствовала и не подтверждена. Наличие заказа
  в incoming-orders API подтверждено; видимость в кухонном интерфейсе отдельно
  не проверялась и остаётся неподтверждённой.
- Production, SumUp, ChoiceQR и обычный `src/server.ts` не использовались.
- Проверки: `npm test` — 169 тестов в 20 файлах прошли;
  `npm run typecheck` — успешно; `npm run build` — успешно;
  `git diff --check` — успешно.
- Result: partial — минимальный sandbox POST и read-only API inspection
  подтверждены; kitchen visibility, prepaid payload и production transport
  остаются отдельными этапами.
- Commit: текущий коммит, содержащий эту запись.

### Подготовка минимальной Poster sandbox-попытки без POST

- Read-only preflight повторно подтвердил отдельный тестовый аккаунт
  `sushi-planet-bot`, EUR, `Europe/Dublin`, spot `1` и три видимых товара.
  Для dry-run выбран актуальный product `1` с текущей ценой `1000`
  евроцентов; token и полный URL с query string не выводились.
- В workspace не обнаружены Poster SQLite/recovery-файлы, поэтому durable
  `submitting`/`uncertain` state новой попытки отсутствует. Предыдущий HTTP
  `422` остаётся исторически зафиксированным `uncertain`; новый POST или retry
  в этой работе не выполнялся.
- Добавлен отдельный минимальный профиль текущего payload builder и dry-run:
  body содержит только `spot_id`, синтетический `phone` и ровно один
  `products` с актуальным `product_id` и `count: 1`. Необязательные `price`,
  `payment`, `first_name`, `last_name` и `comment` исключены для изоляции
  причины прежнего `422`; default prepaid builder и paid-only handoff не
  изменили поведение.
- Sandbox one-shot submitter принимает только прежний correlation-bearing
  prepaid shape либо точный минимальный shape; transport остаётся
  disabled-by-default, automatic retry отсутствует. Локальный dry-run не
  содержит credentials/query и не выполняет I/O.
- Ограничение recovery зафиксировано явно: без `comment` запрос не несёт
  внешнего correlation reference. После строгого HTTP `200` inspector сможет
  опираться только на полученный `incoming_order_id` и будущий подтверждённый
  raw decoder; при timeout или неясном ответе безопасный поиск по correlation
  невозможен, результат должен остаться `uncertain` без повторного POST.
- README, PLAN и архитектура синхронизированы с уже реализованной local
  handoff/sandbox boundary. Production, SumUp, ChoiceQR и обычный `src/server.ts`
  не использовались и не менялись.
- Проверки: `npm test` — 169 тестов в 20 файлах прошли;
  `npm run typecheck` — успешно; `npm run build` — успешно;
  `git diff --check` — успешно.
- Result: partial — минимальный dry-run готов; raw incoming-order decoder и
  recoverable внешний reference для comment-free ambiguous response остаются
  blocker перед безопасной инспекцией результата.
- Commit: текущий коммит, содержащий эту запись.

### Одна разрешённая prepaid-попытка Poster sandbox: uncertain

- Непосредственный read-only preflight подтвердил отдельный тестовый аккаунт
  `sushi-planet-bot`, валюту EUR, часовой пояс `Europe/Dublin`, заведение `1`,
  видимый товар `1` и его текущую цену `1000` евроцентов.
- Текущий payload builder сформировал заказ на самовывоз с заведением `1`,
  синтетическими контактными полями, одним товаром `1` в количестве `1`, ценой
  `1000` евроцентов, `payment.type: 1`, предоплатой `1000` EUR и безопасным
  correlation reference в существующем поле `comment`.
- Через sandbox-only one-shot submitter выполнен ровно один
  `POST incomingOrders.createIncomingOrder`. Poster вернул HTTP `422`, поэтому
  результат строго классифицирован как `uncertain`; response body не выводился,
  автоматический или ручной retry не выполнялся.
- Требование успеха HTTP `200` с `response.incoming_order_id` не выполнено.
  Read-only inspector после POST не запускался, Poster order ID и поля
  созданного заказа не подтверждены. Видимость заказа на кухне также не
  подтверждена. Второй POST запрещён до отдельного решения о recovery этой
  попытки.
- Последующий офлайн-аудит подтвердил, что от ответа попытки фактически
  сохранён только безопасный HTTP status `422`; `Content-Type` ответа и body не
  сохранялись, поэтому их восстановить локально нельзя. Endpoint, request
  `Content-Type: application/json` и форма JSON подтверждены кодом transport и
  payload builder: обязательные `spot_id`, синтетический `phone` и один
  `products` присутствовали, product ID/count/price совпадали со свежим меню.
- Документированный контракт допускает использованные optional-поля имени,
  комментария, явной цены и `payment`. Однако исторический успешный POST
  передавал только `spot_id`, другой локальный тестовый phone и product ID/count,
  а текущая и первая неуспешная попытки содержали более широкий набор полей.
  Это различие не доказывает, какое поле или сочетание вызвало `422`; отдельно
  не подтверждены валидация текущего синтетического phone и принятие именно
  этой prepaid-комбинации аккаунтом.
- Исправлены только подтверждённые локальные validation/diagnostics gaps:
  sandbox submitter теперь считает успехом строго HTTP `200`, а `uncertain`
  возвращает безопасные stage, HTTP status и очищенный response Content-Type
  без body, credential, URL или contact data. Mock-тест фиксирует HTTP `422`
  diagnostics без retry и отклонение даже корректного envelope при non-`200`.
- Production, SumUp и ChoiceQR не использовались; обычный `src/server.ts` не
  менялся и не запускался. Token, полный URL с query string, `.env`, response
  body и синтетические контактные значения не выводились и не сохранялись в
  журнале.
- Проверки: `npm test` — 164 теста в 20 файлах прошли;
  `npm run typecheck` — успешно; `npm run build` — успешно;
  `git diff --check` — успешно.
- Result: partial/uncertain — единственная разрешённая POST-попытка завершилась
  HTTP `422`; безопасное создание и содержимое заказа не подтверждены.
- Commit: текущий коммит, содержащий эту запись.

### Локальные компоненты следующего Poster sandbox-теста

- Добавлен sandbox-only `InjectedPosterSandboxSubmitter` с отдельным
  `PosterSandboxPostTransport`. Без injected transport submitter отключён;
  token-aware `PosterSandboxHttpPostTransport` также по умолчанию запрещает I/O
  и требует явного `enabled: true`. Submitter допускает одну POST-попытку на
  экземпляр, использует только подтверждённый
  `incomingOrders.createIncomingOrder`, не выполняет retry и возвращает
  `uncertain` при network/HTTP/неоднозначном ответе. Для handoff это состояние
  преобразуется в безопасную ошибку, которую существующий сервис сохраняет как
  durable `uncertain`, не меняя order на `submitted_to_poster`. Кэшированный
  success повторно доступен только для того же correlation ID и fingerprint;
  другая identity получает `uncertain` без второго POST.
- Stable correlation теперь зависит только от local order ID и должен быть
  передан через уже согласованное поле `comment`; fingerprint по-прежнему
  вычисляется от точного payload. Это даёт безопасный reference для будущего
  read-only поиска без добавления неподтверждённых Poster-полей.
- Read-only `PosterClient` получил метод
  `incomingOrders.getOwnIncomingOrders`, который возвращает opaque rows без
  предположений об их полях. `PosterClientSandboxOrderLookup` использует только
  этот GET и injected decoder. `PosterSandboxInspector` подтверждает результат
  лишь при полном совпадении local identity, Poster order ID, venue, currency,
  amount, единственной позиции, quantity, price, payment type, prepayment и
  синтетических контактных/reference-полей; mismatch возвращает `unknown`.
- Реальный decoder raw Poster incoming-order rows не добавлен: актуальные имена
  и вложенность нужных полей ещё не подтверждены свежим sandbox-ответом. До
  такого read-only подтверждения inspector остаётся mock/injected на границе
  нормализации. Обычный `src/server.ts` не менялся и не подключает Poster.
- Добавлены полностью локальные mock-тесты one-shot success, default-disabled
  HTTP, network/HTTP/ambiguous `uncertain` без retry, безопасных diagnostics,
  строгой проверки полей, extra-product/mismatch, read-only client bridge и
  отсутствия Poster route в обычном app bootstrap.
- `.env` не читался; внешние запросы, checkout, webhook server, tunnel, Poster
  order, commit и push не выполнялись. Использованы только синтетические данные.
- Проверки: `npm test` — 163 теста в 20 файлах прошли;
  `npm run typecheck` — успешно; `npm run build` — успешно;
  `git diff --check` — успешно.
- Result: partial — локальные one-shot и read-only границы готовы; перед одним
  разрешённым Poster sandbox POST требуется отдельное подтверждение и свежая
  read-only фиксация raw incoming-order schema для injected decoder.
- Commit: текущий коммит, содержащий эту запись.

### Локальный идемпотентный handoff оплаченного заказа в Poster

- Добавлен transport-neutral интерфейс `PosterOrderSubmitter` и локальный
  `SubmitPaidOrderToPosterService`. Сервис принимает только сохранённую пару
  order/payment со статусом `paid`, подтверждённой успешной SumUp transaction и
  `paidAt`, затем использует существующий Poster payload builder. Реального
  Poster HTTP submitter и подключения к обычному `src/server.ts` нет.
- SQLite migration v2 добавляет один durable handoff marker на order ID со
  статусами `submitting`, `submitted` и `uncertain`, стабильным local
  correlation ID и SHA-256 fingerprint точного payload. Claim записывается в
  `BEGIN IMMEDIATE` до вызова injected transport; успешное завершение атомарно
  переводит order в `submitted_to_poster` и marker в `submitted`. Повтор
  завершённого handoff возвращает `duplicate` без вызова transport.
- Неоднозначная ошибка fake transport оставляет order в `paid`, переводит marker
  в `uncertain` и блокирует автоматический повтор. Сохранённый `submitting` после
  перезапуска возвращает `in_progress` без повторной отправки; для обоих случаев
  используется отдельный recovery service с injected read-only inspector.
  `unknown` сохраняет `paid`/`uncertain`; только `confirmed` с точным совпадением
  order ID, correlation ID и payload fingerprint может атомарно завершить
  handoff. Inspector и submitter представлены только fake-реализациями.
- Добавлены локальные тесты с injected fake transport и запрещающим `fetch` spy.
  Они покрывают отказ для `awaiting_payment`, единственную отправку `paid`
  заказа, точный согласованный payload, duplicate, безопасную ошибку transport,
  completed/in-progress/uncertain restart, два конкурентных вызова через одну
  connection, конкуренцию через две connections, неизменность timestamps и
  transaction identity при duplicate, строгую recovery confirmation, mismatch,
  безопасную ошибку inspector, v1→v2 migration и запрет новых SQLite-мутаций в
  read-only mode.
- `README.md`, `PLAN.md`, `src/server.ts` и существующий read-only Poster client
  не менялись. `.env` не читался; секреты, response body и реальные
  customer/card data не использовались. Запросы в Poster, SumUp и ChoiceQR,
  checkout, webhook server, tunnel и production server не запускались.
- Проверки: `npm test` — 136 тестов в 19 файлах прошли;
  `npm run typecheck` — успешно; `npm run build` — успешно;
  `git diff --check` — успешно. Scope/security review выполнен отдельно.
- Result: complete — локальная at-most-once основа и controlled recovery готовы;
  реальные Poster sandbox transport/inspector и один отдельно разрешённый
  внешний тест остаются следующими этапами.
- Commit: текущий коммит, содержащий эту запись.

## 9 сентября 2026

### Синхронизация документации с кодом и историческими проверками

- Обновлены только `README.md`, `PLAN.md`, `docs/ARCHITECTURE.md` и этот журнал.
  Разделены реализованные компоненты, исторические проверки тестовых систем и
  неподтверждённые результаты. Этапы 2–4 отмечены частично выполненными;
  пересечение работ по Poster и SumUp не объявлено завершением этих этапов.
- Основание: `src/domain/`, `src/storage/sqlite/`, `src/application/`,
  `src/integrations/`, `src/scripts/`, `src/app.ts`, `src/server.ts` и
  существующие тесты order/payment, SQLite, Poster payload/dry-run, SumUp
  checkout/verifier/webhook и E2E/recovery helpers. Коммиты `4a0c6bf`,
  `7df8cda`, `6e75220`, `2420370` и `c3feef1` фиксируют реализацию SQLite,
  локального webhook-flow, HTTP-verifier и recovery-инструментов. Обычный
  bootstrap не подключает эти компоненты автоматически.
- Исторические результаты сопоставлены с `0cbd407` (минимальный Poster POST),
  `c905bb3` (SumUp sandbox-доступ), `6d1fb1d` (первый checkout) и `204b5b6`
  (незавершённая E2E-попытка). Успешный Poster POST не содержал предоплату;
  автоматического транспорта отправки оплаченного заказа в коде нет.
- Уточнение к формулировке «sandbox checkout/payment выполнены» в записи
  `204b5b6`: подтверждено создание checkout и зафиксировано сообщение
  пользователя о завершении Test mode. Серверного подтверждения успешной
  оплаты, доставки webhook, sandbox `paid` или duplicate нет. Причины
  отсутствия webhook и первого Poster `422` остаются неизвестными.
- Recovery старой удалённой попытки, приём предоплаты Poster, кухня, полный
  сквозной сценарий и готовность к пилоту не объявлены подтверждёнными.
  Уточнены ограничения: два GET только при успешной верификации (при раннем
  отказе меньше), verifier принимает только `PAID`, один payment на заказ,
  recovery CLI не подтверждает sandbox заново и не меняет локальный статус.
  Локальные тесты компонентов не названы внешней E2E-проверкой.
- Исторические записи ниже сохранены без изменений: описания прежнего `200`,
  отсутствовавших тогда компонентов и удалённых временных данных относятся
  к соответствующим этапам. ChoiceQR, платёжный кандидат, границы проекта и
  правила безопасности не изменены.
- Внешние проверки интеграций и запросы в SumUp, Poster или ChoiceQR не
  выполнялись. `.env` и локальные sandbox-файлы не читались и не менялись;
  server/tunnel, checkout, заказ и платёж не запускались и не создавались.
- Проверки: `npm test` — 122 теста в 18 файлах прошли; `npm run typecheck` —
  успешно; `npm run build` — успешно; `git diff --check` — успешно.
  Отдельный scope/security review подтвердил изменения только четырёх
  разрешённых документов, сохранность прежних записей журнала и отсутствие
  добавленных секретов, customer/card data в проверенном diff.
- Result: complete — документация синхронизирована; внешняя валидация
  интеграций остаётся отдельной работой.
- Commit: коммит `Synchronize project documentation`, добавляющий эту запись.

## 26 августа 2026

### Сохраняемый recovery lifecycle SumUp sandbox E2E

- Sandbox E2E harness теперь сохраняет после создания checkout минимальный
  recovery state и изолированную SQLite до завершения диагностики. State
  содержит только test order/payment ID, checkout ID/reference и locator базы;
  hosted checkout URL хранится отдельно. Локальная recovery-директория и все её
  файлы исключены из Git и доступны только владельцу.
- `webhook_received`, `verification_failed`, успешный `paid` без duplicate и
  другие незавершённые исходы больше не удаляют state или SQLite. Автоматическая
  очистка разрешена только после уже подтверждённого `paid`, локального
  duplicate replay с неизменными timestamps/transaction и пустого `204`;
  отдельная явная cleanup-команда остаётся доступна для контролируемого сброса.
- Добавлен read-only recovery verifier: он восстанавливает binding из state и
  SQLite, открывает repository без миграций и записей и ограничивает SumUp
  verifier ровно двумя `GET` без retry. Результат повторно сверяется с локальными
  reference, merchant, EUR и суммой; безопасный вывод не содержит locator,
  URL, credentials, response body или customer data.
- Unit/mock-тесты покрывают owner-only минимальный state, сохранение после
  `verification_failed` и `paid`, запрет преждевременной очистки, cleanup после
  `paid + duplicate` и явной команды, read-only SQLite и отсутствие
  чувствительных данных в state/результате. Настоящая сеть не использовалась.
- `.env` не читался; server/tunnel не запускались; checkout, оплата и Poster
  order не создавались; production bootstrap, Poster, ChoiceQR и SQLite schema
  не менялись.
- Проверки: `npm test` — 122 теста; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Result: complete — незавершённая sandbox-попытка теперь остаётся адресно
  диагностируемой; следующая sandbox-оплата по-прежнему требует отдельного
  preflight и явного разрешения.
- Commit: текущий коммит, содержащий эту запись.

### Актуальный SumUp transaction verifier и наблюдаемость webhook

- Transaction verification переведена с недокументированного
  `/v0.1/me/transactions` на актуальный merchant-scoped read-only endpoint
  `GET /v2.1/merchants/{merchant_code}/transactions?id={transaction_id}`.
  Сохранены строгие проверки checkout/transaction ID, sandbox merchant, EUR,
  суммы и статуса `SUCCESSFUL`; наружу по-прежнему возвращаются только данные
  существующего `VerifiedSumUpCheckout`.
- Mock-тесты проверяют точные checkout и transaction URL, `GET` без body,
  `Accept`, Bearer header, manual redirect и отсутствие чувствительных данных в
  diagnostics при HTTP, network и invalid-JSON ошибках. Настоящая сеть не
  использовалась.
- Только sandbox E2E harness получил безопасные события до и после обработки:
  `webhook_received`, `verification_failed`, `paid` и `duplicate`. Логи не
  содержат webhook body, checkout/transaction ID, URL, API key, phone или текст
  ошибки; остальные безопасные исходы остаются различимыми без идентификаторов.
- Успешно обработанный `POST /webhooks/sumup` теперь отвечает пустым `204`.
  Невалидный callback сохраняет безопасный `400`, ошибка verifier — безопасный
  `503` для retry и не переводит order/payment в `paid`. Локальный duplicate
  helper обновлён под пустой ответ и по-прежнему требует уже оплаченную пару и
  проверяет отсутствие повторного изменения SQLite.
- Добавлено 6 тестовых случаев: transaction network/invalid-JSON diagnostics,
  три sandbox observability сценария и неизменность order/payment при ошибке
  verifier. Production bootstrap, SQLite schema, Poster и ChoiceQR не менялись.
  `.env` не читался; server/tunnel не запускались; запросы в SumUp, Poster или
  localhost, checkout, оплаты и заказы не создавались.
- Проверки: `npm test` — 111 тестов; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Result: complete — подтверждённая техническая проблема verifier исправлена;
  статус уже существующей sandbox-оплаты и фактическая доставка её webhook
  остаются отдельной read-only проверкой.
- Commit: текущий коммит, содержащий эту запись.

### Контролируемый SumUp sandbox E2E: webhook не доставлен

- Добавлен отдельный sandbox-only harness, не связанный с `server.ts`: он
  поднимает Fastify только с `POST /webhooks/sumup`, file-backed SQLite,
  существующим `ProcessSumUpWebhookService` и реальным read-only
  `SumUpSandboxCheckoutVerifier`. Вспомогательные команды создают один checkout,
  проверяют локальное состояние и разрешают duplicate replay только для уже
  подтверждённой `paid` пары.
- Hosted Checkout builder получил опциональный строго HTTPS `return_url`.
  Добавлен безопасный checkout creation client: один authenticated POST без
  retry, строгая проверка `201`, reference, merchant, суммы, EUR, `PENDING` и
  HTTPS hosted URL. API key и response body не входят в ошибки.
- Read-only Get Merchant непосредственно перед тестом подтвердил настроенный
  test merchant, `sandbox: true`, страну IE и EUR. Локальный route слушал только
  `127.0.0.1`; временный SSH HTTPS tunnel успешно прошёл GET smoke-check с
  ожидаемым `404`, подтверждающим отсутствие публичного GET route.
- Создан ровно один новый sandbox Hosted Checkout на `100` евроцентов с
  `return_url` временного tunnel. SumUp вернул `201` и `PENDING`; новый локальный
  test order и payment были записаны одной SQLite-транзакцией. Checkout URL и
  локальные идентификаторы хранились только в приватном временном состоянии и
  не выводились.
- Пользователь сообщил о завершении Hosted Checkout, ранее визуально
  подтверждённого как SumUp `Test mode`. Однако сервер не получил ни одного
  webhook request: безопасный
  `webhook_processed` log отсутствовал, а SQLite после пассивного ожидания
  сохранила order в `awaiting_payment`, payment в `pending`, без `paid_at` и
  successful transaction ID.
- Из-за отсутствия webhook существующий verifier не вызывался и authenticated
  read-only GET checkout/transaction после оплаты не выполнялся. Success page
  не использовалась как доказательство оплаты, состояние вручную не менялось.
  Duplicate replay не выполнялся, потому что его обязательное условие — уже
  подтверждённая локальная `paid` пара — не наступило. Причина отсутствия
  provider delivery не подтверждена; автоматические обходы и новая попытка не
  предпринимались.
- После проверки локальный сервер и HTTPS tunnel остановлены, browser tab
  закрыт, приватные временные artifacts окончательно удалены. POST в Poster,
  production Sushi Planet, реальные деньги, ChoiceQR,
  новый checkout, payment retry или webhook subscription не выполнялись.
- Добавлено 15 новых mock-тестов checkout creation/return URL; весь сетевой
  транспорт в тестах внедрён и замокирован. Новые зависимости не добавлялись.
  README и PLAN не менялись, потому что sandbox E2E не завершён.
- Проверки: `npm test` — 105 тестов; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Result: partial — sandbox checkout/payment выполнены, но webhook delivery,
  verifier-backed `paid` и duplicate остаются неподтверждёнными.
- Commit: текущий коммит, содержащий эту запись.

### Безопасный SumUp sandbox checkout/transaction verifier

- Добавлен `SumUpSandboxCheckoutVerifier`, совместимый с существующей
  dependency `SumUpCheckoutVerifier`. Он выполняет через внедряемый `fetch`
  ровно два последовательных read-only запроса: получает checkout по ID, затем
  получает связанную successful transaction по ID из checkout.
- До возврата `VerifiedSumUpCheckout` verifier требует ранее подтверждённый
  sandbox merchant с EUR, точное совпадение checkout ID и merchant, непустой
  checkout reference, положительную сумму не более чем с двумя десятичными
  знаками, `currency: "EUR"`, `status: "PAID"` и ровно одну связанную
  transaction со статусом `SUCCESSFUL`.
- Отдельный transaction response повторно проверяется по ID, sandbox merchant,
  статусу, EUR и точному совпадению суммы с checkout. Суммы checkout и
  transaction нормализуются из major units в безопасные целые евроценты;
  наружу возвращаются только поля существующего `VerifiedSumUpCheckout`.
- Запросы используют Bearer credential только в `Authorization`, `GET` без
  body, manual redirect и timeout. Ошибки содержат только безопасный этап и при
  необходимости HTTP status; API key, response body, checkout URL, phone и
  другие поля ответа в diagnostics не попадают.
- Добавлен 21 mock-тест: точные два GET, нормализация сумм, sandbox/EUR guards,
  checkout/reference/merchant/status checks, отсутствие или несколько
  successful transactions, transaction ID/status/merchant/amount checks и
  неразглашение данных при HTTP, network и invalid-JSON ошибках.
- Verifier не подключён в `server.ts`; SQLite, Poster, ChoiceQR, checkout
  creation, публичный URL и webhook subscription не менялись. `.env` не
  читался, настоящие запросы в SumUp или Poster не выполнялись, новые
  зависимости не добавлялись.
- Проверки: `npm test` — 90 тестов; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: текущий коммит, содержащий эту запись.

## 25 августа 2026

### Локальный серверный flow SumUp webhook

- Добавлен `ProcessSumUpWebhookService`, который применяет существующий webhook
  contract к SQLite repository. Для `ignored`, неизвестного checkout и уже
  оплаченного payment он завершает обработку без verification; для известного
  non-paid checkout вызывает только внедрённый `SumUpCheckoutVerifier`.
- `SumUpCheckoutVerifier` является интерфейсом без credentials, `.env`, HTTP-
  клиента или `fetch`. Service принимает только нормализованный
  `VerifiedSumUpCheckout`, требует совпадения его checkout ID с webhook и затем
  передаёт его в существующую атомарную SQLite reconciliation.
- Результаты application flow разделены на `ignored`, `unknown_checkout`,
  `pending`, `not_paid`, `paid` и `duplicate`. `PENDING`, `FAILED` и `EXPIRED`
  не переводят order в `paid`; повтор уже оплаченного webhook не вызывает
  verifier и не выполняет второй переход.
- Добавлен локальный Fastify route `POST /webhooks/sumup`. Он регистрируется в
  `createApp` только при явной передаче service dependency; текущий server
  bootstrap не передаёт verifier и не открывает этот route наружу. Поддержанные
  результаты возвращают безопасный HTTP `200` только с `received` и `outcome`;
  невалидный контракт и внутренняя ошибка возвращают безопасные `400`/`503` без
  payment, customer, merchant, token, checkout или transaction details.
- Integration-тесты через `app.inject` и временную SQLite database покрывают
  verified `PAID` + `SUCCESSFUL`, повторный webhook, `PENDING`, `FAILED`,
  неизвестные checkout/event, отсутствие вызова verifier для ignored/unknown/
  already-paid и отказ от результата verifier для другого checkout ID.
  Глобальный `fetch` во всех route-тестах заменён на немедленную ошибку.
- README и PLAN не менялись. Никаких сетевых запросов, GET/POST в SumUp или
  Poster, checkout, payment session, заказа, subscription, публичного URL,
  tunnel или webhook delivery не выполнялось. `.env` и secrets не читались.
- Проверки: `npm test` — 69 тестов; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: текущий коммит, содержащий эту запись.

### Постоянное локальное хранилище order ↔ payment

- Добавлена версионированная SQLite-миграция для таблиц `orders`, `payments` и
  `schema_migrations`. Схема ограничивает статусы и EUR, требует положительную
  целую сумму в евроцентах и обеспечивает уникальность order ID, checkout ID,
  checkout reference и successful transaction ID.
- Добавлен file-backed `SqliteOrderPaymentRepository` на встроенном
  `node:sqlite`. Создание связанной пары order/payment выполняется одной
  транзакцией; локальные файлы `.sqlite`/`.db` и их sidecar-файлы исключены из
  Git. Минимальная версия Node повышена до `22.13.0`; внешняя зависимость БД не
  добавлялась.
- Reconciliation читает сохранённые order и payment по checkout ID и повторно
  применяет существующие проверки checkout ID, checkout reference, merchant,
  суммы в целых евроцентах, EUR, статуса `PAID` и ровно одной
  `SUCCESSFUL` transaction с совпадающими суммой и валютой.
- Переход order и payment в `paid`, successful transaction ID и время оплаты
  фиксируются внутри `BEGIN IMMEDIATE`. Ошибка или конфликт уникальности
  полностью откатывает оба изменения; сырые SQLite diagnostics с локальными
  идентификаторами наружу не возвращаются.
- Повтор той же successful transaction после закрытия и повторного открытия БД
  возвращает `duplicate`, не меняет временные метки и не выполняет второй
  переход order в `paid`. Уникальный successful transaction ID также не может
  быть присвоен другому payment.
- Integration-тесты с временными локальными файлами покрывают миграцию и
  восстановление после перезапуска, атомарную успешную обработку, повтор после
  перезапуска, rollback при mismatch и конфликте transaction ID, атомарное
  создание пары и сохранение non-paid статуса. Сеть в тестах не используется.
- Обновлено только фактическое описание database-слоя в
  `docs/ARCHITECTURE.md`. README и PLAN не менялись: границы проекта и крупные
  этапы не изменились. Poster не затрагивался.
- Никаких внешних запросов, POST, публичных URL, tunnel, webhook delivery или
  изменений SumUp/Poster не выполнялось. Secrets, телефоны и card data в
  tracked-файлы не добавлялись.
- Проверки: `npm test` — 62 теста; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: текущий коммит, содержащий эту запись.

### Локальная связь payment ↔ order и webhook-контракт

- Добавлена локальная модель SumUp payment, связанная с одним order через
  `orderId`, `checkoutId` и `checkoutReference`. Запись хранит merchant,
  исходную сумму в целых евроцентах, EUR, статусы `pending`, `paid`, `failed`
  или `expired`, ID успешной transaction и временные метки.
- Создание payment разрешено только для order в `awaiting_payment`; сумма и
  валюта обязаны совпасть с расчётом order core. Пустые идентификаторы и
  нецелые либо неположительные суммы отклоняются.
- Добавлен development-only `InMemoryPaymentStore`. Он обеспечивает
  уникальность checkout ID, order ID и checkout reference, возвращает копии
  записей и запрещает менять identity payment при обновлении статуса. Для
  production всё ещё необходимо durable-хранилище с атомарной записью order и
  payment.
- Добавлен transport-neutral контракт SumUp webhook для документированного
  `CHECKOUT_STATUS_CHANGED` с checkout `id`. Неизвестные event types безопасно
  игнорируются, некорректное тело отклоняется, неизвестный checkout не
  связывается с order.
- Webhook сам по себе не меняет payment или order на `paid`. Для известного
  pending checkout он возвращает только `verification_required`; будущий слой
  транспорта обязан выполнить авторизованный GET и передать нормализованный
  результат в reconciliation.
- Reconciliation сверяет order, checkout ID, reference, merchant, сумму и EUR.
  Переход в `paid` возможен только для checkout `PAID` с ровно одной
  `SUCCESSFUL` transaction той же суммы и валюты. Повтор той же transaction
  возвращает `duplicate` и не выполняет второй переход; другая transaction,
  несовпадающие реквизиты или регресс уже оплаченного payment отклоняются.
- Публичный webhook route, URL, tunnel, HTTP-клиент проверки checkout и
  интеграция с Poster не добавлялись. Никаких внешних запросов, POST, webhook
  delivery или изменений SumUp/Poster не выполнялось. `.env`, README и PLAN не
  менялись.
- Unit-тесты покрывают создание и хранение payment, уникальные связи,
  несовпадение суммы, успешную reconciliation, повторную обработку, non-paid
  статусы, несовпадение checkout/transaction, webhook parsing/routing и
  отсутствие `fetch`.
- Проверки: `npm test` — 56 тестов; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: текущий коммит, содержащий эту запись.

### Первый SumUp sandbox Hosted Checkout

- После отдельного явного разрешения выполнен ровно один
  `POST https://api.sumup.com/v0.1/checkouts` в ранее подтверждённый sandbox
  merchant. Production не использовался, redirect был отключён, retry и другие
  запросы к SumUp не выполнялись.
- Отправлен последний проверенный dry-run payload: reference
  `sumup-ord_sumup_test_001-1`, сумма `1000` евроцентов (`amount: 10` в
  документированных major units), валюта `EUR` и
  `hosted_checkout.enabled: true`. API key и merchant code не выводились и не
  сохранялись в tracked-файлы.
- SumUp ответил HTTP `201`, `Content-Type: application/json`. Создан sandbox
  checkout `5d846097-5068-45ac-b40c-816840f969ea`; возвращённые reference,
  amount, currency и merchant совпали с запросом, начальный status — `PENDING`.
- Ответ содержал Hosted Checkout URL, но URL не выводился, не сохранялся и не
  открывался. Платёж не проводился, card data не передавались.
- README и PLAN не менялись: создание checkout подтверждено, но оплата,
  webhook/API verification и полный безопасный переход заказа в `paid` ещё не
  проверены.
- Проверки: `npm test` — 42 теста; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: текущий коммит, содержащий эту запись.

### Dry-run SumUp Hosted Checkout

- Контракт повторно сверен с официальными страницами
  [Hosted Checkout](https://developer.sumup.com/online-payments/checkouts/hosted-checkout)
  и [Create a checkout](https://developer.sumup.com/api/checkouts/create).
  Подтверждены `POST /v0.1/checkouts`, обязательные `checkout_reference`,
  `amount`, `currency`, `merchant_code` и `hosted_checkout.enabled: true`.
  SumUp принимает `amount` в основных единицах валюты, а локальный order core
  продолжает хранить и проверять деньги только в целых евроцентах.
- Добавлены типы и чистая функция подготовки Hosted Checkout. Она принимает
  заказ со статусом `awaiting_payment`, номер платёжной попытки и уже
  подтверждённый merchant summary; требует `sandbox: true` и валюту `EUR`.
- Уникальный `checkout_reference` детерминированно составляется из стабильного
  order ID и положительного номера платёжной попытки. Одна попытка повторяемо
  получает тот же reference, новая попытка — другой; документированный лимит в
  90 символов проверяется до подготовки запроса.
- Итог заказа вычисляется order core в центах и только на границе SumUp
  преобразуется в major units. Нулевая сумма, неверный статус, live merchant,
  другая валюта, неверный номер попытки и слишком длинный reference
  отклоняются локально.
- Добавлен dry-run, возвращающий только method, endpoint без query string,
  `Content-Type`, сумму в центах и сериализованный JSON body. API key не входит
  в сигнатуру или результат; `Authorization` не создаётся, `fetch` не
  вызывается.
- Необязательные `description`, `redirect_url`, `return_url` и `valid_until`
  пока не добавлены: их значения и дальнейшая обработка ещё не утверждены.
- Никаких запросов к SumUp не выполнялось, checkout и платёж не создавались,
  локальные secrets и `.env` не читались. README и PLAN не менялись.
- Unit-тесты покрывают точный payload, преобразование `1099` центов в `10.99`
  EUR, стабильность и смену reference между попытками, sandbox/EUR/status
  guards, лимит reference и доказательство отсутствия вызова `fetch` и
  Authorization header.
- Проверки: `npm test` — 42 теста; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: текущий коммит, содержащий эту запись.

### Read-only подтверждение доступа к SumUp sandbox

- Локально подтверждено наличие `SUMUP_SANDBOX_MERCHANT_CODE` и
  `SUMUP_SANDBOX_API_KEY`. Значения не выводились, не читались в tracked-файлы и
  не добавлялись в Git.
- По официальному [Get Merchant API](https://developer.sumup.com/api/merchants/get)
  выбран read-only endpoint `GET /v1/merchants/{merchant_code}`. Документация
  указывает scopes `user.profile` или `user.profile_readonly`, permission
  `merchant_read`, Bearer-аутентификацию и поле ответа `sandbox`, которое прямо
  показывает тестовый merchant.
- Добавлен строгий loader SumUp sandbox config. Он требует обе локальные
  переменные, обрезает внешние пробелы и не имеет fallback на live credentials.
  В `.env.example` добавлены только пустые имена переменных, без значений.
- Добавлен минимальный read-only `SumUpClient`. Он поддерживает только один
  метод `getMerchantSummary`, выполняет `GET` без body, query string, redirect и
  retry, передаёт API key только в `Authorization: Bearer` и наружу отображает
  только merchant code, страну, default currency и sandbox flag. Юридические,
  контактные и business-profile данные не маппятся.
- Ошибки клиента не включают API key, response body или идентификаторы merchant.
  Ответ валидируется без догадок: merchant code обязан совпасть с локальной
  конфигурацией, а `country`, `default_currency` и `sandbox` должны иметь
  документированные типы.
- Добавлен локальный script `npm run sumup:check-access`. Его вывод не содержит
  API key или merchant code и останавливается с ошибкой, если SumUp возвращает
  не-sandbox merchant.
- После успешных mock-тестов выполнен ровно один authenticated Get Merchant к
  SumUp. Получен успешный `2xx` ответ: credential авторизован, возвращённый
  merchant совпал с настроенным, `sandbox: true`, страна `IE`, default currency
  `EUR`.
- Никаких других запросов к SumUp не выполнялось: POST, checkout, payment,
  webhook, retry и изменения аккаунта отсутствовали. README и PLAN не менялись.
- Unit-тесты проверяют обязательность конфигурации, точный GET без body,
  единственный вызов fetch, Bearer header, отсутствие query, безопасное
  отображение merchant, неразглашение ключа/error body, mismatch merchant и
  некорректный sandbox flag.
- Проверки: `npm test` — 36 тестов; `npm run typecheck`; `npm run build`;
  `git diff --check`; `npm run sumup:check-access` — один успешный read-only GET.
- Commit: текущий коммит, содержащий эту запись.

### Официальный preflight SumUp Sandbox и Hosted Checkout

- Изучены только актуальные официальные материалы SumUp:
  [Testing](https://developer.sumup.com/online-payments/testing),
  [API Keys](https://developer.sumup.com/tools/authorization/api-keys),
  [Hosted Checkout](https://developer.sumup.com/online-payments/checkouts/hosted-checkout),
  [Checkouts API](https://developer.sumup.com/api/checkouts/create),
  [Webhooks](https://developer.sumup.com/online-payments/webhooks) и
  [Transactions API](https://developer.sumup.com/api/transactions/get).

#### Sandbox и доступ

- SumUp позволяет создать sandbox merchant account в Dashboard: войти в
  аккаунт, открыть Developer Settings и создать merchant в Sandboxes. Если
  SumUp developer account ещё отсутствует, регистрация нового developer account
  создаёт начальный sandbox merchant. Sandbox использует симулированные
  транзакции и не перемещает реальные деньги.
- Sandbox merchant имеет собственный идентификатор. Для интеграции нужно выбрать
  именно sandbox merchant и получить его `merchant_code`; live merchant code
  использовать нельзя.
- Для нашей прямой server-to-server интеграции одного merchant подходит secret
  API key, созданный в выбранном sandbox merchant. Он передаётся только сервером
  как `Authorization: Bearer <API_KEY>`. Показанный в Dashboard public key для
  этой интеграции использовать нельзя; ключ нельзя помещать в браузер, Git или
  tracked-файлы.
- OAuth 2.0 нужен, если приложение будут независимо подключать разные merchants.
  Affiliate key относится к card-present интеграциям и для Hosted Checkout не
  нужен. Поэтому `client_id`, `client_secret` и affiliate key в текущем
  single-merchant варианте не требуются.
- API reference указывает для создания checkout scope `payments` или
  `checkouts.write`, для чтения checkout — `payments` или `checkouts.read`, а
  для отдельного чтения transaction — `transactions.read` или
  `transactions.history`. Эти scopes важны при OAuth/access-token модели;
  secret API key одного merchant предоставляет прямой доступ от его имени.
- Планируемые локальные значения: `SUMUP_SANDBOX_API_KEY` как секрет и
  `SUMUP_SANDBOX_MERCHANT_CODE` как идентификатор. Значения ещё не получены и в
  репозиторий не добавлялись.

#### Минимальный Hosted Checkout

- Checkout создаётся серверным `POST https://api.sumup.com/v0.1/checkouts`.
  Обязательные поля: уникальный `checkout_reference` длиной до 90 символов,
  `amount` в основных единицах валюты, `currency`, `merchant_code` и для hosted
  страницы объект `hosted_checkout: { "enabled": true }`.
- Для Sushi Planet валюта должна быть `EUR`; локальные целые центы нужно
  детерминированно преобразовать в сумму EUR без ошибок округления. Поля
  `description`, `valid_until`, `return_url` и `redirect_url` необязательны.
- Успешное создание ресурса ещё не означает оплату. Нужно сохранить выданные
  SumUp `id`, `checkout_reference` и `hosted_checkout_url`, а клиента направить
  только на `hosted_checkout_url`. Hosted Checkout session действует 30 минут.
- `redirect_url` управляет кнопкой возврата клиента на success page и не является
  подтверждением оплаты. `return_url` — backend callback для уведомлений об
  изменении checkout; эти два URL имеют разные назначения.

#### Webhook и подтверждение успешной оплаты

- Отдельная регистрация события в Dashboard не описана: подписка на изменение
  конкретного checkout выполняется передачей публично доступного backend
  `return_url` при создании checkout. Для проекта следует использовать HTTPS
  endpoint, например отдельный route вида `/webhooks/sumup`.
- Актуальная документация Online Payments не описывает webhook signing secret,
  signature header или HMAC-проверку. Webhook содержит только
  `event_type: "CHECKOUT_STATUS_CHANGED"` и SumUp checkout `id`, поэтому сам
  callback не является доказательством оплаты.
- Endpoint должен быстро вернуть пустой `2xx`, неизвестные будущие типы событий
  нужно безопасно игнорировать. При не-`2xx` SumUp повторяет доставку через
  1 минуту, 5 минут, 20 минут и 2 часа; обработка обязана быть идемпотентной.
- После webhook backend обязан выполнить аутентифицированный
  `GET /v0.1/checkouts/{checkout_id}` и сверить `id`, наш
  `checkout_reference`, `merchant_code`, точные `amount` и `currency: "EUR"`.
  Checkout считается успешно оплаченным только при `status: "PAID"`.
- Transactions API назван официальным источником результата платежа. Перед
  передачей заказа в Poster нужно также подтвердить связанную transaction со
  `status: "SUCCESSFUL"` и совпадающими merchant, amount и currency. Статусы
  `PENDING`, `FAILED`, `EXPIRED`, `CANCELLED` или `REFUNDED` не разрешают
  создавать оплаченный заказ.
- Только после серверной проверки и идемпотентного перехода конкретного order ID
  в paid можно создать один заказ Poster. Hosted success page, `redirect_url`,
  сообщение клиента и неподтверждённый webhook этого права не дают.

#### Текущий статус

- Официальная документация подтверждает, что SumUp sandbox и Hosted Checkout
  подходят для следующего тестового этапа. Окончательная пригодность для Sushi
  Planet остаётся неподтверждённой до получения sandbox credentials и реального
  end-to-end теста webhook/API reconciliation.
- Официальная testing page предоставляет тестовые карты для success, failure и
  3DS-сценариев; их номера намеренно не копировались в репозиторий. Сумма `11`
  в sandbox документирована как преднамеренный failure-path.
- Никакие SumUp аккаунты, sandbox merchants, API keys, webhook endpoints,
  checkouts или платежи не создавались. Внешние системы не изменялись. README и
  PLAN не менялись.
- Проверки: `npm test` — 29 тестов; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: текущий коммит, содержащий эту запись.

### Успешная вторая тестовая попытка Poster

- Read-only preflight непосредственно перед попыткой подтвердил тестовый аккаунт
  `sushi-planet-bot`, EUR, заведение `1`, видимый товар `1` и его текущую цену
  `1000` центов. Локальный `POSTER_TEST_PHONE` был использован без сохранения в
  репозитории или журнале.
- После отдельного явного разрешения выполнен ровно один
  `POST incomingOrders.createIncomingOrder` с минимальным body: `spot_id: 1`,
  тестовый телефон и один `products` с `product_id: 1`, `count: 1`.
  Необязательные `price`, `payment`, имя и комментарий не отправлялись.
- Redirect был отключён, retry не выполнялся, production не использовался и
  других write-запросов к Poster не было.
- Poster ответил HTTP `200`, `Content-Type: application/json; charset=utf-8` и
  создал тестовый входящий заказ `incoming_order_id: 1`: заведение `1`, товар
  `1`, количество `1`, применённая цена `1000` центов, начальный status `0`.
- Ответ показал, что Poster возвращает тестовый телефон без ведущего `+`, в том
  числе в поле `first_name`. Диагностический sanitizer расширен: известный
  E.164-телефон теперь удаляется и в нормализованном Poster-варианте.
- После единственного POST никаких дополнительных запросов к Poster не
  выполнялось. README и PLAN не менялись: полная проверка появления заказа у
  кухни и остальных полей этапа ещё не завершена.
- Проверки: `npm test` — 29 тестов; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: текущий коммит, содержащий эту запись.

### Безопасная диагностика HTTP-ошибок Poster

- Контракт `incomingOrders.createIncomingOrder` повторно сверен только с
  [официальной документацией Poster](https://github.com/joinposter/docs/blob/master/ru/web/incomingOrders/createIncomingOrder.md)
  и [официальным PHP SDK](https://github.com/joinposter/api-php/blob/master/src/PosterApiCore.php).
  Документация подтверждает POST с JSON body, обязательные `spot_id`, `phone`
  или `client_id`, массив `products` с `product_id` и `count`, а также
  необязательные `price`, `payment`, имя и комментарий. SDK передаёт параметры
  POST через `json_encode` с `Content-Type: application/json`, а токен — в query
  string.
- Формат первой попытки в целом соответствует документированному контракту.
  Официальные источники не объясняют конкретный HTTP `422`; точная причина пока
  не подтверждена, потому что при первой попытке не были сохранены исходные
  `Content-Type` и body ответа. Правила валидации тестового телефона в указанной
  документации также не описаны.
- Добавлен безопасный диагностический снимок уже полученного ответа: HTTP status,
  очищенный `Content-Type`, body максимум 2000 символов и признак усечения.
  Из body удаляются переданные чувствительные значения, распространённые поля
  credentials, email, телефон и query string URL. Request URL не сохраняется.
- Read-only client теперь прикладывает такой снимок к `PosterApiError`, включая
  не-JSON ответы, и очищает отражённые секреты и query string также из текста
  исключения.
- Для следующей отдельно разрешённой диагностической попытки подготовлен более
  узкий кандидат body: `spot_id`, тестовый `phone` и один элемент `products` с
  `product_id` и `count`. Необязательные `price` и `payment` следует исключить:
  цена может быть взята Poster из заведения, а реальная предоплата для теста не
  подтверждена. Это уменьшает число проверяемых полей, но не является
  подтверждённым исправлением `422`; тестовый телефон и актуальность товара
  нужно проверить перед будущей отправкой.
- Никаких запросов к Poster на этом этапе не выполнялось.
- Unit-тесты покрывают JSON и text error body, HTTP `422`, `Content-Type`,
  ограничение длины, удаление токена, query string, email и телефона, а также
  некорректные метаданные диагностики.
- Проверки: `npm test` — 28 тестов; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: текущий коммит, содержащий эту запись.

### Разделение базовой документации и технического журнала

- Создан этот журнал и перенесена история технических этапов Poster.
- README сокращён до базового описания проекта и актуального статуса интеграций.
- PLAN очищен от fixtures, форматов запросов и подробностей диагностики.
- В AGENTS добавлено правило обновлять этот журнал после каждого завершённого
  изменения и менять README/PLAN только при ключевых проектных изменениях.
- Проверки: `npm test` — 22 теста; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: текущий коммит, содержащий эту запись.

### Одна разрешённая попытка создания тестового заказа

- Перед отправкой read-only проверка повторно подтвердила тестовый аккаунт
  `sushi-planet-bot`, валюту EUR, часовой пояс `Europe/Dublin`, заведение `1`,
  товар `1`, его видимость и цену `1000` центов.
- После явного разрешения выполнен ровно один
  `POST incomingOrders.createIncomingOrder` без redirect и retry. Production не
  использовался.
- Poster ответил HTTP `422`. Ответ не дал пригодных сохранённых диагностических
  полей, поэтому причина ошибки не подтверждена и повторный POST не выполнялся.
- Последующая read-only проверка `incomingOrders.getOwnIncomingOrders` вернула
  `0` заказов за день и `0` совпадений по тестовому комментарию. Онлайн-заказ не
  создан.
- Следующий безопасный шаг: улучшить обработку error-envelope, диагностировать
  `422`, повторно прочитать меню и получить новое явное разрешение перед любым
  POST.
- Проверки: `npm test` — 22 теста; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: `54d4ad98c4d7640986d15e03ccb648672c7bca2b` —
  `Record Poster test order attempt`.

### Dry-run будущего Poster POST

- По официальной документации подтверждён метод
  `POST incomingOrders.createIncomingOrder`.
- Официальный PHP SDK Poster подтвердил транспорт: JSON body,
  `Content-Type: application/json`, токен реального запроса в query string.
- Добавлена чистая dry-run функция, которая возвращает method, endpoint без
  query, content type и сериализованный JSON body. Функция не принимает токен,
  не читает `.env` и не вызывает `fetch`.
- Unit-тест подменяет `fetch` на немедленную ошибку, проверяет отсутствие query и
  токена, точный JSON body, а также ошибки неоплаченного заказа и доставки.
- Никаких запросов к Poster на этом этапе не выполнялось.
- Проверки: `npm test` — 22 теста; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: `0f51d71e32f61263cc041138b8bd2f72d5be52b8` —
  `Add Poster dry-run request preparation`.

### Payload одного тестового заказа Poster

- По официальной документации подготовлены типы и чистая функция сборки
  минимального будущего payload из order core.
- Зафиксирован тестовый fixture:
  - аккаунт `sushi-planet-bot`;
  - заведение `1`;
  - товар `1` — «Вода минеральная Боржоми в стекле 0.5л»;
  - количество `1`, цена `1000` центов;
  - получение — самовывоз;
  - имя `Poster API Test`, фамилия `Customer`;
  - телефон `+353000000000`;
  - комментарий `TEST ONLY - ord_poster_test_001 - pickup`;
  - тестовая предоплата: `type: 1`, сумма `1000`, валюта `EUR`.
- Сборка разрешает только заказ order core в статусе `paid`, один товар и
  самовывоз. Доставка, несколько товаров, неподтверждённые поля и неоплаченный
  заказ отклоняются.
- Unit-тесты не используют токен или сеть. Никаких данных Poster не создавалось
  и не менялось.
- Проверки: `npm test` — 19 тестов; `npm run typecheck`; `npm run build`;
  `git diff --check`.
- Commit: `4d8fa4f06b554862ab45fd1a2671d6d5292e1fb1` —
  `Prepare Poster test order payload`.

### Основа приложения, order core и read-only Poster

- Создана основа Fastify/TypeScript, health route, конфигурация, тесты и сборка.
- Реализован order core: корзина, целочисленные денежные расчёты в центах,
  самовывоз, доставка с явно переданной стоимостью, статусы и проверяемые
  переходы состояния.
- Настроен безопасный read-only Poster client. Он получает настройки тестового
  аккаунта и меню, преобразует цены в целые центы и не отображает токен.
- Read-only проверка подтвердила аккаунт `sushi-planet-bot`, EUR,
  `Europe/Dublin`, заведение `1`, ID, названия, цены и видимость тестового меню.
- Write-запросы, создание заказов, платежи, постоянное хранилище и каналы на этом
  этапе отсутствовали.
- Проверки: `npm test` — 14 тестов; `npm run typecheck`; `npm run build`;
  `git diff --cached --check`.
- Commit: `39040de2b36fa198deac9b12d8acdeddd78a1c2c` —
  `Initialize Sushi Planet order agent`.
