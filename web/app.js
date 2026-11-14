import {configurePush} from "./push.js";
import { LivePlayer, publicStream } from "./live.js";
const $ = (id) => document.getElementById(id);
let hosted = false;
const playbackStates = new Map();
function renderPlayback(id, url) {
  if (selected?.id !== id) return;
  const state = playbackStates.get(id),
    failed = state?.status === "unavailable" && !state.force;
  $("camera-embed").hidden = !!failed;
  $("embed-unavailable").hidden = !failed;
  $("show-embed").hidden = !failed;
  $("retry-embed").disabled = state?.status === "checking";
  $("open-embed-owner").href = url;
  if (failed) {
    $("camera-embed").removeAttribute("src");
    $("embed-error-detail").textContent =
      state.reason === "api_timeout"
        ? "API Ivideon не ответил на запрос запуска за 8 секунд. Изображение с камеры не получено."
        : "Запрос запуска к API Ivideon завершился ошибкой. Изображение с камеры не получено.";
    $("embed-status").textContent =
      "Запуск не подтверждён. Можно повторить проверку или открыть оригинальный плеер. Это не ошибка детектора CV.";
  } else {
    if ($("camera-embed").src !== url) $("camera-embed").src = url;
    $("embed-status").textContent =
      state?.status === "checking"
        ? "Проверяем API запуска. Воспроизведение выполняется плеером владельца."
        : "Видео во внешнем плеере не подтверждено автоматически. Если оно не появилось, повторите проверку или откройте оригинал.";
  }
}
async function checkPlayback(id, url, force = false) {
  const cached = playbackStates.get(id);
  if (!force && cached) {
    renderPlayback(id, url);
    return;
  }
  playbackStates.set(id, { status: "checking" });
  renderPlayback(id, url);
  try {
    const result = await request(
      "/api/cameras/" +
        encodeURIComponent(id) +
        "/playback-check" +
        (force ? "?refresh=1" : ""),
      { method: "POST" },
    ).then((r) => r.json());
    playbackStates.set(id, result);
  } catch {
    playbackStates.set(id, {
      status: "unverified",
      reason: "check_unavailable",
    });
  }
  renderPlayback(id, url);
}
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
    name: "Учебная сцена · ДТП",
    zone: "interstate29",
    demo: true,
    kind: "collision",
  },
  {
    id: "demo-ttk",
    name: "Учебная сцена · дым",
    zone: "interstate35",
    demo: true,
    kind: "smoke",
  },
  {
    id: "demo-mkad",
    name: "Учебная сцена · огонь",
    zone: "reserve",
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
let displayObservation=null,viewMode="live",viewLease=null,previewBusy=false;
const time = (value) =>
  new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Chicago",
  }).format(new Date(value));
const dateTime = (value) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Chicago",
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
    coverage:
      "Пилот 2 камеры Iowa DOT · число источников определяется замерами.",
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
  $("picker-caption").textContent = mode === "demo" ? "Учебные сцены" : "Публичные потоки Iowa DOT";
  const visible = cameras.filter((c) => zone === "all" || c.zone === zone);
  $("camera-picker").innerHTML =
    visible
      .map(
        (c) =>
          `<button class="camera-choice ${selected?.id === c.id ? "selected" : ""}" data-camera="${esc(c.id)}"><div class="camera-thumb">${c.demo ? `<video src="./clips/${esc(c.kind || "collision")}.mp4" muted playsinline preload="metadata"></video>` : ""}<span>${c.demo ? "SYNTHETIC" : c.stream_url ? (c.collector?.online?"HLS · CV АКТИВЕН":"HLS · CV НЕ АКТИВЕН") : c.embed_url ? "ПУБЛИЧНЫЙ ПЛЕЕР · БЕЗ CV" : esc(c.health === "receiving" ? "КАДРЫ ПОСТУПАЮТ" : "НЕТ СВЕЖИХ КАДРОВ")}</span></div><strong>${esc(c.name)}</strong><small>${c.demo ? "Учебное видео · не реальная камера" : esc(c.location_note || "Геопривязка не проверена")}</small></button>`,
      )
      .join("") || '<div class="empty">В этой зоне пока нет камер</div>';
  $("scene-count").textContent =
    mode === "demo"
      ? `${visible.length} учебных сцены`
      : `${visible.length} камер в реестре`;
}

const livePlayer = new LivePlayer($("camera-live"), (state) => {
  if (!selected?.stream_url) return;
  $("camera-state-dot").className =
    "status-dot " + (state.status === "playing" ? "mint" : "gray");
  $("live-status").textContent =
    state.status === "playing"
      ? `Видео поступает · ${state.width}×${state.height} · кадр получен ${time(state.lastFrame)} CT · ${selected.collector?.online?"коллектор активен":"активность коллектора не подтверждена"}`
      : state.status === "connecting"
        ? "Подключаем публичный HLS-поток Iowa DOT…"
        : state.reason;
});
$("retry-live").addEventListener("click", () => {
  if (selected?.stream_url) livePlayer.connect(selected.stream_url, true);
});
window.addEventListener("pagehide", () => livePlayer.destroy());
async function releaseView() {
 const id=viewLease?.id;viewLease=null;
 if(id)try{await request('/api/cameras/'+id+'/view',{method:'DELETE'});}catch{}
}
async function acquireView() {
 if(!hosted||!selected?.enabled||!['analysis','tracking'].includes(viewMode)||document.hidden)return;
 if(viewLease?.id===selected.id && viewLease.kind===viewMode && Date.now()-viewLease.at<15000)return;
 await request('/api/cameras/'+selected.id+'/view',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:viewMode})});
 viewLease={id:selected.id,kind:viewMode,at:Date.now()};
}
function showFrame(meta,blob) {
 const id=selected?.id,url=URL.createObjectURL(blob),old=frameBlob;
 frameBlob=url;displayFrameId=null;displayObservation=null;
 $('camera-frame').onload=()=>{
  if(selected?.id!==id||frameBlob!==url)return;
  displayObservation=meta;displayFrameId=meta?.frame_id||null;
  if(old)URL.revokeObjectURL(old);
 };
 $('camera-frame').src=url;$('video-unavailable').hidden=true;
}
async function refreshPreview() {
 if(previewBusy||viewMode!=='analysis'||document.hidden||!selected?.enabled)return;
 const id=selected.id;previewBusy=true;
 try {
  await acquireView();
  const data=await(await request('/api/cameras/'+id+'/preview')).json();
  if(selected?.id!==id||viewMode!=='analysis')return;
  const bytes=Uint8Array.from(atob(data.jpeg),c=>c.charCodeAt(0));
  showFrame(data.observation,new Blob([bytes],{type:'image/jpeg'}));
  $('scene-tag').textContent=data.stale?'УСТАРЕВШИЙ АНАЛИЗ':'АНАЛИЗ ОТДЕЛЬНОГО КАДРА';
  $('model-name').textContent=data.observation.model;
 }catch{
  if(selected?.id===id&&!displayFrameId){$('video-unavailable').textContent='Ожидаем проанализированный кадр от облачного коллектора';$('video-unavailable').hidden=false;}
 }finally{previewBusy=false;}
}
let trackingBusy=false,nextTrackingPoll=0;
async function refreshTracking(){
 if(Date.now()<nextTrackingPoll||trackingBusy||viewMode!=='tracking'||document.hidden||!selected?.enabled)return;
 const id=selected.id;trackingBusy=true;
 try{
  await acquireView();
  const data=await(await request('/api/cameras/'+id+'/tracking')).json();
  if(selected?.id!==id||viewMode!=='tracking')return;
  if(data.stale){nextTrackingPoll=Date.now()+5000;displayObservation=null;displayFrameId=null;$('video-unavailable').hidden=false;$('video-unavailable').textContent='Поток анализа устарел. Сопровождение не подтверждено.';return;}
  if(displayFrameId!==data.observation.frame_id){
   const bytes=Uint8Array.from(atob(data.jpeg),c=>c.charCodeAt(0));
   showFrame(data.observation,new Blob([bytes],{type:'image/jpeg'}));
  }
  $('scene-tag').textContent='ОБЛАЧНЫЙ ТРЕКИНГ · ID ТРАНСПОРТА';
  $('model-name').textContent=data.observation.model;
  $('analysis-note').textContent='Реальный NanoDet находит транспорт; optical flow ведёт его между детекциями. ID относится к текущему проходу камеры, после потери объекта может измениться. Рамки и изображение получены вместе из облака.';
 }catch{
  if(selected?.id===id&&viewMode==='tracking'){
   nextTrackingPoll=Date.now()+5000;displayObservation=null;displayFrameId=null;$('video-unavailable').hidden=false;
   $('video-unavailable').textContent='Нет облачных кадров сопровождения. Запусти коллектор по инструкции «Источники»; браузер не выполняет inference.';
  }
 }finally{trackingBusy=false;}
}
setInterval(()=>void refreshTracking(),200);
setInterval(()=>{if(viewMode==='analysis')void refreshPreview();},5000);
for(const modeName of ['live','analysis','tracking'])$('mode-'+modeName).addEventListener('click',async()=>{
 viewMode=modeName;nextTrackingPoll=0;displayFrameId=null;displayObservation=null;
 if(modeName==='live')void releaseView();
 if(selected)await selectCamera(selected.id);
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)void releaseView();else if(viewMode==='analysis')void refreshPreview();else if(viewMode==='tracking')void refreshTracking();});
configurePush({button:$('push-button'),status:$('push-state'),request,hosted:()=>hosted});
async function selectCamera(id) {
  if(viewLease?.id && viewLease.id!==id)void releaseView();
  if(selected?.id!==id){displayFrameId=null;displayObservation=null;}
  selected = camera(id);
  if (!selected) return;
  renderPicker();
  $("camera-name").textContent = selected.name;
  const demo = mode === "demo";
  const stream = !demo ? publicStream(selected.stream_url) : null;
  const analysis=!!stream && hosted && ['analysis','tracking'].includes(viewMode) && !!selected.enabled;
  const live = !!stream && !analysis;
  $('view-modes').hidden=!stream||!hosted;
  $('mode-analysis').disabled=!selected.enabled;
  $('mode-tracking').disabled=!selected.enabled;
  $('mode-tracking').classList.toggle('selected',analysis&&viewMode==='tracking');
  $('mode-analysis').classList.toggle('selected',analysis&&viewMode==='analysis');
  $('mode-live').classList.toggle('selected',live);
  if(!analysis && viewLease)void releaseView();
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
  $("viewport").classList.toggle("public-embed", !!embed || live);
  $("embed-help").hidden = !embed;
  document.querySelector(".camera-controls").hidden = !!embed || live;
  $("camera-live").hidden = !live;
  $("live-help").hidden = !live;
  if (!live) livePlayer.stop();
  $("camera-state-dot").className =
    "status-dot " + (demo || selected.health === "receiving" ? "mint" : "gray");
  if (embed) {
    void checkPlayback(selected.id, embed);
  } else {
    embedNode.removeAttribute("src");
    $("embed-unavailable").hidden = true;
  }
  $("camera-video").hidden = !demo;
  $("camera-frame").hidden = demo || !!embed || live;
  $("video-unavailable").hidden = demo || !!embed || live || (analysis && !!displayFrameId);
  $("pause-button").hidden = !demo;
  document.querySelector(".timeline").hidden=analysis;
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
  } else if (live) {
    $("camera-video").pause();
    displayFrameId=null;displayObservation=null;
    $("video-label").textContent = selected.collector?.online?"IOWA DOT · HLS · КОЛЛЕКТОР АКТИВЕН":"IOWA DOT · HLS · CV НЕ ПОДКЛЮЧЁН";
    $("analysis-note").textContent =
      selected.collector?.online
      ? "Коллектор активен. Открой «Транспорт · трекинг» для облачных рамок и ID машин или «Огонь / дым» для анализа происшествий."
      : "Прямой поток Iowa DOT. Для облачного трекинга запусти коллектор по инструкции на вкладке «Источники». Без него транспорт не анализируется.";
    $("live-owner").href = selected.source_page;
    livePlayer.connect(stream);
  } else if (analysis) {
    $('camera-video').pause();
    $('video-label').textContent=viewMode==='tracking'?'ОБЛАЧНОЕ СОПРОВОЖДЕНИЕ ТРАНСПОРТА':'АНАЛИЗ · ОТДЕЛЬНЫЕ КАДРЫ';
    $('analysis-note').textContent='Рамки соответствуют только показанному кадру. Время — получение изображения коллектором; оценки модели не являются вероятностью происшествия.';
    if(viewMode==='tracking')await refreshTracking();else await refreshPreview();
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
    showFrame(selected.latest?.frame_id===frameId?selected.latest:null,blob);
  } catch {
    if (selected.id === id) $("video-unavailable").hidden = false;
  }
}
async function refresh() {
  if (mode !== "api" || refreshBusy || document.hidden) return;
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
    const online=stats.collectors_online??stats.receiving_real;
    $("connected-count").textContent = online;
    $("connected-caption").textContent = 'Активные облачные коллекторы';
    $("monitor-mode").textContent = online?'Анализ активен':'Ожидает запуска';
    $('collector-status').textContent=cameras.filter(c=>!c.demo).map(c=>{
      const h=c.collector;return c.name+': '+(h?.online?'работает · '+h.frames_analyzed+' кадров':h?.state==='backoff'?'переподключается':h?.state==='quota_exhausted'?'остановлена публикация: квота':'активность не подтверждена');
    }).join(' | ')||'Нет активного коллектора';
    $('feed-status').textContent=online?'Коллектор активен. Здесь появятся подтверждённые кандидаты; каждое событие требует проверки оператором.':'Активность коллектора не подтверждена. Для фонового анализа нужен облачный запуск из инструкции.';
    $('source-summary').textContent=`Видео: 2 · CV: ${online}`;
    $('source-cbtv51').textContent=cameras.find(c=>c.id==='iowa-cbtv51')?.collector?.online?'Коллектор активен':'Ожидает запуска';
    $('tracking-status').textContent=`Сопровождение транспорта: ${stats.tracking_quota??0} / ${stats.tracking_daily_limit??24000} кадров просмотра за сутки. Обработка выполняется в облачном коллекторе.`;
    $('preview-budget').textContent=`Просмотр анализа: ${stats.preview_quota??0} / ${stats.preview_daily_limit??6000} кадров за сутки`;
    $('maintenance-status').textContent=stats.maintenance?.state==='ok'?'Очистка выполнена '+dateTime(stats.maintenance.received_at):'Очистка запускается автоматически при работе коллектора или обращениях к API';
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
    if(openedEvent){const updated=events.find(e=>e.id===openedEvent.id);if(updated?.evidence_id && updated.evidence_id!==openedEvent.evidence_id){if(clipBlob)URL.revokeObjectURL(clipBlob);clipBlob=null;await openEvent(updated.id);}}
    const linked=new URL(location.href).searchParams.get('event');
    if(linked && events.some(e=>e.id===linked)){const url=new URL(location.href);url.searchParams.delete('event');history.replaceState(null,'',url);await openEvent(linked);}
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
    ["Время кадра · CT", dateTime(e.captured_at)],
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
      : displayFrameId && displayFrameId === displayObservation?.frame_id
        ? displayObservation.detections
        : [];
  const image=mode==='demo'?video:$('camera-frame');
  const iw=image.videoWidth||image.naturalWidth||w,ih=image.videoHeight||image.naturalHeight||h;
  const scale=Math.min(w/iw,h/ih),pw=iw*scale,ph=ih*scale,ox=(w-pw)/2,oy=(h-ph)/2;
  if ($("boxes-toggle").checked) {
    for (const box of boxes) {
      const hot = box.label !== "vehicle",
        color = hot ? "#ffb789" : "#a3f2bc";
      const [x, y, bw, bh] = box.box;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.strokeRect(ox+x*pw,oy+y*ph,bw*pw,bh*ph);
      ctx.font = "9px ui-monospace, monospace";
      const label =
        (box.label === "vehicle"
          ? "vehicle"+(box.track_id?" #"+box.track_id:"")
          : TYPE[box.label]?.name || box.label) +
        " " +
        Math.round(box.score * 100) +
        "%";
      const width = ctx.measureText(label).width + 10;
      ctx.fillStyle = hot ? "#563b28db" : "#1f4530df";
      ctx.fillRect(ox+x*pw,Math.max(0,oy+y*ph-17),width,17);
      ctx.fillStyle = color;
      ctx.fillText(label,ox+x*pw+5,Math.max(12,oy+y*ph-5));
    }
  }
  $("detection-count").textContent =
    mode !== "demo" && !displayObservation
      ? (selected?.collector?.online?"Рамки — во вкладке анализа":"Нет подтверждённого анализа")
      : boxes.length + " объекта";
  $("analysis-tags").innerHTML =
    boxes
      .map(
        (b) =>
          `<span class="${b.label !== "vehicle" ? "hot" : ""}">${esc(b.label)}${b.track_id?' #'+esc(b.track_id):''} ${Math.round(b.score * 100)}%</span>`,
      )
      .join("") ||
    (mode !== "demo" && !displayObservation
      ? "<span>Нет данных анализа</span>"
      : "<span>Нет детекций</span>");
  if (mode === "demo") {
    $("frame-time").textContent =
      "DEMO · " + String(Math.floor(t)).padStart(2, "0") + " s";
    $("video-time").textContent =
      "00:" + String(Math.floor(t)).padStart(2, "0") + " / 00:12";
    document.querySelector(".timeline span").style.width = (t / 12) * 100 + "%";
  } else {
    $("frame-time").textContent = displayObservation?.captured_at
      ? time(displayObservation.captured_at) + " CT"
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
  const fits = frames <= 500;
  $("capacity-verdict").classList.toggle("fit", fits);
  $("capacity-verdict").textContent =
    `${Math.round(frames).toLocaleString("ru-RU")} кадров/сутки при лимите API 500. ` +
    (fits
      ? "Наблюдения укладываются в лимит API. "
      : "Нельзя отправлять каждый результат в текущий API; в пилоте уже используется агрегация. ") +
    "Пилот: до 400 архивных попыток и 6000 preview в сутки независимо от числа локальных inference. Расчёт CPU не включает декодирование; статус исполнителя — на вкладке камер.";
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
$("retry-embed").onclick = () => {
  if (selected?.embed_url)
    void checkPlayback(selected.id, selected.embed_url, true);
};
$("show-embed").onclick = () => {
  if (!selected?.embed_url) return;
  const state = playbackStates.get(selected.id) || {};
  playbackStates.set(selected.id, { ...state, force: true });
  renderPlayback(selected.id, selected.embed_url);
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
            `${p.source_id}: ${p.source_id.startsWith("playback:") ? (p.status === "unavailable" ? "API запуска недоступен (" + p.reason + ")" : "API ответил; видео не подтверждено") : p.reachable ? "страница отвечает (HTTP " + p.http_status + ")" : p.error || "HTTP " + p.http_status} · ${dateTime(p.checked_at)} CT · видеопоток не проверен`,
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
  $("clock").textContent = time(new Date()) + " CT";
}, 1000);
setInterval(refresh, 10000);
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
