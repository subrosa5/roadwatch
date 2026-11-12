# API v0.1

Все пути ниже относительны к адресу backend. Секреты передаются только заголовком `Authorization: Bearer ...`, не query string. Ответы API `Cache-Control: no-store`. HTTPS обязателен вне loopback-разработки.

## Роли

- `VIEWER_TOKEN`: читать камеры/наблюдения/события, получать видео, ставить review-статус. Это роль оператора, не read-only.
- `INGEST_TOKEN`: принимать наблюдения, загружать текущие JPEG и фрагменты событий. Не имеет доступа к чтению архива.

Минимум 32 символа, значения должны различаться. Default credentials отсутствуют. `npm run init-env` генерирует файл с mode 0600, не выводит значения и не перезаписывает существующий файл. Токены не имеют встроенной ротации/персональных прав: при компрометации заменить env и перезапустить сервис. Персональный SSO — следующий этап.

## Endpoints

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| GET | `/api/health` | публичный | Только service/version/mode |
| GET | `/api/cameras` | viewer | Реестр, health, последнее наблюдение |
| GET | `/api/stats` | viewer | Фактические камеры, квоты и счётчики |
| GET | `/api/events` | viewer | Журнал, максимум 200 записей за запрос |
| POST | `/api/events/:id/review` | viewer | Проверка оператором |
| GET | `/api/cameras/:id/frame` | viewer | Последний принятый JPEG |
| GET | `/api/evidence/:id` | viewer | Приватный MP4, поддерживает Range |
| POST | `/api/observations` | collector | Рамки, provenance, событие |
| POST | `/api/cameras/:id/frame` | collector | JPEG, ≤2 МБ, X-Frame-ID |
| POST | `/api/events/:id/evidence` | collector | MP4, ≤25 МБ |
| GET | `/api/capacity` | viewer | Теоретическая ресурсная оценка |

## Наблюдение

```json
{
  "camera_id": "approved-camera-id",
  "frame_id": "sha256-of-source-frame",
  "captured_at": "2026-11-12T13:00:00.000Z",
  "model": "fire-smoke-model-v1-sha256-prefix",
  "clock": "collector_arrival",
  "detections": [
    {"label": "smoke", "score": 0.92, "box": [0.12, 0.21, 0.28, 0.31]}
  ]
}
```

Пример иллюстрирует формат, не реальное событие. `box` — `[x, y, width, height]`, все значения нормализованы в [0,1], прямоугольник целиком внутри кадра. Label: `vehicle`, `collision`, `smoke`, `fire`. `vehicle` сам по себе не создаёт событие. `score` — выход конкретной модели, не доказанная вероятность.

`clock=source` использовать только если время действительно получено от источника; иначе `collector_arrival`. Время API и collector должно синхронизироваться. Кадр старше минуты или более 5 секунд из будущего отклоняется; застарелую запись нельзя представить как live-наблюдение.

Ответ: `201 {duplicate:false,events:[...]}`. Первый положительный кадр сам по себе события не создаёт. Два различных последовательных кадра одного типа в пределах 6 секунд дают candidate, если не действует cooldown. Дубликат возвращает `duplicate:true` и не расходует frame-budget повторно в рамках окна свежести.

## Кадр и рамки

Сначала POST observation, затем POST frame с тем же `X-Frame-ID` и `Content-Type: image/jpeg`. ID должен совпасть с текущим наблюдением. JPEG и его ID хранятся одной строкой SQLite. GET frame возвращает `X-Frame-ID`; браузер рисует рамки только при совпадении с ID прочитанного наблюдения. Даже в этом случае frontend показывает snapshot с частотой опроса, не low-latency RTSP/HLS.

## Событие и запись

Событие содержит UUID, camera_id, type, captured_at, created_at, status, demo, model/clock, boxes, confirmation_frames, evidence_id, recording_status.

Review status: `unreviewed`, `confirmed`, `dismissed`. Recording status: `unavailable`, `ready`, `expired`. Эти статусы независимы. Событие может быть подтверждено оператором при недоступной записи — интерфейс обязан сообщить об этом.

Загрузка MP4: бинарный body, Content-Type `video/mp4`, event UUID из ответа ingest. API проверяет минимальную сигнатуру контейнера, считает SHA-256, публикует файл под UUID после записи и прикрепляет metadata. Повторное прикрепление к тому же событию — 409. `ETag` GET evidence содержит сохранённый hash. Не проверяется подлинность времени/источника или отсутствие злоумышленной модели.

Браузер загружает приватный clip через авторизованный fetch и blob URL; токен не добавляется к ссылке. Для внешних долговечных ссылок потребуется короткоживущая подписанная выдача; v0.1 её не реализует. Скопированная ссылка на API без авторизации не откроет видео.

## Фильтры журнала

`GET /api/events?type=fire&status=unreviewed&after=2026-11-12T00:00:00Z&limit=100`.

`after` сравнивается с created_at, сортировка по убыванию. Это polling API, не durable cursor/stream. При более чем 200 новых событиях между опросами UI может не показать весь backlog одним запросом; бесконечная пагинация — следующий этап.

## Ошибки

- 400: некорректная схема/body/доступный формат.
- 401: токен отсутствует/неверен.
- 403: неверная роль, запрещённый Origin, выключенный/неодобренный источник или смешивание demo/real.
- 404: нет объекта/кадра.
- 409: кадры не по порядку, ID картинки не совпадает, запись уже прикреплена.
- 410: metadata записи есть, но файл потерян.
- 413: превышение размера body.
- 416: неподдерживаемый/некорректный диапазон видео.
- 429: дневной frame-budget либо rate limit, наблюдение приостановлено.
- 507: evidence storage budget исчерпан.

Ответ: `{"error":"..."}`. Внутренние исключения и пути не раскрываются клиенту. Collector fail-fast по критическим API-ошибкам; постоянная очередь retry отсутствует.

## Ограничение запросов и Origins

По умолчанию collector — 15 тыс. запросов/мин на remoteAddress, viewer — 600, неавторизованные — 60. При 100 камерах на 1 fps и отдельной передаче JPEG это около 12 тыс. запросов/мин до clips. Reverse proxy должен отдельно ограничивать входящие body/connection rates. `X-Forwarded-For` не используется как доверенный идентификатор.

Cross-origin доступ — только к точным Origin из `ALLOWED_ORIGINS`, без `*`. Разрешён Authorization и X-Frame-ID, в ответе exposed X-Frame-ID. Если frontend и API разнесены, нужно настроить и CORS, и доверенный HTTPS endpoint.
