# Sushi Planet Smart Ordering Agent — Changelog

Здесь хранится подробная техническая история завершённых изменений. README
описывает проект и его границы, а PLAN — крупные этапы и их высокий уровень.

## 25 августа 2026

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
