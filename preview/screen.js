// QuadroScreen on the web: the printer's touch screen (QuadroScreen 0.2.22, a KlipperScreen-based GTK app) rebuilt in
// HTML at its native 800 x 480. Layout, colours, icons and the G-code each page sends follow the panels in
// QuadroScreen's source (base_panel, cp_main_menu, cp_move, cp_files, cp_job_status, cp_filament, cp_settings,
// cp_calibration, cp_calibration_view). Everything it sends goes through the page's console to the Klipper model,
// so the simulated machine does what the real one would.
const W = 800, H = 480;
const STAGES = {
  homing: { label: "Axis\nHoming", title: "Axis Homing", desc: "Axis homing is in progress." },
  heating: { label: "Toolhead\nHeating", title: "Toolhead Heating", desc: "The print heads are being heated for calibration...", gif: "head-temp.gif" },
  cleaning: { label: "Nozzle\nCleaning", title: "Nozzle Cleaning", desc: "Clean the nozzle with the brush included in the box.", gif: "toolhead_cleaning.gif" },
  leveling: { label: "Leveling\nToolhead", title: "Toolhead Leveling", desc: "The printheads are being calibrated. Please wait...", gif: "head-leveling.gif" },
  bed_calibration: { label: "Build Plate\nCalibration", title: "Build Plate Calibration", desc: "Bed calibration is in progress. Please wait...", gif: "bedleveling.gif" },
  input_shaping: { label: "Input\nShaping", title: "Input Shaping", desc: "Vibration calibration is in progress.\nPlease do not touch the printer.", gif: "shaping.gif" },
};
const MODES = {
  full: { title: "Full Self Check", stages: ["homing", "heating", "cleaning", "leveling", "bed_calibration", "input_shaping"] },
  bed: { title: "Build Plate Leveling", stages: ["homing", "heating", "bed_calibration"] },
  tool: { title: "Toolhead Calibration", stages: ["homing", "heating", "cleaning", "leveling"] },
  shaper: { title: "Input Shaping", stages: ["homing", "input_shaping"] },
};
const FILE = "alignment_test_cube.gcode";
const HEAT = 150, COOL = 40;                       // calibration heating target and the "heads cool" limit (cp_calibration_view)

const CSS = `
.qs-frame { position: relative; width: 100%; aspect-ratio: 5 / 3; overflow: hidden; border-radius: 12px; background: #000; }
.qs { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform-origin: 0 0; display: grid;
  grid-template-columns: 92px 1fr 132px; background: #181818; color: #fff; font: 15px/1.3 Inter, "Segoe UI", system-ui, sans-serif;
  user-select: none; -webkit-user-select: none; }
.qs * { box-sizing: border-box; }
.qs button { font: inherit; color: #fff; cursor: pointer; border: 1px solid #303030; border-radius: 10px; padding: 5px;
  background: linear-gradient(to right, #2c2e30, #232323); min-height: 0; }
.qs button:disabled { opacity: .45; cursor: default; }
.qs img { display: block; pointer-events: none; }
.qs-bar { margin: 10px; background: #1e1e1e; border-radius: 10px; display: flex; flex-direction: column; justify-content: space-around; align-items: center; padding: 6px 0; }
.qs-bar button { background: #1e1e1e; border: 0; width: 64px; height: 64px; display: grid; place-items: center; border-radius: 10px; }
.qs-bar button[aria-current="page"] { background: #2b2d30; }
.qs-bar img { width: 40px; height: 40px; object-fit: contain; }
.qs-main { margin: 10px 0; background: #1e1e1e; border-radius: 10px; padding: 12px 14px; position: relative; overflow: hidden; display: flex; flex-direction: column; }
.qs-side { margin: 10px; background: #1e1e1e; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 7px; }
.qs-side .tool { text-align: center; font-size: 19px; padding: 5px 0; border-radius: 8px; border: 1px solid #303030; background: linear-gradient(to right, #2c2e30, #232323); }
.qs-side button { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; border-radius: 8px; padding: 4px; }
.qs-side button img { width: 30px; height: 30px; object-fit: contain; }
.qs-side .now { font-size: 19px; font-weight: 600; } .qs-side .tgt { font-size: 13px; color: #c9cbd0; }
.qs-fila { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 2px; }
.qs-fila i { width: 24px; height: 24px; border-radius: 50%; border: 2px solid #fff; display: block; }
.qs h2 { margin: 0 0 8px; padding: 0; background: none; display: block; font-size: 20px; font-weight: 600; letter-spacing: 0; text-transform: none; }
.qs .muted { color: #b5b8be; }
.qs .row { display: flex; gap: 10px; align-items: center; }
.qs-home { align-items: center; justify-content: center; text-align: center; gap: 4px; }
.qs-home img.hero { height: 240px; }
.qs-home .t1 { font-size: 30px; font-weight: 700; margin-top: 4px; } .qs-home .t2 { font-size: 18px; font-weight: 300; }
.qs-big { display: inline-flex; align-items: center; gap: 14px; font-size: 22px; padding: 10px 22px !important; margin-top: 10px; }
.qs-big img { width: 30px; height: 30px; }
.qs-list { display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.qs-file { display: flex; align-items: center; gap: 14px; padding: 10px !important; text-align: left; }
.qs-thumb { width: 64px; height: 64px; border-radius: 8px; background: #2a2c2f; display: grid; grid-template-columns: 1fr 1fr; gap: 3px; padding: 9px; flex: none; }
.qs-thumb i { border-radius: 2px; }
.qs-file b { display: block; font-size: 17px; font-weight: 600; } .qs-file span { font-size: 13px; color: #b5b8be; }
.qs-dialog { position: absolute; inset: 0; background: rgba(0,0,0,.6); display: grid; place-items: center; z-index: 5; }
.qs-dialog > div { background: #232426; border: 1px solid #303030; border-radius: 12px; padding: 18px 20px; width: 380px; display: flex; flex-direction: column; gap: 12px; align-items: center; text-align: center; }
.qs-dialog .btns { display: flex; gap: 10px; width: 100%; } .qs-dialog .btns button { flex: 1; padding: 10px !important; font-size: 17px; }
.qs .primary { background: #d9d9d9 !important; color: #1a1a1a !important; border-color: #d9d9d9 !important; font-weight: 600; }
.qs-job { gap: 10px; }
.qs-job .top { display: flex; gap: 16px; align-items: center; }
.qs-ring { width: 128px; height: 128px; position: relative; flex: none; }
.qs-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.qs-ring b { position: absolute; inset: 0; display: grid; place-items: center; font-size: 28px; font-weight: 700; }
.qs-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; flex: 1; }
.qs-stats div { background: #262729; border-radius: 8px; padding: 6px 10px; } .qs-stats span { display: block; font-size: 12px; color: #b5b8be; } .qs-stats b { font-size: 17px; font-weight: 600; }
.qs-job .acts { display: flex; gap: 12px; margin-top: auto; }
.qs-job .acts button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 18px; padding: 10px !important; }
.qs-job .acts img { width: 26px; height: 26px; }
.qs-move .info { display: flex; gap: 10px; align-items: center; font-size: 15px; }
.qs-move .info img { width: 26px; height: 26px; }
.qs-dist { align-self: center; display: flex; gap: 6px; padding: 8px; border-radius: 10px; background: linear-gradient(to right, #2c2e30, #232323); margin-top: 6px; }
.qs-dist button { background: #444 !important; border: 0 !important; color: #bcbcbc !important; font-size: 19px; padding: 4px 14px !important; border-radius: 8px; }
.qs-dist button[aria-pressed="true"] { background: #d9d9d9 !important; color: #171717 !important; }
.qs-pad { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; flex: 1; }
.qs-tcol { display: flex; flex-direction: column; gap: 12px; }
.qs-tcol button { width: 88px; height: 50px; font-size: 22px; font-weight: 600; }
.qs-tcol button[aria-pressed="true"] { background: #d9d9d9 !important; color: #2c2c2c !important; }
.qs-dpad { position: relative; width: 310px; height: 280px; transform: scale(.86); margin: -20px -22px; }
.qs-dpad button { position: absolute; background: none !important; border: 0 !important; padding: 0 !important; }
.qs-dpad button span, .qs-z button span { position: absolute; inset: 0; display: grid; place-items: center; color: #3b3a3a; font-size: 20px; font-weight: 600; }
.qs-dpad .home { left: 125px; top: 98px; width: 90px; height: 90px; background: #d9d9d9 !important; border-radius: 7px; display: grid; place-items: center; }
.qs-z { display: flex; flex-direction: column; gap: 14px; margin-right: 6px; }
.qs-z button { position: relative; background: none !important; border: 0 !important; padding: 0 !important; }
.qs-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.qs-tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; height: 120px; font-size: 14px; text-align: center; }
.qs-tile img { width: 48px; height: 48px; object-fit: contain; }
.qs-cal { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; flex: 1; }
.qs-cal button { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 6px; text-align: left; padding: 12px 14px !important; position: relative; }
.qs-cal img { width: 42px; height: 42px; } .qs-cal b { font-size: 17px; font-weight: 600; } .qs-cal span { font-size: 13px; color: #b5b8be; white-space: pre-line; }
.qs-cal em { position: absolute; top: 10px; right: 10px; font-style: normal; font-size: 11px; background: #6e9753; border-radius: 6px; padding: 2px 7px; }
.qs-steps { display: flex; justify-content: space-between; gap: 4px; margin-bottom: 8px; padding-right: 84px; }
.qs-steps div { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 11px; text-align: center; white-space: pre-line; color: #8d9096; }
.qs-steps div.on { color: #fff; } .qs-steps div.done { color: #9fc785; }
.qs-steps i { width: 22px; height: 22px; border-radius: 50%; border: 2px solid #55585e; display: grid; place-items: center; font-style: normal; font-size: 12px; }
.qs-steps .on i { border-color: #fff; } .qs-steps .done i { background: #6e9753; border-color: #6e9753; }
.qs-stage { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 8px; }
.qs-stage h3 { margin: 0; font-size: 22px; font-weight: 600; } .qs-stage p { margin: 0; color: #d7d9de; white-space: pre-line; }
.qs-stage img.anim { max-height: 170px; max-width: 100%; }
.qs-heads { display: flex; gap: 14px; }
.qs-heads div { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 13px; }
.qs-heads img { width: 48px; height: 48px; }
.qs-temps { display: flex; gap: 10px; font-size: 14px; } .qs-temps span { background: #262729; border-radius: 8px; padding: 4px 10px; }
.qs-back { position: absolute; top: 10px; right: 12px; font-size: 13px !important; padding: 4px 12px !important; }
.qs-fil { display: flex; flex-direction: column; gap: 8px; }
.qs-fil .r { display: flex; align-items: center; gap: 12px; background: #262729; border-radius: 10px; padding: 8px 12px; }
.qs-fil .r i { width: 30px; height: 30px; border-radius: 50%; border: 2px solid #fff; flex: none; }
.qs-fil .r b { font-size: 17px; width: 44px; } .qs-fil .r span { flex: 1; color: #c9cbd0; }
.qs-fil .r button { display: flex; align-items: center; gap: 6px; padding: 6px 12px !important; font-size: 14px; }
.qs-fil .r button img { width: 20px; height: 20px; }
.qs-temp { display: flex; flex-direction: column; gap: 12px; }
.qs-temp .presets { display: flex; gap: 8px; flex-wrap: wrap; } .qs-temp .presets button { padding: 10px 16px !important; font-size: 17px; }
.qs-temp .readout { font-size: 44px; font-weight: 700; } .qs-temp .readout small { font-size: 20px; color: #b5b8be; font-weight: 400; }
.qs-toast { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); background: #3a3c40; border-radius: 8px; padding: 8px 14px; font-size: 14px; z-index: 6; white-space: nowrap; }
`;

export function createScreen(frame, api) {
  if (!document.getElementById("qs-style")) { const s = document.createElement("style"); s.id = "qs-style"; s.textContent = CSS; document.head.append(s); }
  const A = (n) => api.asset(n);
  frame.classList.add("qs-frame");
  frame.innerHTML = `
    <div class="qs" role="application" aria-label="Quadro touch screen">
      <nav class="qs-bar">
        <button data-go="home" aria-label="Home"><img src="${A("home.png")}" alt=""></button>
        <button data-go="move" aria-label="Move"><img src="${A("axis.png")}" alt=""></button>
        <button data-go="files" aria-label="Files"><img src="${A("folder.png")}" alt=""></button>
        <button data-go="filament" aria-label="Filament"><img src="${A("filament.png")}" alt=""></button>
        <button data-go="settings" aria-label="Settings"><img src="${A("settings.png")}" alt=""></button>
      </nav>
      <main class="qs-main"></main>
      <aside class="qs-side">
        <div class="tool" data-k="tool">Tool 1</div>
        <button data-go="temp-ext" aria-label="Extruder temperature"><img src="${A("extruder.png")}" alt=""><span class="now" data-k="ext">25°</span><span class="tgt" data-k="ext-t">0°</span></button>
        <button data-go="temp-bed" aria-label="Bed temperature"><img src="${A("heater-bed.png")}" alt=""><span class="now" data-k="bed">25°</span><span class="tgt" data-k="bed-t">0°</span></button>
        <button data-go="fan" aria-label="Fan"><img src="${A("fan.png")}" alt=""><span class="now" data-k="fan">0%</span></button>
        <button data-go="filament" aria-label="Filament status"><span class="qs-fila">${[0, 3, 1, 2].map((j) => `<i style="background:${api.colors[j]}"></i>`).join("")}</span></button>
      </aside>
    </div>`;
  const root = frame.firstElementChild, main = root.querySelector(".qs-main"), q = (k) => root.querySelector(`[data-k="${k}"]`);
  // scale the 800 x 480 screen to the card
  const fit = () => { const k = frame.clientWidth / W; root.style.transform = `scale(${k})`; };
  new ResizeObserver(fit).observe(frame); fit();

  let page = "home", sub = null, step = ".1", cal = null, toastTimer = 0, rendered = "";
  const send = (...lines) => lines.forEach((l) => api.run(l));
  const st = () => api.state();
  const printing = () => ["printing", "paused"].includes(st().job);
  function toast(text) {
    root.querySelector(".qs-toast")?.remove();
    const t = document.createElement("div"); t.className = "qs-toast"; t.textContent = text; root.append(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 2200);
  }
  function go(p, s = null) { page = p; sub = s; rendered = ""; render(); }
  root.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));

  const thumb = () => `<div class="qs-thumb">${[3, 2, 0, 1].map((j) => `<i style="background:${api.colors[j]}"></i>`).join("")}</div>`;
  const fmtTime = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`; };

  // ---------- pages ----------
  const PAGES = {
    home() {
      const s = st();
      if (s.job === "printing" || s.job === "paused") return PAGES.job();
      if (s.job === "done") return PAGES.complete();
      return `<div class="qs-home" style="display:flex;flex-direction:column;flex:1">
        <img class="hero" src="${A("quadro.png")}" alt="">
        <div class="t1">Co Print Quadro</div><div class="t2">Welcome to your printer</div>
        <div><button class="qs-big" data-a="files">Start Print <img src="${A("startPrintBlue.png")}" alt=""></button></div></div>`;
    },
    files() {
      return `<h2>Files</h2><div class="qs-list">
        <button class="qs-file" data-a="pick">${thumb()}<div><b>${FILE}</b><span>Alignment test cube · 20 mm · 4 colours · 100 layers</span></div></button>
      </div>${sub === "confirm" ? `<div class="qs-dialog"><div>${thumb()}<b>${FILE}</b><span class="muted">Start printing this file?</span>
        <div class="btns"><button data-a="close">Cancel</button><button class="primary" data-a="print">Print</button></div></div></div>` : ""}`;
    },
    job() {
      const s = st(), pct = Math.floor(s.progress * 100), C = 2 * Math.PI * 54;
      const left = s.progress > 0.01 ? s.elapsed / s.progress - s.elapsed : 0;
      return `<div class="qs-job" style="display:flex;flex-direction:column;flex:1">
        <div class="row">${thumb()}<div><b style="font-size:17px">${FILE}</b><div class="muted" style="font-size:13px">${s.job === "paused" ? "Paused" : "Printing"}${s.active >= 0 ? " · Tool " + (s.active + 1) : ""}</div></div></div>
        <div class="top"><div class="qs-ring"><svg viewBox="0 0 128 128"><circle cx="64" cy="64" r="54" fill="none" stroke="#3a3c40" stroke-width="10"/>
          <circle cx="64" cy="64" r="54" fill="none" stroke="#6e9753" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - s.progress)}"/></svg><b>${pct}%</b></div>
          <div class="qs-stats"><div><span>Layer</span><b>${s.layer} / ${s.layers}</b></div><div><span>Toolchanges</span><b>${s.changes}</b></div>
          <div><span>Elapsed</span><b>${fmtTime(s.elapsed)}</b></div><div><span>Remaining</span><b>${left ? fmtTime(left) : "—"}</b></div></div></div>
        <div class="acts"><button data-a="${s.job === "paused" ? "resume" : "pause"}"><img src="${A(s.job === "paused" ? "resumebutton.png" : "pause.png")}" alt="">${s.job === "paused" ? "Resume" : "Pause"}</button>
          <button data-a="cancel"><img src="${A("stop.png")}" alt="">Cancel</button></div></div>
        ${sub === "cancel" ? `<div class="qs-dialog"><div><b style="font-size:18px">Cancel the print?</b><span class="muted">The print stops and the heaters turn off.</span>
          <div class="btns"><button data-a="close">No</button><button class="primary" data-a="cancel-yes">Cancel print</button></div></div></div>` : ""}`;
    },
    complete() {
      const s = st();
      return `<div class="qs-stage"><img src="${A("stage-done.png")}" alt="" style="width:56px;height:56px"><h3>Print complete</h3>
        <p>${FILE}<br>${fmtTime(s.elapsed)} · ${s.changes} toolchanges</p>
        <p class="muted" style="font-size:14px">Remove the part from the build plate before the next print.</p>
        <div class="row"><button class="qs-big" data-a="clear">Plate cleared</button></div></div>`;
    },
    move() {
      const s = st(), off = printing() ? "disabled" : "", tool = s.active;
      const dist = [".1", "1", "10", "50"].map((d) => `<button data-dist="${d}" aria-pressed="${step === d}" ${off}>${d === ".1" ? "0.1" : d}mm</button>`).join("");
      const pad = (cls, img, lab, x, y, w, h) => `<button class="${cls}" data-mv="${lab}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px" ${off}><img src="${A(img)}" alt="" style="width:${w}px;height:${h}px"><span>${lab}</span></button>`;
      return `<div class="qs-move" style="display:flex;flex-direction:column;flex:1">
        <div class="info"><img src="${A("info.png")}" alt=""><span>${printing() ? "Not allowed during print" : "Select a movement step to control your axes."}</span></div>
        <div class="qs-dist">${dist}</div>
        <div class="qs-pad"><div class="qs-tcol">${[0, 1, 2, 3].map((j) => `<button data-tool="${j}" aria-pressed="${tool === j}" ${off}>T${j + 1}</button>`).join("")}</div>
          <div class="qs-dpad">
            ${pad("", "y-plus.svg", "Y+", 62, 0, 217, 84)}${pad("", "x-plus.svg", "X+", 225, 30, 84, 217)}
            ${pad("", "y-minus.svg", "Y-", 62, 195, 217, 84)}${pad("", "x-minus.svg", "X-", 30, 30, 84, 217)}
            <button class="home" data-a="home" ${off} aria-label="Home all"><img src="${A("home-dark.png")}" alt="" style="width:60px;height:60px"></button>
          </div>
          <div class="qs-z">${["Z+", "Z-"].map((z) => `<button data-mv="${z}" ${off}><img src="${A(z === "Z+" ? "z-plus.svg" : "z-minus.svg")}" alt="" style="width:84px;height:75px"><span>${z}</span></button>`).join("")}</div>
        </div></div>`;
    },
    filament() {
      const s = st(), off = printing() ? "disabled" : "";
      return `<h2>Filament</h2><div class="qs-fil">${[0, 1, 2, 3].map((j) => {
        const h = s.heaters ? s.heaters[j ? "extruder" + j : "extruder"] : null;
        return `<div class="r"><i style="background:${api.colors[j]}"></i><b>T${j + 1}</b><span>PLA · ${api.colorNames[j]}${h ? " · " + Math.round(h.temp) + "°" : ""}</span>
          <button data-load="${j}" ${off}><img src="${A("load.png")}" alt="">Load</button><button data-unload="${j}" ${off}><img src="${A("unload.png")}" alt="">Unload</button></div>`;
      }).join("")}</div>`;
    },
    settings() {
      const tiles = [["calibrations.png", "Calibrations", "cal"], ["maintenance.png", "Maintenance"], ["settingsInfo.png", "Device Information", "info"], ["language.png", "Language"],
        ["print_preferences.png", "Print Preferences"], ["wifi_excellent.png", "Wifi & Network Settings"], ["firmware.png", "Firmware Upgrade"]];
      return `<h2>Settings</h2><div class="qs-grid">${tiles.map(([img, name, a]) => `<button class="qs-tile" data-a="${a ? "set-" + a : "na"}"><img src="${A(img)}" alt="">${name}</button>`).join("")}</div>
        ${sub === "info" ? `<div class="qs-dialog"><div><b style="font-size:18px">Device Information</b><span class="muted" style="text-align:left;line-height:1.6">Model: Co Print Quadro<br>Screen: QuadroScreen 0.2.22<br>Firmware: Klipper with the Quadro modules (simulated in your browser)<br>Toolheads: 4 · Qdock stations: 2 × 3</span>
          <div class="btns"><button data-a="close">OK</button></div></div></div>` : ""}`;
    },
    cal() {
      const cards = [["fullSelfCheck.png", "Full Self Check", "All axes and print heads are calibrated.", "full", true], ["buildPlate.png", "Build Plate Leveling", "It only calibrates the build plate.", "bed"],
        ["toolCalibration.png", "Toolhead Calibration", "It calibrates the four print heads\nalong three axes.", "tool"], ["inputShaping.png", "Input Shaping", "Damps vibrations for the print heads\nand build plate.", "shaper"]];
      return `<h2>Printer Calibration</h2><button class="qs-back" data-a="settings">Back</button><div class="qs-cal">${cards.map(([img, t, d, m, rec]) =>
        `<button data-cal="${m}">${rec ? "<em>Recommended</em>" : ""}<img src="${A(img)}" alt=""><b>${t}</b><span>${d}</span></button>`).join("")}</div>`;
    },
    calview() {
      const c = cal, stages = MODES[c.mode].stages;
      if (c.error) return `<div class="qs-stage"><h3>Calibration Failed</h3><p>${c.error}</p><button class="qs-big" data-a="cal-close">Cancel</button></div>`;
      if (c.i >= stages.length) return `<div class="qs-stage"><img src="${A("stage-done.png")}" alt="" style="width:56px;height:56px"><h3>${MODES[c.mode].title}</h3><p>Calibration complete.</p><button class="qs-big" data-a="cal-close">Finish</button></div>`;
      const key = stages[c.i], S = STAGES[key], s = st();
      const steps = stages.map((k, i) => `<div class="${i < c.i ? "done" : i === c.i ? "on" : ""}"><i>${i < c.i ? "✓" : i + 1}</i>${STAGES[k].label}</div>`).join("");
      let extra = "";
      const heads = s.heaters ? [0, 1, 2, 3].map((j) => s.heaters[j ? "extruder" + j : "extruder"]) : [];
      if (key === "heating" || (key === "leveling" && c.cooling)) extra = `<div class="qs-temps">${(c.mode === "bed" ? [0] : [0, 1, 2, 3]).map((j) => `<span>T${j + 1} ${Math.round(heads[j]?.temp ?? 0)}° / ${key === "heating" ? HEAT : "<" + COOL}°</span>`).join("")}</div>`;
      if (key === "cleaning") extra = `<div class="row"><b>Cleaning ${c.clean + 1} of 4</b><button class="primary" style="padding:8px 26px" data-a="cal-next">Next</button></div>`;
      if (key === "leveling" && !c.cooling) extra = `<div class="qs-heads">${[0, 1, 2, 3].map((j) => `<div><img src="${A(c.tool > j ? "head-done.png" : c.tool === j ? "head-calibrating.png" : "head-waiting.png")}" alt="">Tool ${j + 1}</div>`).join("")}</div>`;
      const desc = key === "leveling" && c.cooling ? "Waiting for the print heads to cool below 40°C..." : S.desc;
      return `<button class="qs-back" data-a="cal-close">Cancel</button><div class="qs-steps">${steps}</div>
        <div class="qs-stage"><h3>${S.title}</h3><p>${desc}</p>${S.gif ? `<img class="anim" src="${A(S.gif)}" alt="">` : ""}${extra}</div>`;
    },
    "temp-ext"() {
      const s = st(), j = sub ?? Math.max(0, s.active), h = s.heaters && s.heaters[j ? "extruder" + j : "extruder"];
      return `<h2>Extruder Temperature</h2><div class="qs-temp"><div class="row">${[0, 1, 2, 3].map((k) => `<button data-et="${k}" class="${k === j ? "primary" : ""}" style="padding:8px 16px">T${k + 1}</button>`).join("")}</div>
        <div class="readout">${h ? Math.round(h.temp) : "--"}° <small>target ${h ? Math.round(h.target) : 0}°</small></div>
        <div class="presets">${[["PLA", 210], ["PETG", 240], ["ABS", 250], ["Off", 0]].map(([n, t]) => `<button data-settemp="${t}">${n}${t ? " " + t + "°" : ""}</button>`).join("")}</div></div>`;
    },
    "temp-bed"() {
      const s = st(), h = s.heaters && s.heaters.heater_bed;
      return `<h2>Bed Temperature</h2><div class="qs-temp"><div class="readout">${h ? Math.round(h.temp) : "--"}° <small>target ${h ? Math.round(h.target) : 0}°</small></div>
        <div class="presets">${[["PLA", 60], ["PETG", 80], ["ABS", 100], ["Off", 0]].map(([n, t]) => `<button data-bedtemp="${t}">${n}${t ? " " + t + "°" : ""}</button>`).join("")}</div></div>`;
    },
    fan() {
      return `<h2>Part Cooling Fan</h2><div class="qs-temp"><div class="readout">${q("fan").textContent}</div>
        <div class="presets">${[0, 25, 50, 75, 100].map((p) => `<button data-fan="${p}">${p}%</button>`).join("")}</div></div>`;
    },
  };

  // ---------- actions ----------
  main.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    const d = b.dataset, s = st();
    if (d.dist) { step = d.dist; rendered = ""; render(); return; }
    if (d.mv) {
      const axis = d.mv[0], sign = d.mv[1], speed = axis === "Z" ? 600 : 3000;
      if (!s.homed.includes(axis.toLowerCase())) { toast("Home the printer first"); return; }
      send("G91", `G0 ${axis}${sign}${step} F${speed}`, "G90"); return;
    }
    if (d.tool !== undefined) { const need = !(s.homed.includes("x") && s.homed.includes("y")); if (need) send("G28 X Y"); send("T" + d.tool); return; }
    if (d.load !== undefined || d.unload !== undefined) {
      const j = Number(d.load ?? d.unload), need = !(s.homed.includes("x") && s.homed.includes("y"));
      if (need) send("G28 X Y");
      send("T" + j, `M109 T${j} S220`, d.load !== undefined ? "LOAD_FILAMENT" : "UNLOAD_FILAMENT");
      toast(`T${j + 1}: heating to 220°, then ${d.load !== undefined ? "loading" : "unloading"}`); return;
    }
    if (d.cal) { if (printing()) { toast("Not allowed during print"); return; } startCal(d.cal); return; }
    if (d.et !== undefined) { sub = Number(d.et); rendered = ""; render(); return; }
    if (d.settemp !== undefined) { const j = sub ?? Math.max(0, s.active); send(`M104 T${j} S${d.settemp}`); return; }
    if (d.bedtemp !== undefined) { send(`M140 S${d.bedtemp}`); return; }
    if (d.fan !== undefined) { send(`M106 S${Math.round(d.fan * 2.55)}`); return; }
    switch (d.a) {
      case "files": go("files"); break;
      case "pick": if (printing()) toast("A print is already running"); else { sub = "confirm"; rendered = ""; render(); } break;
      case "close": sub = null; rendered = ""; render(); break;
      case "print": send("SDCARD_PRINT_FILE FILENAME=" + FILE); go("home"); break;
      case "pause": send("PAUSE"); break;
      case "resume": send("RESUME"); break;
      case "cancel": sub = "cancel"; rendered = ""; render(); break;
      case "cancel-yes": sub = null; send("CANCEL_PRINT"); go("home"); break;
      case "clear": api.clearBed(); go("home"); break;
      case "home": send("G28"); break;
      case "set-cal": go("cal"); break;
      case "set-info": sub = "info"; rendered = ""; render(); break;
      case "settings": go("settings"); break;
      case "na": toast("Not part of the online demo"); break;
      case "cal-next": calNext(); break;
      case "cal-close": cal = null; go("cal"); break;
    }
  });

  // ---------- calibration flow (cp_calibration_view): each stage sends the printer's own macros and waits for
  // CALIBRATION_STATUS, the macro variable those macros set when they finish ----------
  const stageVar = () => String(api.macroVar("CALIBRATION_STATUS", "stage") ?? "").replace(/^"|"$/g, "");
  function startCal(mode) { cal = { mode, i: 0, started: false }; go("calview"); }
  function runStage() {
    const key = MODES[cal.mode].stages[cal.i];
    cal.started = true; cal.wait = null;
    send(`SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=stage VALUE='"IDLE"'`);
    if (key === "homing") { send("CALIBRATE_HOMING"); cal.wait = "CALIBRATION_HOMING_DONE"; }
    else if (key === "heating") { (cal.mode === "bed" ? [0] : [0, 1, 2, 3]).forEach((j) => send(`M104 T${j} S${HEAT}`)); }
    else if (key === "cleaning") { cal.clean = 0; send("T0", "G4 P500", "G90", "G1 X150 Y0 Z20 F12000"); }
    else if (key === "leveling") { cal.cooling = true; [0, 1, 2, 3].forEach((j) => send(`M104 T${j} S0`)); }
    else if (key === "bed_calibration") { send("CALIBRATE_BED_MESH"); cal.wait = "CALIBRATION_BED_DONE"; }
    else if (key === "input_shaping") { send("CALIBRATE_INPUT_SHAPING"); cal.wait = "CALIBRATION_SHAPING_DONE"; }
  }
  function advance() { cal.i++; cal.started = false; rendered = ""; }
  function calNext() {
    const prev = cal.clean;
    if (prev >= 3) { send("M104 T3 S0"); advance(); return; }
    cal.clean = prev + 1; send(`M104 T${prev} S0`, "T" + cal.clean, "G90", "G1 X150 Y0 Z20 F12000"); rendered = "";
  }
  function calTick() {
    if (!cal || page !== "calview" || cal.error) return;
    const stages = MODES[cal.mode].stages; if (cal.i >= stages.length) return;
    if (api.isShutdown()) { cal.error = "The printer stopped (shutdown). Restart the firmware from the console with FIRMWARE_RESTART."; rendered = ""; return; }
    if (!cal.started) { runStage(); rendered = ""; return; }
    const key = stages[cal.i], s = st(), v = stageVar();
    const heads = [0, 1, 2, 3].map((j) => s.heaters[j ? "extruder" + j : "extruder"]);
    if (key === "heating" && (cal.mode === "bed" ? [0] : [0, 1, 2, 3]).every((j) => heads[j].temp >= HEAT - 2)) advance();
    else if (key === "leveling") {
      if (cal.cooling) {
        if (heads.every((h) => h.temp < COOL)) {
          cal.cooling = false; cal.tool = 0; rendered = "";
          send("G90", "T0 X=150", "M400", "G4 P500", "T1 X=150", "M400", "G4 P500", "T2 X=150", "M400", "G4 P500", "T3 X=150", "T0", "M400", "G4 P500",
            "BED_PIN_CALIBRATE_TOOL TOOL=T0 RESET=0 FIRST=0 RETRY=0");
        }
      } else {
        const m = v.match(/^CALIBRATION_LEVELING_T(\d)_DONE$/);
        if (m && Number(m[1]) === cal.tool) {
          cal.tool++; rendered = "";
          if (cal.tool > 3) send("CALIBRATE_LEVELING_FINISH"); else send(`BED_PIN_CALIBRATE_TOOL TOOL=T${cal.tool} RESET=0 FIRST=0 RETRY=0`);
        } else if (v === "CALIBRATION_LEVELING_DONE") advance();
      }
    } else if (cal.wait && v === cal.wait) advance();
  }

  // ---------- refresh ----------
  function sidebar() {
    const s = st(), h = s.heaters;
    q("tool").textContent = s.active >= 0 ? "Tool " + (s.active + 1) : "Tool -";
    if (h) {
      const e = h[s.active > 0 ? "extruder" + s.active : "extruder"];
      q("ext").textContent = Math.round(e.temp) + "°"; q("ext-t").textContent = Math.round(e.target) + "°";
      q("bed").textContent = Math.round(h.heater_bed.temp) + "°"; q("bed-t").textContent = Math.round(h.heater_bed.target) + "°";
    }
    q("fan").textContent = Math.round((s.fan ?? 0) * 100) + "%";
    root.querySelectorAll(".qs-bar [data-go]").forEach((b) => b.setAttribute("aria-current", b.dataset.go === (["cal", "calview"].includes(page) ? "settings" : page) ? "page" : "false"));
  }
  // patch the page in place instead of replacing it, so a button keeps its element while it is being pressed
  const tpl = document.createElement("template");
  function morph(to, from) {
    const a = [...to.childNodes], b = [...from.childNodes];
    b.forEach((nb, i) => {
      const na = a[i];
      if (!na || na.nodeType !== nb.nodeType || na.nodeName !== nb.nodeName) { na ? to.replaceChild(nb, na) : to.append(nb); return; }
      if (nb.nodeType !== 1) { if (na.nodeValue !== nb.nodeValue) na.nodeValue = nb.nodeValue; return; }
      for (const { name } of [...na.attributes]) if (!nb.hasAttribute(name)) na.removeAttribute(name);
      for (const { name, value } of [...nb.attributes]) if (na.getAttribute(name) !== value) na.setAttribute(name, value);
      if (na.disabled !== nb.hasAttribute("disabled")) na.disabled = nb.hasAttribute("disabled");
      morph(na, nb);
    });
    for (let i = a.length - 1; i >= b.length; i--) a[i].remove();
  }
  function render() {
    const html = (PAGES[page] || PAGES.home)();
    if (html === rendered) return;
    rendered = html; tpl.innerHTML = html; morph(main, tpl.content);
  }
  let lastJob = null;
  function tick() {
    const j = st().job;
    if (j !== lastJob) { if ((j === "printing" && lastJob !== "paused") || j === "done") go("home"); lastJob = j; }
    calTick(); sidebar(); render();
  }
  setInterval(tick, 250); tick();
  return { go };
}
