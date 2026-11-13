const $ = (id) => document.getElementById(id);
let hosted = false;
const cloudDemo = new URLSearchParams(location.search).has("cloud-demo");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const TYPE = {
  collision: { name: "Возможное ДТП", icon: "↯" },
  smoke: { name: "Возможное задымление", icon: "≋" },
  fire: { name: "Видимое пламя", icon: "♨" },
};
const STATUS = {
  unreviewed: "Не проверено",
  confirmed: "Подтверждено",
  dismissed: "Отклонено",
};
const demoCameras = [
  {
    id: "demo-garden",
    name: "Садовое · учебная сцена",
    zone: "garden",
    demo: true,
    kind: "collision",
  },
  {
    id: "demo-ttk",
    name: "ТТК · учебная сцена",
    zone: "ttk",
    demo: true,
    kind: "smoke",
  },
  {
    id: "demo-mkad",
    name: "МКАД · учебная сцена",
    zone: "mkad",
    demo: true,
    kind: "fire",
  },
];
const now = Date.now();
let savedReviews = {};
try {
  savedReviews = JSON.parse(
    localStorage.getItem("roadwatch-demo-reviews") || "{}",
  );
} catch {}
let events = demoCameras.map((c, i) => ({
  id: "demo-" + c.kind,
  camera_id: c.id,
  type: c.kind,
  captured_at: new Date(now - (i + 1) * 4 * 60000).toISOString(),
  created_at: new Date(now - (i + 1) * 4 * 60000).toISOString(),
  status: savedReviews["demo-" + c.kind] || "unreviewed",
  demo: true,
  recording_status: "ready",
  clip_url: "./clips/" + c.kind + ".mp4",
  model: "synthetic-annotations-v1",
  clock: "synthetic",
  description: [
    "Два автомобиля останавливаются после пересечения траекторий. Учебный пример.",
    "В сцену добавлена синтетическая дымовая область. Это не реальное задымление.",
    "В сцену добавлено синтетическое пламя. Это не реальный пожар.",
  ][i],
}));
let cameras = [...demoCameras],
  selected = cameras[0],
  page = "cameras",
  zone = "all",
  mode = "demo",
  api = "",
  token = "",
  openedEvent = null,
  clipBlob = null,
  frameBlob = null,
  refreshBusy = false,
  displayFrameId = null;
const time = (value) =>
  new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
const dateTime = (value) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
const camera = (id) => cameras.find((c) => c.id === id);
function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  $("toasts").append(node);
  setTimeout(() => node.remove(), 5500);
}
function setPage(value) {
  page = value;
  document
    .querySelectorAll(".page")
    .forEach((el) => el.classList.toggle("active", el.id === "page-" + value));
  document
    .querySelectorAll("[data-page]")
    .forEach((el) => el.classList.toggle("active", el.dataset.page === value));
  const names = {
    cameras: "Камеры",
    events: "События",
    coverage: "Покрытие",
    capacity: "Ресурсы",
    sources: "Источники",
  };
  $("breadcrumb").textContent = names[value];
  $("page-title").textContent = {
    cameras: "Ситуация под наблюдением.",
    events: "Каждое событие — с контекстом.",
    coverage: "Покрытие начинается с источника.",
    capacity: "Ресурсы без скрытых обещаний.",
    sources: "Только проверенные источники.",
  }[value];
  $("page-subtitle").textContent = {
    cameras: "Камеры, признаки происшествий и записи — в одном окне.",
    events: "События, статусы проверки и доступные видеосвидетельства.",
    coverage: "Пилот до 3 камер · число источников определяется замерами.",
    capacity: "Сопоставление нагрузки и бесплатных облачных квот.",
    sources: "Доступность, направление обзора и геопривязка.",
  }[value];
  $("simulate-button").hidden = mode !== "demo";
  document.querySelector(".sidebar").classList.remove("open");
}
function renderEvents() {
  const render = (e) => {
    const type = TYPE[e.type] || TYPE.collision;
    const cam = camera(e.camera_id);
    return `<button class="feed-item" data-event="${esc(e.id)}"><div class="feed-item-heading"><span class="event-type ${esc(e.type)}"><span class="event-icon">${type.icon}</span>${type.name}</span><time>${esc(time(e.captured_at))}</time></div><p>${esc(cam?.name || e.camera_id)}<br>${esc(e.description || "Признаки события обнаружены на двух разных кадрах. Нужна проверка оператором.")}</p><div class="feed-item-footer"><span class="pill">${e.demo ? "ДЕМО · " : ""}${esc(STATUS[e.status] || e.status)}</span><span class="clip-link">${e.recording_status === "ready" ? "Смотреть фрагмент ↗" : "Записи пока нет"}</span></div></button>`;
  };
  $("event-feed").innerHTML =
    events.slice(0, 5).map(render).join("") ||
    '<div class="empty">Событий пока нет</div>';
  const filter = $("event-filter").value;
  const filtered = events.filter(
    (e) =>
      filter === "all" ||
      e.type === filter ||
      (filter === "unreviewed" && e.status === "unreviewed"),
  );
  $("event-table").innerHTML =
    filtered.map(render).join("") ||
    '<div class="empty">Нет событий с выбранным фильтром</div>';
  $("feed-count").textContent = events.length;
  $("event-count").textContent = events.length;
  $("pending-count").textContent = events.filter(
    (e) => e.status === "unreviewed",
  ).length;
  $("nav-event-count").textContent = events.filter(
    (e) => e.status === "unreviewed",
  ).length;
}
function renderPicker() {
  const visible = cameras.filter((c) => zone === "all" || c.zone === zone);
  $("camera-picker").innerHTML =
    visible
      .map(
        (c) =>
          `<button class="camera-choice ${selected?.id === c.id ? "selected" : ""}" data-camera="${esc(c.id)}"><div class="camera-thumb">${c.demo ? `<video src="./clips/${esc(c.kind || "collision")}.mp4" muted playsinline preload="metadata"></video>` : ""}<span>${c.demo ? "SYNTHETIC" : c.embed_url ? "ПУБЛИЧНЫЙ ПЛЕЕР · БЕЗ CV" : esc(c.health === "receiving" ? "КАДРЫ ПОСТУПАЮТ" : "НЕТ СВЕЖИХ КАДРОВ")}</span></div><strong>${esc(c.name)}</strong><small>${c.demo ? "Учебное видео · не Москва" : esc(c.location_note || "Геопривязка не проверена")}</small></button>`,
      )
      .join("") || '<div class="empty">В этой зоне пока нет камер</div>';
  $("scene-count").textContent =
    mode === "demo"
      ? `${visible.length} учебных сцены`
      : `${visible.length} камер в реестре`;
}
async function selectCamera(id) {
  selected = camera(id);
  if (!selected) return;
  renderPicker();
  $("camera-name").textContent = selected.name;
  const demo = mode === "demo";
  let embed = null;
  if (!demo && selected.embed_url) {
    try {
      const u = new URL(selected.embed_url);
      if (
        u.protocol === "https:" &&
        u.hostname === "open.ivideon.com" &&
        u.pathname === "/embed/v3/"
      )
        embed = u.href;
    } catch {}
  }
  const embedNode = $("camera-embed");
  embedNode.hidden = !embed;
  $("viewport").classList.toggle("public-embed", !!embed);
  if (embed) {
    if (embedNode.src !== embed) embedNode.src = embed;
  } else embedNode.removeAttribute("src");
  $("camera-video").hidden = !demo;
  $("camera-frame").hidden = demo || !!embed;
  $("video-unavailable").hidden = demo || !!embed;
  $("pause-button").hidden = !demo;
  $("scene-tag").textContent = demo
    ? "УЧЕБНАЯ СЦЕНА"
    : selected.health === "receiving"
      ? "ПОСЛЕДНИЙ КАДР"
      : "НЕТ СВЕЖИХ ДАННЫХ";
  $("video-label").textContent = demo
    ? "SYNTHETIC / 12s LOOP"
    : "SAMPLED FRAME";
  $("model-name").textContent = demo
    ? "DEMO ANNOTATIONS · НЕ МОДЕЛЬ CV"
    : selected.latest?.model || "МОДЕЛЬ НЕ ПОДКЛЮЧЕНА";
  $("analysis-note").textContent = demo
    ? "Рамки — заранее заданная разметка учебного видео, не результат нейросети."
    : "Оценки модели не являются калиброванными вероятностями. Последний кадр обновляется при опросе API.";
  $("location-title").textContent = demo
    ? "Учебная сцена"
    : selected.latitude != null && selected.longitude != null
      ? `${Number(selected.latitude).toFixed(6)}, ${Number(selected.longitude).toFixed(6)}`
      : "Координаты не проверены";
  $("location-note").textContent = demo
    ? "Реальной геопривязки нет. Координаты события не выдумываются."
    : selected.location_note ||
      "Указано положение камеры; точное место события не установлено.";
  if (demo) {
    $("camera-video").src =
      "./clips/" + (selected.kind || "collision") + ".mp4";
    $("camera-video")
      .play()
      .catch(() => {});
    $("pause-button").textContent = "Ⅱ";
  } else if (embed) {
    $("scene-tag").textContent = "ПЛЕЕР ВЛАДЕЛЬЦА";
    $("video-label").textContent = "PUBLIC EMBED · CV НЕ ПОДКЛЮЧЁН";
    $("model-name").textContent = "СЕРВЕРНЫЙ АНАЛИЗ НЕ ЗАПУЩЕН";
    $("analysis-note").textContent =
      "Встроенный публичный плеер оператора. Свежесть видео и архив не подтверждены. Рамки не рисуются, события автоматически не создаются.";
  } else await refreshFrame();
}
async function request(path, options = {}) {
  if (
    hosted &&
    cloudDemo &&
    ["/api/cameras", "/api/events", "/api/stats"].includes(path)
  )
    path += "?demo=1";
  const response = await fetch(api + path, {
    ...options,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(hosted ? { "X-Roadwatch-Write": "1" } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    let message = "API " + response.status;
    try {
      message = (await response.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  return response;
}
async function refreshFrame() {
  if (mode !== "api" || !selected) return;
  const id = selected.id;
  try {
    const response = await request(
      "/api/cameras/" + encodeURIComponent(id) + "/frame",
    );
    const frameId = response.headers.get("X-Frame-ID");
    const blob = await response.blob();
    if (selected.id !== id) return;
    if (frameBlob) URL.revokeObjectURL(frameBlob);
    frameBlob = URL.createObjectURL(blob);
    displayFrameId = frameId;
    $("camera-frame").src = frameBlob;
    $("video-unavailable").hidden = true;
  } catch {
    if (selected.id === id) $("video-unavailable").hidden = false;
  }
}
async function refresh() {
  if (mode !== "api" || refreshBusy) return;
  refreshBusy = true;
  try {
    const [cs, es, stats] = await Promise.all(
      ["/api/cameras", "/api/events", "/api/stats"].map((p) =>
        request(p).then((r) => r.json()),
      ),
    );
    const old = new Set(events.map((e) => e.id));
    const fresh = es.filter((e) => !old.has(e.id));
    cameras = cs;
    events = es;
    selected = camera(selected?.id) || cameras[0];
    $("connected-count").textContent = stats.receiving_real;
    $("connected-caption").textContent = "Свежие кадры реальных камер";
    $("monitor-mode").textContent = stats.receiving_real
      ? "Кадры поступают"
      : "Нет данных";
    $("monitor-caption").textContent =
      `Бюджет: ${stats.daily_frames} / ${stats.daily_frame_limit} кадров`;
    $("events-caption").textContent =
      stats.mode === "demo"
        ? "Синтетические события API"
        : "События подключённых камер";
    $("connection-error").hidden = true;
    renderEvents();
    renderPicker();
    if (selected) await selectCamera(selected.id);
    for (const e of fresh.slice(0, 3))
      toast(
        TYPE[e.type].name + " · " + (camera(e.camera_id)?.name || e.camera_id),
      );
  } catch (e) {
    $("connection-error").textContent =
      "Нет связи с API: " + e.message + ". Наблюдение не подтверждено.";
    $("connection-error").hidden = false;
    $("connected-count").textContent = "—";
    $("monitor-mode").textContent = "Нет связи";
  } finally {
    refreshBusy = false;
  }
}
async function openEvent(id) {
  const e = events.find((x) => x.id === id);
  if (!e) return;
  openedEvent = e;
  const cam = camera(e.camera_id);
  $("event-dialog-title").textContent = TYPE[e.type].name;
  $("event-details").innerHTML = [
    ["Источник", cam?.name || e.camera_id],
    ["Время кадра · МСК", dateTime(e.captured_at)],
    ["Статус", STATUS[e.status]],
    ["Происхождение", e.demo ? "Синтетический пример" : e.model],
    [
      "Привязка",
      e.demo
        ? "Нет реальных координат"
        : cam?.latitude != null
          ? `${cam.latitude}, ${cam.longitude} · камера`
          : "Координаты не проверены",
    ],
    [
      "Запись",
      e.recording_status === "ready"
        ? "Фрагмент сохранён"
        : "Нет доступного буфера / запись не готова",
    ],
  ]
    .map(
      ([label, value]) =>
        `<div>${esc(label)}<strong>${esc(value)}</strong></div>`,
    )
    .join("");
  $("event-video").hidden = true;
  $("clip-empty").hidden = false;
  $("clip-empty").textContent =
    e.recording_status === "ready"
      ? "Загружаем фрагмент…"
      : "Видео отсутствует. Событие без записи не выдаётся за сохранённый клип.";
  $("download-clip").hidden = true;
  if (!$("event-dialog").open) $("event-dialog").showModal();
  try {
    let src;
    if (mode === "demo") src = e.clip_url;
    else if (e.evidence_id) {
      const response = await request("/api/evidence/" + e.evidence_id);
      clipBlob = URL.createObjectURL(await response.blob());
      src = clipBlob;
    }
    if (src && openedEvent?.id === id) {
      $("event-video").src = src;
      $("event-video").hidden = false;
      $("clip-empty").hidden = true;
      $("download-clip").href = src;
      $("download-clip").download =
        "roadwatch-" + e.type + (e.demo ? "-synthetic" : "") + ".mp4";
      $("download-clip").hidden = false;
    }
  } catch (e) {
    $("clip-empty").textContent = "Не удалось получить запись: " + e.message;
  }
}
function closeEvent() {
  $("event-video").pause();
  $("event-video").removeAttribute("src");
  $("event-video").load();
  if (clipBlob) URL.revokeObjectURL(clipBlob);
  clipBlob = null;
  openedEvent = null;
  $("event-dialog").close();
}
async function review(status) {
  if (!openedEvent) return;
  try {
    if (mode === "api") {
      const response = await request(
        "/api/events/" + openedEvent.id + "/review",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      const updated = await response.json();
      Object.assign(openedEvent, updated);
    } else {
      openedEvent.status = status;
      savedReviews[openedEvent.id] = status;
      try {
        localStorage.setItem(
          "roadwatch-demo-reviews",
          JSON.stringify(savedReviews),
        );
      } catch {}
    }
    renderEvents();
    toast(
      status === "confirmed"
        ? "Событие подтверждено оператором"
        : "Событие отмечено как ложное",
    );
    closeEvent();
  } catch (e) {
    toast("Не удалось сохранить: " + e.message);
  }
}
function demoBoxes(kind, t) {
  const progress = (t % 12) / 12;
  const cars = [
    {
      label: "vehicle",
      score: 0.98,
      box: [0.22 + progress * 0.38, 0.46, 0.105, 0.085],
    },
    {
      label: "vehicle",
      score: 0.95,
      box: [0.64 - progress * 0.27, 0.57, 0.1, 0.085],
    },
  ];
  if (kind === "collision" && t > 4) {
    cars[0].box[0] = 0.398;
    cars[1].box[0] = 0.498;
  }
  if (t > 4)
    cars.push({
      label: kind,
      score: kind === "smoke" ? 0.93 : 0.91,
      box:
        kind === "collision"
          ? [0.38, 0.45, 0.25, 0.22]
          : [0.54, 0.27, 0.18, 0.34],
    });
  return cars;
}
function draw() {
  const canvas = $("overlay"),
    video = $("camera-video"),
    viewport = $("viewport");
  const ratio = window.devicePixelRatio || 1;
  const w = viewport.clientWidth,
    h = viewport.clientHeight;
  if (
    canvas.width !== Math.round(w * ratio) ||
    canvas.height !== Math.round(h * ratio)
  ) {
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const t = video.currentTime || 0;
  const boxes =
    mode === "demo"
      ? demoBoxes(selected?.kind || "collision", t)
      : displayFrameId === selected?.latest?.frame_id
        ? selected.latest.detections
        : [];
  if ($("boxes-toggle").checked) {
    for (const box of boxes) {
      const hot = box.label !== "vehicle",
        color = hot ? "#ffb789" : "#a3f2bc";
      const [x, y, bw, bh] = box.box;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.strokeRect(x * w, y * h, bw * w, bh * h);
      ctx.font = "9px ui-monospace, monospace";
      const label =
        (box.label === "vehicle"
          ? "vehicle"
          : TYPE[box.label]?.name || box.label) +
        " " +
        Math.round(box.score * 100) +
        "%";
      const width = ctx.measureText(label).width + 10;
      ctx.fillStyle = hot ? "#563b28db" : "#1f4530df";
      ctx.fillRect(x * w, y * h - 17, width, 17);
      ctx.fillStyle = color;
      ctx.fillText(label, x * w + 5, y * h - 5);
    }
  }
  $("detection-count").textContent = boxes.length + " объекта";
  $("analysis-tags").innerHTML =
    boxes
      .map(
        (b) =>
          `<span class="${b.label !== "vehicle" ? "hot" : ""}">${esc(b.label)} ${Math.round(b.score * 100)}%</span>`,
      )
      .join("") || "<span>Нет детекций</span>";
  if (mode === "demo") {
    $("frame-time").textContent =
      "DEMO · " + String(Math.floor(t)).padStart(2, "0") + " s";
    $("video-time").textContent =
      "00:" + String(Math.floor(t)).padStart(2, "0") + " / 00:12";
    document.querySelector(".timeline span").style.width = (t / 12) * 100 + "%";
  } else {
    $("frame-time").textContent = selected?.latest?.captured_at
      ? time(selected.latest.captured_at) + " МСК"
      : "ВРЕМЯ НЕИЗВЕСТНО";
    $("video-time").textContent = "Последний кадр";
  }
  requestAnimationFrame(draw);
}
function calculate() {
  const n = Number($("capacity-cameras").value),
    fps = [1 / 1800, 1 / 300, 1, 2, 5, 10][Number($("capacity-fps").value)],
    cpu = Number($("capacity-cpu").value),
    bitrate = Number($("capacity-bitrate").value);
  $("camera-output").textContent = n;
  $("fps-output").textContent =
    fps < 1
      ? fps === 1 / 1800
        ? "1 кадр / 30 мин"
        : "1 кадр / 5 мин"
      : fps + " fps";
  $("cpu-output").textContent = cpu;
  $("bitrate-output").textContent = bitrate;
  const frames = n * fps * 86400,
    hours = (frames * 30 * cpu) / 3600000,
    gb = (((n * bitrate * 1e6) / 8) * 86400) / 1e9,
    buffer = (((n * bitrate * 1e6) / 8) * 60) / 1e9;
  $("capacity-frames").textContent = Math.round(frames).toLocaleString("ru-RU");
  $("capacity-hours").textContent =
    hours.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " ч";
  $("capacity-bandwidth").textContent =
    gb.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " ГБ";
  $("capacity-buffer").textContent =
    buffer.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ГБ";
  const fits = hours <= 4;
  $("capacity-verdict").classList.toggle("fit", fits);
  $("capacity-verdict").textContent = fits
    ? "По этой оценке модель укладывается в 4 CPU-часа. Это не подтверждение: декодирование, память, повторы и доступ к камерам требуют измерения."
    : "Активного CPU требуется в " +
      (hours / 4).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) +
      " раза больше бесплатного лимита Vercel. Бесплатный режим 24/7 с такими параметрами не подтверждён.";
}

document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-page]");
  if (nav) setPage(nav.dataset.page);
  const cam = e.target.closest("[data-camera]");
  if (cam) selectCamera(cam.dataset.camera);
  const item = e.target.closest("[data-event]");
  if (item) openEvent(item.dataset.event);
  const z = e.target.closest("[data-zone]");
  if (z) {
    zone = z.dataset.zone;
    document
      .querySelectorAll("[data-zone]")
      .forEach((b) => b.classList.toggle("selected", b === z));
    renderPicker();
  }
});
$("notification-button").onclick = $("all-events-button").onclick = () =>
  setPage("events");
$("notice-sources").onclick = () => setPage("sources");
$("menu-button").onclick = () =>
  document.querySelector(".sidebar").classList.toggle("open");
$("close-event").onclick = closeEvent;
$("event-dialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeEvent();
});
$("confirm-event").onclick = () => review("confirmed");
$("dismiss-event").onclick = () => review("dismissed");
$("event-filter").onchange = renderEvents;
$("pause-button").onclick = () => {
  if ($("camera-video").paused) {
    $("camera-video")
      .play()
      .catch(() => {});
    $("pause-button").textContent = "Ⅱ";
  } else {
    $("camera-video").pause();
    $("pause-button").textContent = "▷";
  }
};
$("fullscreen-button").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else $("viewport").requestFullscreen?.();
};
$("simulate-button").onclick = () => {
  if (mode !== "demo") return;
  const c = demoCameras[Math.floor(Math.random() * demoCameras.length)];
  const e = {
    id: "demo-" + crypto.randomUUID(),
    camera_id: c.id,
    type: c.kind,
    captured_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    status: "unreviewed",
    demo: true,
    recording_status: "ready",
    clip_url: "./clips/" + c.kind + ".mp4",
    model: "synthetic-annotations-v1",
    description:
      "Создано кнопкой «Демо-событие». Реальное происшествие не зафиксировано.",
  };
  events.unshift(e);
  renderEvents();
  toast(TYPE[e.type].name + " · учебный пример");
};
$("connect-button").onclick = () => $("connect-dialog").showModal();
$("close-connect").onclick = () => $("connect-dialog").close();
$("connect-form").onsubmit = async (e) => {
  e.preventDefault();
  $("connect-error").textContent = "";
  const old = { api, token, mode };
  try {
    const u = new URL($("api-url").value);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      (u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(u.hostname)
        ))
    )
      throw new Error("Нужен HTTPS адрес API или localhost для разработки");
    api = u.href.replace(/\/$/, "");
    token = $("api-token").value;
    const response = await request("/api/stats");
    const stats = await response.json();
    mode = "api";
    events = [];
    $("mode-badge").textContent =
      stats.mode === "demo" ? "Демо API" : "Подключён API";
    $("mode-badge").classList.toggle("real", stats.mode !== "demo");
    $("demo-notice").hidden = stats.mode !== "demo";
    $("simulate-button").hidden = true;
    $("api-token").value = "";
    $("connect-dialog").close();
    await refresh();
    toast("API подключён");
  } catch (error) {
    ({ api, token, mode } = old);
    $("connect-error").textContent = error.message;
  }
};
$("demo-mode-button").onclick = () => {
  location.search = "?demo=1";
};
async function cloudConnect() {
  const h = await fetch("/api/health").then((r) => r.json());
  if (h.backend !== "Sites D1/R2")
    throw new Error("Облачный backend недоступен");
  hosted = true;
  api = "";
  token = "";
  mode = "api";
  events = [];
  $("mode-badge").textContent = cloudDemo
    ? "Учебный облачный API"
    : "Облачный журнал";
  $("mode-badge").classList.toggle("real", !cloudDemo);
  $("demo-notice").hidden = !cloudDemo;
  $("simulate-button").hidden = true;
  await refresh();
  await showProbes();
}
async function showProbes() {
  if (!hosted) return;
  const data = await request("/api/sources").then((r) => r.json());
  $("probe-results").textContent = data.length
    ? data
        .map(
          (p) =>
            `${p.source_id}: ${p.reachable ? "страница отвечает (HTTP " + p.http_status + ")" : p.error || "HTTP " + p.http_status} · ${dateTime(p.checked_at)} МСК · видеопоток не проверен`,
        )
        .join(" | ")
    : "Облачная проверка ещё не запускалась. Видеопотоки не подтверждены.";
}
$("cloud-button").onclick = () => {
  location.search = "";
  cloudConnect().catch((e) => toast(e.message));
};
$("cloud-demo-button").onclick = () => {
  location.search = "?cloud-demo=1";
};
$("probe-button").onclick = async () => {
  if (!hosted) return toast("Сначала откройте облачный журнал");
  $("probe-button").disabled = true;
  try {
    await request("/api/ops/probe-sources", { method: "POST" });
    await showProbes();
  } catch (e) {
    toast(e.message);
  } finally {
    $("probe-button").disabled = false;
  }
};
document
  .querySelectorAll("#page-capacity input")
  .forEach((el) => el.addEventListener("input", calculate));
$("camera-video").addEventListener("error", () => {
  $("video-unavailable").textContent = "Учебное видео недоступно";
  $("video-unavailable").hidden = false;
});
setInterval(() => {
  $("clock").textContent = time(new Date()) + " МСК";
}, 1000);
setInterval(refresh, 5000);
renderEvents();
renderPicker();
selectCamera(selected.id);
calculate();
draw();
if (!new URLSearchParams(location.search).has("demo"))
  cloudConnect().catch((error) => {
    if (!globalThis.ROADWATCH_CLOUD_HOSTED) return;
    mode = "api";
    events = [];
    cameras = [];
    selected = null;
    renderEvents();
    renderPicker();
    $("camera-video").pause();
    $("camera-video").hidden = true;
    $("camera-frame").hidden = true;
    $("camera-embed").hidden = true;
    $("mode-badge").textContent = "Нет связи";
    $("connected-count").textContent = "—";
    $("monitor-mode").textContent = "Нет связи";
    $("simulate-button").hidden = true;
    $("demo-notice").hidden = true;
    $("connection-error").textContent =
      "Облачный API недоступен: " +
      error.message +
      ". Наблюдение не подтверждено.";
    $("connection-error").hidden = false;
  });
