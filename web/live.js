// A video connection is independent from server-side computer vision health.
export function publicStream(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      /^video[24]\.iowadot\.gov$/.test(u.hostname) &&
      u.port === "8888" &&
      /^\/[a-z0-9]+\/[a-z0-9]+\/playlist\.m3u8$/.test(u.pathname) &&
      !u.search &&
      !u.hash
      ? u.href
      : null;
  } catch {
    return null;
  }
}

export class LivePlayer {
  constructor(video, onState) {
    this.video = video;
    this.onState = onState;
    this.source = null;
    this.lastFrame = 0;
    this.lastTime = -1;
    this.engine = null;
    video.addEventListener("timeupdate", () => {
      if (
        !this.source ||
        video.readyState < 2 ||
        !video.videoWidth ||
        video.currentTime === this.lastTime
      )
        return;
      this.lastTime = video.currentTime;
      this.lastFrame = Date.now();
      this.onState({
        status: "playing",
        lastFrame: this.lastFrame,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    });
    video.addEventListener("error", () => {
      if (this.source)
        this.onState({
          status: "error",
          reason: "Не удалось декодировать видео. Повторите подключение.",
        });
    });
    this.timer = setInterval(() => {
      if (this.source && Date.now() - (this.lastFrame || this.started) > 20000)
        this.onState({
          status: "stalled",
          reason:
            "Новых декодированных кадров нет более 20 секунд. Нажмите «Переподключить».",
        });
    }, 2000);
  }
  connect(value, force = false) {
    let relay=null;
    try{const u=new URL(value,location.href);if(u.origin===location.origin&&/^\/api\/cameras\/[a-z0-9-]{1,80}\/watch\/playlist\.m3u8$/.test(u.pathname)&&/^[a-f0-9]{32}$/.test(u.searchParams.get('session')||''))relay=u.href;}catch{}
    const source = publicStream(value)||relay;
    if (source && source === this.source && !force) return;
    this.stop();
    if (!source) return;
    this.source = source;
    this.started = Date.now();
    this.onState({ status: "connecting" });
    const play = () =>
      this.video
        .play()
        .catch(() =>
          this.onState({
            status: "paused",
            reason: "Нажмите ▶ в плеере для начала просмотра.",
          }),
        );
    if (globalThis.Hls?.isSupported()) {
      this.engine = new globalThis.Hls({
        enableWorker: false,
        maxBufferLength: 20,
        backBufferLength: 10,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 3,
      });
      this.engine.on(globalThis.Hls.Events.MANIFEST_PARSED, play);
      this.engine.on(globalThis.Hls.Events.ERROR, (_, data) => {
        if (data.fatal)
          this.onState({
            status: "error",
            reason:
              "Соединение с публичным потоком прервано. Нажмите «Переподключить».",
          });
      });
      this.engine.loadSource(source);
      this.engine.attachMedia(this.video);
    } else if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
      this.video.src = source;
      play();
    } else
      this.onState({
        status: "error",
        reason: "В этом браузере недоступно воспроизведение HLS.",
      });
  }
  programDate(){
    const hlsDate=this.engine?.playingDate;
    if(hlsDate&&Number.isFinite(hlsDate.getTime()))return hlsDate.getTime();
    try{const start=this.video.getStartDate?.();if(start&&Number.isFinite(start.getTime()))return start.getTime()+this.video.currentTime*1000;}catch{}
    return null;
  }
  stop() {
    this.source = null;
    this.lastFrame = 0;
    this.lastTime = -1;
    this.engine?.destroy();
    this.engine = null;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
  destroy() {
    this.stop();
    clearInterval(this.timer);
  }
}
