# Состояние v0.1

## Реализовано

- Закрытый репозиторий, документация, source registry и resource planner.
- Адаптивный интерфейс: камеры/зоны, рамки, события, карточки, видео, отметки оператора.
- Три собственных синтетических MP4 H.264, watermark и соответствующие учебные сцены.
- API с двумя ролями, SQLite WAL, идемпотентным ingest, temporal confirmation, cooldown, audit reviews и дневной квотой.
- Отдельный приём JPEG с frame_id и запрет рисовать рамки на несоответствующем кадре.
- Приватная выдача MP4 с Range, SHA-256 metadata и storage budget.
- Cloud collector source/config gate, FFmpeg ring, YOLOv8 ONNX adapter и сборка event evidence.
- Dockerfiles API/collector, генерация секретов, retention tool, ручной CI workflow.

## Проверено

18 Node tests: схема, время, temporal logic, duplicate/order/budget, approved source, demo isolation, review audit, API roles, загрузка и range playback MP4, frame matching, перезапуск БД и retention. 3 Python checks: отклонение неверного SHA-256 весов, преобразование YOLOv8 рамок/NMS на shape-fixture и реальный FFmpeg ring/JPEG/сборка MP4 на собственном синтетическом видео. Это не оценка accuracy модели.

Браузер: desktop/mobile, видео длительностью 12 секунд, создание demo-события, подтверждение, фильтры зон, ресурсный калькулятор, подключение API, отсутствие uncaught JS errors.

Дополнительные изменения и последующие проверки отмечаются в финальном отчёте разработки. Сохранённые screenshots — учебные данные.

## Не подтверждено / не запущено

- Нет активных реальных московских камер: **0 / 100**.
- Нет предоставленного пользователем облачного аккаунта/постоянной VM.
- Нет проверенных моделей ДТП/дыма/пожара, измеренных accuracy или latency.
- Не запускались реальные 50–100 потоков, GPU/CPU benchmark и long-running soak test.
- Не доказана бесплатная работа целевого режима 24/7.
- Нет live HLS/WebRTC gateway: API-клиент показывает snapshots, статический demo — учебный video loop.
- Нет надёжной очереди retry, durable jobs на запись и push/Web Push при закрытом браузере.
- Нет автоматических сообщений экстренным службам, персонального SSO и межкамерного tracking.

## Частные адреса

- GitHub: https://github.com/subrosa5/roadwatch
- Приватный frontend: https://roadwatch-moscow-console.dealreal259.chatgpt.site

Sites подтвердил успешную публикацию приватного статического frontend 12 ноября 2026 года. Deployment: `appgdep_6af5bc7d24fc8191b35bc52f0770876f`. Backend/collector этой публикацией не развёрнуты.

Проверки API выполнялись на Node.js 26.8.1; целевой минимум runtime — Node 24. Collector mechanics повторно проверены на Python 3.12 с numpy 2.5.4, OpenCV headless 4.14.0.94 и requests 2.34.2; эти версии зафиксированы. Production Docker images ещё не собирались и не проверялись в облаке.

## Ближайшие этапы

1. Получить разрешённый свежий кадр из облака и проверить геопривязку.
2. Выбрать реально доступный бесплатный cloud resource; подтвердить отсутствие платного перерасхода.
3. Подготовить model manifest и воспроизводимую проверку на целевых сценах.
4. Запустить один полный реальный pipeline с pre/post записью, затем 5/10 потоков.
5. Измерить coverage, пропуски, false alarms и CPU/decode/storage; принять решение о масштабе 50–100.
