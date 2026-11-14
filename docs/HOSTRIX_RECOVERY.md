# Hostrix: восстановление после pip ENOSPC

14 ноября 2026. Пользователь создал бесплатный Python-сервер, загрузил обычный ZIP и запустил установку. Hostrix сообщил об автоматическом добавлении `opencv-python`, несмотря на уже указанный `opencv-python-headless`. Затем pip упал с OSError 28 при записи временного буфера HTTP-загрузки; повторная установка пакетов по одному со стороны Hostrix не устраняет причину.

Подтверждено исчерпание места на файловой системе, используемой установкой. Не установлено, какой именно лимит достигнут: квота проекта 1 ГБ, системный tmp, inodes или диск узла. Показатель Disk 0.1 MB в панели не доказывает наличие места в tmp/global package location. Сеть оборвалась как следствие ошибки записи, а не как подтверждённая первичная причина.

## Исправленный пакет

`python3 tools/build-hostrix.py /absolute/path/roadwatch-hostrix-fix.zip`

Старт: `python3 -u hostrix_bootstrap.py --repair`. В Hostrix отключить автоматическую установку `Install packages first`, оставить Python 3.12 и ROADWATCH_MODE=preflight. Bootstrap:

- Печатает объём свободного места для проекта и системного tmp, без секретов.
- В режиме `--repair` использует `pip cache purge`, только если путь кеша лежит в каталоге проекта или home текущего runtime account. Системные каталоги и global site-packages не удаляет.
- Ставит полный закреплённый набор из девяти binary wheels по одному в `.rw-packages` с `--no-cache-dir --no-compile --no-deps`; временные данные — `.rw-install-tmp` внутри проекта.
- Только один OpenCV — headless; глобальная GUI-копия не удаляется, но приложение использует свою изолированную копию. Свежий процесс проверяет пути всех основных импортов.
- При совпадении версий повторно пакеты не скачивает. Затем запускает исходный main.py с сохранением приватных переменных окружения; SDK, модели, алгоритмы и API не изменены.
- При ошибке останавливается и сообщает стадию; не пытается обходить квоты или удалять чужие данные.

Новый архив не содержит секретов, бинарных весов, записей или установленного окружения. Перед повторным развёртыванием сохранить данные, если на хосте уже есть что-то кроме текущего проекта; функция Redeploy хостинга удаляет существующие файлы.

## Проверка

Manual workflow `.github/workflows/hostrix-install.yml` собирает recovery ZIP, устанавливает пакеты на чистом Python 3.12 Linux, проверяет изолированные импорты, повторный запуск без переустановки и footprint <600 МиБ (без весов/кольца). Это проверка пакета, не подтверждение свободного tmp/диска или успешного preflight именно на Hostrix.

На самом Hostrix нужно получить `dependencies_ready`, `isolated_imports_verified` и успешный результат model/camera preflight. Если панель снова запускает автоустановщик до `disk_diagnostics`, выбранные Startup settings не применились либо провайдер не позволяет его отключить. Повторять установку вслепую нельзя.

Документация: https://pip.pypa.io/en/stable/topics/caching/ и https://pip.pypa.io/en/stable/cli/pip_install/ . У OpenCV все варианты используют namespace cv2; нужно выбирать только один: https://pypi.org/project/opencv-python-headless/ .

## Реальный результат Hostrix и калибровка скорости

Лог владельца от 14.11: isolated_imports_verified=true, installed_mib=381.52; свежая Iowa камера доступна, hashes моделей прошли; fire CPU median 51.59 мс, RSS upper sum 219.38 МиБ. Preflight отверг запуск из-за vehicle_tracking_cpu_ms_max=363.89 мс при прежнем пороге 150 мс. По одному максимуму неизвестно, был ли виноват только холодный запуск; прогретая статистика тогда не печаталась.

Исправление измеряет 30 вызовов tracker, отдельно detector/flow, исключает первые две detector-инициализации из медианы и сохраняет максимальные CPU/wall времена в отчёте. Для 0.5 vCPU inference получает бюджет 0.35 CPU-сек/сек, остальное резервируется декодированию, сети и служебной работе. При необходимости новые детекции выполняются реже (интервал 0.5–1 секунды), optical flow/выход остаются целевыми 5 fps; ниже 1 Hz detector ради прохождения gate не опускается. Это оценка допуска, не подмена измерения throughput.

После допуска **каждый preflight/run** выполняет реальную 20-секундную проверку потока с обеими моделями, кольцом FFmpeg и выбранным cadence. Требуются >=80% целевого fps, <=5% кадров старше секунды и сохранённые лимиты памяти. Без успешного throughput_gate_passed мониторинг не начинается. В collector polling четверть frame interval вместо полного interval: время inference больше не добавляется к полной паузе между каждым кадром.

Для обновления на Hostrix достаточно распаковать свежий recovery ZIP с заменой файлов через обычный Unzip. Не использовать Redeploy, который удаляет .rw-packages/data. Версии зависимостей и hashes моделей не менялись, поэтому повторная загрузка 382 МиБ не нужна. Startup command остаётся python3 -u hostrix_bootstrap.py --repair, автоматический installer выключен. Новые результаты необходимо получить на самом Hostrix — успешный Linux CI не заменяет этот этап.

Проверка исправления commit 1c48c43: [полный CI](https://github.com/subrosa5/roadwatch/actions/runs/43597848129) и [реальный Linux load test](https://github.com/subrosa5/roadwatch/actions/runs/43597845620) — success. На GitHub под 0.5 CPU / 512 МиБ: warm detector median 75.75 мс (8 samples), inference CPU estimate 0.1608 CPU-сек/сек, 101 кадр / 20.58 сек = 4.907 fps, stale_frames=0, максимальный возраст файла 42.8 мс, RSS upper sum 352.09 МиБ. Private API writes=false. Это результат GitHub, повторный запуск на Hostrix ещё требуется. Desktop recovery ZIP обновлён: 31770 байт, SHA-256 ed950d9b65f1fa90be09c54814f0f0c1ae3549293c6598e9bd76c97861cdf3de.

Фактический повторный preflight на Hostrix по логу владельца от 14.11 13:12 UTC прошёл: warm detector median 199.43 мс, detector interval 0.617 сек, inference CPU estimate 0.3497 CPU-сек/сек; resource_gate_passed=true. Реальный поток: 85 кадров / 20.13 сек = 4.222 fps, max frame age 0.210 сек, stale_frames=0, track_observations=90; RSS upper sum 324.30 МиБ, cgroup memory peak 237.13 МиБ; throughput_gate_passed=true. private_api_writes=false, mode=preflight, exit code 0. Следующий этап — сервисные ключи и ROADWATCH_MODE=run; production heartbeat пока не подтверждён.


## Подтверждённый run и исправление пустого tracking

14.11: mode=run, API collectors_online=1, state=running, 1280 обработанных кадров; свежие JPEG/observations сохраняются, события пока не обнаружены. Возраст tracking на frontend 2.8–4.2 секунды оказался больше старого порога 3 с, хотя POST принимал 5 с. Оба порога согласованы на 5 с; при задержке изображение остаётся с честным статусом. Пакетная пересылка до 8 исходных кадров и browser playout по временным меткам уменьшают потери из-за sequential HTTP latency. Leases привязаны к вкладке. Старый collector совместим с новым API.

Hostrix build теперь использует 4 fps: при 5 fps реальные измерения колебались 3.68–4.22 и gate иногда прерывал запуск. Gate не отключён. Дневной inference CPU budget увеличен с 21600 до 36000 секунд, чтобы прежний лимит не останавливал фоновую работу раньше суток при оценке 0.35 CPU-сек/сек. При stale display packet collector повторяет передачу вместо аварийного завершения мониторинга. Обновление — обычный Upload + Unzip с заменой, без Redeploy; зависимости, модели и secrets сохраняются. ROADWATCH_MODE=run, команда прежняя.


## Проверка опубликованного исправления

Sites source `4ad05eed8d6ae3a432f9f3a4f75d8cd3e361f015`, deployment `appgdep_6af86a26a2ac8191a5c9986dea0503eb`: succeeded, прежний owner-private URL. Production browser probe 14:04 UTC: collectors_online=1, реальные frame_id меняются, overlay видим, API сообщил до двух vehicle tracks; uncaught errors=0. На момент проверки на Hostrix работал старый одиночный транспорт — обратная совместимость подтверждена. Пакетная передача активируется после загрузки нового ZIP; её полный loopback E2E уже прошёл с искусственной задержкой сети (3 согласованных кадра в пакете, MP4/hash/Range исправны), browser fixture проверил восстановление после stale.

[Полный CI изменения](https://github.com/subrosa5/roadwatch/actions/runs/43602912918): success, 41 Node test, 21 Python test и collector→Worker E2E. Recovery ZIP: 32226 байт, SHA-256 `025f38591f025011a6c7465721129458ac84298fa2542418129db5d86f636910`. Установленные зависимости и hashes моделей прежние. Полные сутки uptime и accuracy ДТП/пожаров не подтверждены.


Повторный production browser probe 14:07 UTC действительно отрисовал две vehicle рамки с ID c3637e8b-58 и -59 (скриншот docs/screenshots/hostrix-tracking.png). Одновременно выявлен отдельный health bug: heartbeat раз в 60 с, но online требовал last_frame_at моложе 20 с, поэтому рабочий collector периодически отображался offline. Окно телеметрии согласовано с cadence: 90 с, при этом свежесть tracking остаётся 5 с. Тесты проверяют online на 45 с и offline на 91 с; кадры не выдаются за свежие из-за этого изменения.
