# Развёртывание и эксплуатация

## Текущее состояние

Пользователь сообщил, что облачного аккаунта пока нет. Поэтому этот репозиторий готовит сервис и collector к облачному запуску; постоянная VM, модели и реальные потоки ещё не предоставлены. Статический приватный frontend можно просматривать отдельно в демонстрационном режиме. Он не хранит backend-секреты и не наблюдает камеры в фоне.

Не требуется оставлять компьютер пользователя включённым после настоящего облачного развёртывания. Локальные команды ниже — опциональный путь разработки/проверки, а не предлагаемая замена облаку.

## Подготовка API

Node.js 24+ с `node:sqlite`. Production runtime не имеет npm-зависимостей; dev dependency — Playwright для браузерной проверки. Python collector устанавливается отдельно.

```sh
npm ci --ignore-scripts
npm run init-env
npm test
npm run check
```

`.env` создаётся эксклюзивно с mode 0600 и двумя случайными токенами. Прочитать/передать значения нужно защищённым способом на платформе развёртывания; не публиковать в README, frontend bundle, issues, скриншотах или обычных сообщениях. Файл игнорируется Git. Повторный `init-env` не перезаписывает секреты.

```sh
# Backend с синтетическим журналом и сохранёнными видео:
npm run demo
# Обычный API, реальные источники по умолчанию выключены:
npm start
```

Demo использует подкаталог `DATA_DIR/demo`, обычный API — DATA_DIR. БД фиксирует свой режим и отказывается открываться в другом режиме. Нельзя подключить production к старой demo-БД и случайно показать синтетические события как реальные.

Frontend доступен у запущенного API по `/`. В кнопке «Подключить API» задать URL backend и viewer token; значение остаётся в памяти вкладки. Перезагрузка очищает соединение. До подключения показываются явные учебные сцены. Закрытие вкладки не останавливает реально запущенный backend/collector.

## Контейнер API на облачной VM

Нужна VM/контейнер с постоянным диском, достаточными CPU/RAM и штатно доступными источниками. Система не создаёт платную VM или подписку автоматически. Применимость бесплатного ресурса проверяется в аккаунте до запуска.

```sh
docker build -t roadwatch-api .
docker volume create roadwatch-data
docker run -d --name roadwatch-api --restart unless-stopped \
  --env-file .env -e HOST=0.0.0.0 \
  -p 127.0.0.1:8787:8787 \
  -v roadwatch-data:/data \
  -v "$PWD/config/cameras.json:/app/config/cameras.json:ro" \
  roadwatch-api
```

Порт слушает loopback VM; перед внешним доступом настроить HTTPS reverse proxy, rate/body limits и при необходимости сетевой allowlist. Прямой HTTP endpoint с токенами не публиковать. Статический Sites frontend имеет owner-only доступ, но это не защищает автоматически внешний API: его bearer authentication остаётся обязательным.

Для отдельного frontend добавить точный Origin в `ALLOWED_ORIGINS`, например приватный Sites URL из STATUS. Backend не принимает wildcard. Не задавать широкие разрешения «временно» ради подключения неизвестного сайта.

Конфигурация камер подгружается при старте и обновляет name/zone/enabled/approved/координаты существующих ID. Перед включением проверить source contract. Публичные stream URLs с временными секретами не коммитить: поток задаётся в приватном collector config через secret/volume.

## Collector на той же/отдельной VM

```sh
docker build -f collector/Dockerfile -t roadwatch-collector .
```

Подготовить приватный `collector.json` на основе `config/collector.example.json`:

- `approved_for_cloud_run=true` только после проверки ресурса и условий запуска.
- Доступный HTTPS `api_url`, collector получает INGEST_TOKEN через env.
- `models`: существующие ONNX-веса, реальные SHA-256, labels и параметры.
- `cameras`: те же camera IDs, что в API, `enabled/approved`, разрешённый HTTPS stream_url.
- Ограничения FPS, CPU и объёма. Default дневной лимит API 500 кадров остановит пробный запуск; менять только после ресурсной проверки.

```sh
docker run -d --name roadwatch-collector --restart on-failure:3 \
  --env-file .env \
  -v "$PWD/collector.json:/config/collector.json:ro" \
  -v "$PWD/models:/models:ro" \
  -v roadwatch-buffer:/data \
  roadwatch-collector
```

Внутри контейнера localhost — этот же контейнер; `api_url` должен указывать на реально доступный API, а не localhost другого контейнера. Для production желательно отдельный env только с INGEST_TOKEN, без viewer-секрета.

CPU ledger хранится в `buffer_root/cpu-budget.json`, сбрасывается по UTC-дню и переживает обычный перезапуск при сохранном volume. Это измерение inference CPU процесса, а не счётчик всего host bill: FFmpeg и остальные компоненты считаются отдельно. Один collector replica на ledger; межпроцессная координация нескольких replicas не реализована.

Контейнер fail-fast: при критической ошибке API, исчерпании бюджета или recorder exit процесс завершается и FFmpeg останавливается. Рестарт ограничен тремя попытками, чтобы не получить бесконечный запрос неисправного источника. Это не полноценный scheduler/retry service.

## Проверка перед увеличением охвата

1. Запустить один разрешённый источник. Убедиться, что JPEG и observation имеют один frame_id, а timestamps свежие.
2. На проверочном материале получить два положительных кадра и увидеть unreviewed событие.
3. Получить MP4, проверить codec, длительность, pre/post покрытие, воспроизведение и отсутствие звука.
4. Закрыть браузер; убедиться, что события продолжают сохраняться на сервере. Открыть снова и проверить журнал.
5. Перезапустить API и убедиться, что event/evidence остались на persistent volume.
6. Проверить остановку по frame quota, недоступность источника и очевидный stale статус вместо «всё спокойно».
7. Измерить 1/5/10 потоков; только затем менять target concurrency/FPS.

## Хранение и резервные копии

`npm run retention` помечает клипы старше `EVIDENCE_RETENTION_DAYS` (default 7) как expired и удаляет файл/metadata evidence, сохраняя hash в event body. Также удаляет observation history старше суток; журнал событий и reviews пока сохраняются. Команду запускать на той же VM с тем же DATA_DIR и в правильном demo/real режиме. Автоматического host cron в этом репозитории нет: установить его только после выбора облачной площадки.

Нужна резервная копия SQLite и evidence одним согласованным snapshot/backup-процессом; простое копирование живого основного `.sqlite` без WAL может потерять данные. Поскольку реализован бюджет 500 МБ, archive upload остановится до исчерпания этой квоты. Полный filesystem имеет отдельные лимиты. После аварийного завершения требуется сверить файлы с evidence metadata; orphan-cleaner пока не реализован.

## GitHub и Sites

GitHub repo закрытый. Workflow запускается **только вручную**; автоматические jobs на каждый push не включены, чтобы без проверки аккаунта не расходовать private CI quota. В нём нет постоянного наблюдения, платных runners или секретов камер.

Sites публикует только содержимое `web/` в owner-private frontend. Исходники backend, токены, collector config и данные в Sites static artifact не включаются. Платные внешние сервисы для этой демонстрации не подключаются. Полное live-развёртывание требует отдельного backend/collector.
