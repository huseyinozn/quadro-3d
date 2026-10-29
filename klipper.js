// A browser model of the printer's Klipper host: it runs the printer's own config (gcode_macro, homing_override,
// delayed_gcode, rename_existing) through a Jinja engine and implements the commands those macros and a user
// may send: Klipper's core G-code and extended commands plus the printer's own klippy/extras modules
// (quadro_parallel_carriage, bed_pin_calibration, axis_slip_test, quadro_bed_mesh, quadro_input_shaper,
// pa_autotune, coprint_leds). Motion is planned here (trapezoids, Klipper's junction lookahead) and handed to the
// page as timed items to animate. Sensors are simulated: the bed surface follows the printer's saved bed mesh,
// the calibration pin sits where bed_pin_tool_positions.json says; force readings and accelerometers are not modelled.

import { compile, render, literalEval, PyDict, PyFloat, pyStr, pyRepr, UNDEF, isUndef, TemplateError } from "quadro/jinja";

export class CommandError extends Error {}
const err = (msg) => { throw new CommandError(msg); };
const f6 = (v) => Number(v).toFixed(6), f3 = (v) => Number(v).toFixed(3), f2 = (v) => Number(v).toFixed(2), f5 = (v) => Number(v).toFixed(5);
const coord = (a) => Object.assign([...a], { x: a[0], y: a[1], z: a[2], e: a[3] ?? 0 });

// ---------- trapezoid timing ----------
export function profile(start, target, speed, accel) {
  const d = Math.abs(target - start), peak = d ? Math.min(speed, Math.sqrt(d * accel)) : 0;
  const ta = peak ? peak / accel : 0, tc = peak ? Math.max(0, d / peak - ta) : 0;
  return { start, target, accel, peak, ta, tc, delay: 0, T: 2 * ta + tc };
}
export function posAt(p, t) {
  const u = t - p.delay, s = Math.sign(p.target - p.start);
  if (u <= 0 || !p.peak) return p.start;
  if (u >= p.T) return p.target;
  if (u < p.ta) return p.start + s * p.accel * u * u / 2;
  if (u < p.ta + p.tc) return p.start + s * (p.peak * p.ta / 2 + p.peak * (u - p.ta));
  const r = p.T - u;
  return p.target - s * p.accel * r * r / 2;
}
const lerpPose = (a, b, f) => ({ x: a.x.map((v, j) => v + (b.x[j] - v) * f), y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });
const clonePose = (p) => ({ x: p.x.slice(), y: p.y, z: p.z });

export function createPrinter(CFG, host) {
  const S = CFG.sections, sec = (n) => S[n] || {};
  const fnum = (s, d) => (s === undefined ? d : parseFloat(s));
  const P = sec("printer");
  const LIM = { v: fnum(P.max_velocity, 500), a: fnum(P.max_accel, 10000), scv: fnum(P.square_corner_velocity, 5), vz: fnum(P.max_z_velocity, 20), az: fnum(P.max_z_accel, 500), mcr: fnum(P.minimum_cruise_ratio, 0.5) };
  const CAR = ["carriage_t0", "carriage_t1", "carriage_t2", "carriage_t3"].map((n) => S["carriage " + n] || S["dual_carriage " + n]);
  const XR = CAR.map((c) => [fnum(c.position_min), fnum(c.position_max)]), XEND = CAR.map((c) => fnum(c.position_endstop)), XHS = CAR.map((c) => fnum(c.homing_speed, 60));
  const YC = sec("carriage carriage_y"), ZC = sec("carriage carriage_z");
  const YR = [fnum(YC.position_min), fnum(YC.position_max)], ZR = [fnum(ZC.position_min), fnum(ZC.position_max)];
  const CLEAR = fnum(sec("quadro_parallel_carriage").min_clearance, 56.25), PAR_SPEED = fnum(sec("quadro_parallel_carriage").default_speed, 50);
  const EXTRUDERS = ["extruder", "extruder1", "extruder2", "extruder3"];
  const LCP = sec("load_cell_probe"), BM = sec("bed_mesh");
  const PROBE = { speed: fnum(LCP.speed, 5), lift: fnum(LCP.lift_speed, 5), samples: parseInt(LCP.samples || "1"), retract: fnum(LCP.sample_retract_dist, 2), zoff: fnum(LCP.z_offset, 0), result: LCP.samples_result || "average" };
  const PIN = CFG.bedPin, PIN_R = 3;           // pin radius + nozzle tip: where a side touch registers (not in the config; a stand-in)

  // ---------- the bed surface: the printer's saved mesh, relative to its zero reference ----------
  const savedMesh = S["bed_mesh default"];
  const MESH = savedMesh ? {
    pts: savedMesh.points.trim().split("\n").map((r) => r.split(",").map(Number)),
    minx: fnum(savedMesh.min_x), maxx: fnum(savedMesh.max_x), miny: fnum(savedMesh.min_y), maxy: fnum(savedMesh.max_y),
  } : null;
  function meshAt(x, y) {
    if (!MESH) return 0;
    const ny = MESH.pts.length, nx = MESH.pts[0].length;
    const fx = Math.min(nx - 1, Math.max(0, (x - MESH.minx) / (MESH.maxx - MESH.minx) * (nx - 1)));
    const fy = Math.min(ny - 1, Math.max(0, (y - MESH.miny) / (MESH.maxy - MESH.miny) * (ny - 1)));
    const ix = Math.min(nx - 2, Math.floor(fx)), iy = Math.min(ny - 2, Math.floor(fy)), u = fx - ix, w = fy - iy, p = MESH.pts;
    return (p[iy][ix] * (1 - u) + p[iy][ix + 1] * u) * (1 - w) + (p[iy + 1][ix] * (1 - u) + p[iy + 1][ix + 1] * u) * w;
  }
  const zref = (BM.zero_reference_position || "150,150").split(",").map(Number);
  const bedZ = (x, y) => meshAt(x, y) - meshAt(zref[0], zref[1]);   // nozzle height where it touches the bed

  // files on the printer: the demo cube, plus whatever the page sliced (host.print.files)
  const sdFiles = () => (host.print.files ? host.print.files() : ["alignment_test_cube.gcode"]);

  // ---------- state ----------
  let st;
  function freshState(pose) {
    return {
      car: pose.x.slice(), y: pose.y, z: pose.z, e: 0, kin: [0, 0, 0], primary: pose.active ?? 0, modes: ["PRIMARY", "INACTIVE", "INACTIVE", "INACTIVE"],
      homed: new Set(pose.homed ?? ["x", "y", "z"]), vel: LIM.v, accel: LIM.a, scv: LIM.scv, mcr: LIM.mcr,
      base: [0, 0, 0, 0], homing: [0, 0, 0, 0], absolute: true, absoluteE: true, speed: 25, speedFactor: 1 / 60, extrudeFactor: 1, saved: {},
      extruder: EXTRUDERS[pose.active ?? 0], pa: Object.fromEntries(EXTRUDERS.map((e) => [e, { pa: 0, smooth: 0.04 }])),
      fans: Object.fromEntries([0, 1, 2, 3].map((j) => ["fan_generic fan_t" + j, 0])), pins: { driver_fan: 1, driver_fan2: 1 },
      leds: Object.fromEntries(["th1_led", "th2_led", "th3_led", "th4_led"].map((n) => [n, [0, 0, 0, 0]])),
      vars: {}, paused: false, pauseSent: false, displayMsg: null, progress: 0, idle: "Ready", shutdown: null,
      probe: { last_query: false, last_z_result: 0, last_probe_position: coord([0, 0, 0]) }, meshProfile: savedMesh ? "default" : "", meshActive: !!savedMesh,
      meshProfiles: savedMesh ? { default: savedMesh } : {}, excluded: [], currentObject: null, saveVars: {}, shaper: {},
      bedPin: { results: {}, offsets: JSON.parse(JSON.stringify(CFG.bedPinOffsets || {})), last_result: null, last_deltas: { delta_x: 0, delta_y: 0, delta_z: 0 }, inconsistent_tool: "", consistent: true },
      slip: { running: false, last_result: null, results: [] }, dcSaved: null, toolMap: null, printing: false,
    };
  }
  const heaters = {};
  for (const e of EXTRUDERS) { const c = sec(e); heaters[e] = { min: fnum(c.min_temp, 0), max: fnum(c.max_temp, 300), minExtrude: fnum(c.min_extrude_temp, 170), temp: 25, target: 0, tau: 9, rate: 7, power: 0 }; }
  { const c = sec("heater_bed"); heaters.heater_bed = { min: fnum(c.min_temp, 0), max: fnum(c.max_temp, 120), temp: 25, target: 0, tau: 45, rate: 1.2, power: 0 }; }
  const AMBIENT = 25;

  // ---------- macros ----------
  const commands = new Map();      // NAME -> { fn, desc }
  const macros = new Map();        // NAME -> { section, tpl, desc, rename }
  const register = (name, fn, desc) => commands.set(name, { fn, desc });
  function loadMacros() {
    macros.clear();
    for (const [name, opts] of Object.entries(S)) {
      if (!name.startsWith("gcode_macro ")) continue;
      const alias = name.slice(12).trim().toUpperCase();
      const vars = new PyDict();
      for (const [k, v] of Object.entries(opts)) if (k.startsWith("variable_")) vars.set(k.slice(9), literalEval(v));
      macros.set(alias, { section: name, tpl: compile(opts.gcode || "", name + ":gcode"), desc: opts.description || "G-Code macro", rename: opts.rename_existing ? opts.rename_existing.toUpperCase() : null, vars, initVars: vars });
    }
  }
  // rename_existing: the earlier command keeps working under the new name
  function installMacros() {
    for (const [alias, m] of macros) {
      if (m.rename) { const prev = commands.get(alias); if (prev) commands.set(m.rename, { fn: prev.fn, desc: "Renamed builtin of '" + alias + "'" }); }
      commands.set(alias, { fn: (g) => runMacro(m, g), desc: m.desc, macro: m });
    }
  }
  const inScript = new Set();
  function* runMacro(m, g) {
    if (inScript.has(m)) err("Macro " + m.section.slice(12).toUpperCase() + " called recursively");
    const ctx = Object.fromEntries([...m.vars.m]);
    Object.assign(ctx, templateContext());
    ctx.params = g.paramsDict(); ctx.rawparams = g.raw;
    inScript.add(m);
    try { yield* runScript(renderTpl(m.tpl, ctx, m.section + ":gcode")); } finally { inScript.delete(m); }
  }
  function renderTpl(tpl, ctx, name) {
    try { return render(tpl, ctx); }
    catch (e) {
      if (e instanceof CommandError) throw e;
      err("Error evaluating '" + name + "': " + (e instanceof TemplateError ? e.message : "jinja2.exceptions." + (e.name || "Error") + ": " + e.message));
    }
  }
  function templateContext() {
    const cache = {};
    const printer = {
      __getitem__: (k) => { const n = pyStr(k).trim(); if (!(n in cache)) { const s = statusOf(n); if (s === undefined) return UNDEF; cache[n] = s; } return cache[n]; },
      __getattr__: (k) => printer.__getitem__(k),
      __contains__: (k) => statusOf(pyStr(k).trim()) !== undefined,
      __iter__: () => objectNames().filter((n) => statusOf(n) !== undefined),
      __repr__: () => "<printer>",
    };
    return {
      printer,
      action_respond_info: (msg) => { info(pyStr(msg)); return ""; },
      action_raise_error: (msg) => err(pyStr(msg)),
      action_emergency_stop: (msg = "action_emergency_stop") => { shutdown("Shutdown due to " + pyStr(msg)); return ""; },
      action_call_remote_method: () => "",
    };
  }

  // ---------- output ----------
  // responses run in order with the motion they follow, so the console reads like the real one
  const out = (text, kind) => queueCall(() => host.respond(text, kind));
  const info = (msg) => out("// " + String(msg).trim().split("\n").map((l) => l.trim()).join("\n// "), "info");
  const raw = (msg) => out(msg, "raw");

  // ---------- command line parsing (gcode.py) ----------
  const ARGS_R = /([A-Z_]+|[A-Z*])/;
  const isTraditional = (cmd) => /^[A-Z]\d+(\.\d+)?$/.test(cmd.split(/\s+/)[0]);
  function parseLine(origline) {
    let line = origline.trim();
    const cpos = line.indexOf(";");
    if (cpos >= 0) line = line.slice(0, cpos);
    const parts = line.toUpperCase().split(ARGS_R);
    let cmd = parts[0] === "" && parts[1] === "N" ? parts.slice(3, 5).join("").trim() : parts.slice(0, 3).join("").trim();
    const params = {};
    for (let i = 1; i < parts.length; i += 2) params[parts[i]] = (parts[i + 1] || "").trim();
    return { cmd, params, origline: origline.trim() };
  }
  function rawParams(cmd, origline) {
    let start = cmd.length;
    if (origline.slice(0, start).toUpperCase() !== cmd) start += origline.toUpperCase().indexOf(cmd);
    if (/\s/.test(origline.charAt(start))) start++;
    return origline.slice(start);
  }
  function extendedParams(rawp, origline) {
    const params = {}, re = /\s*((?:"[^"]*"|'[^']*'|[^\s"'#;])+)/g;
    let m, s = rawp.replace(/[#;].*$/, "");
    while ((m = re.exec(s))) {
      const tok = m[1].replace(/"([^"]*)"|'([^']*)'/g, "$1$2"), eq = tok.indexOf("=");
      if (eq < 0) err("Malformed command '" + origline + "'");
      params[tok.slice(0, eq).toUpperCase()] = tok.slice(eq + 1);
    }
    return params;
  }
  class GCmd {
    constructor(cmd, origline, params) { this.cmd = cmd; this.origline = origline; this.params = params; this.raw = rawParams(cmd, origline); }
    paramsDict() { return new PyDict(Object.entries(this.params)); }
    get(name, def, kind, lim = {}) {
      let v = this.params[name];
      if (v === undefined) { if (def === undefined) err("Error on '" + this.origline + "': missing " + name); return def; }
      if (!kind) return v;
      const x = kind === "int" ? (/^\s*[-+]?\d+\s*$/.test(v) ? parseInt(v, 10) : NaN) : (/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v) ? parseFloat(v) : NaN);
      if (isNaN(x)) err("Unable to parse '" + v + "' as a " + kind);
      const where = "Error on '" + this.origline + "': " + name;
      if (lim.minval !== undefined && x < lim.minval) err(where + " must have minimum of " + lim.minval);
      if (lim.maxval !== undefined && x > lim.maxval) err(where + " must have maximum of " + lim.maxval);
      if (lim.above !== undefined && x <= lim.above) err(where + " must be above " + lim.above);
      if (lim.below !== undefined && x >= lim.below) err(where + " must be below " + lim.below);
      return x;
    }
    float(name, def, lim) { return this.get(name, def, "float", lim); }
    int(name, def, lim) { return this.get(name, def, "int", lim); }
  }
  const NOT_READY_OK = new Set(["FIRMWARE_RESTART", "RESTART", "STATUS", "HELP", "M105", "M115", "M112", "GET_POSITION", "M114", "ECHO"]);
  function* runScript(script) { for (const line of script.split("\n")) yield* runLine(line); }
  function* runLine(origline) {
    const { cmd, params, origline: o } = parseLine(origline);
    if (!cmd) return;
    if (st.shutdown && !NOT_READY_OK.has(cmd) && !cmd.startsWith("M105")) err(st.shutdown + "\nOnce the underlying issue is corrected, use the\n\"FIRMWARE_RESTART\" command to reset the firmware, reload the\nconfig, and restart the host software.\nPrinter is shutdown");
    let handler = commands.get(cmd);
    let name = cmd;
    if (!handler && cmd.includes(" ")) { const real = cmd.split(/\s+/)[0]; if (["M117", "M118", "M23"].includes(real)) { handler = commands.get(real); name = real; } }
    if (!handler) {
      if (["M140", "M104"].includes(cmd) && !parseFloat(params.S || "0")) return;
      if (cmd === "M107" || (cmd === "M106" && !parseFloat(params.S ?? "1"))) return;
      if (cmd === "M21") return;
      info('Unknown command:"' + cmd + '"');
      return;
    }
    const g = new GCmd(name, o, isTraditional(name) ? params : extendedParams(rawParams(name, o), o));
    const r = handler.fn(g);
    if (r && typeof r.next === "function") yield* r;
  }

  // ---------- object status (what templates see as printer[...]) ----------
  const kinPos = () => [st.car[st.primary] + st.kin[0], st.y + st.kin[1], st.z + st.kin[2], st.e];
  const gcodePos = () => { const p = kinPos().map((v, i) => v - st.base[i]); p[3] /= st.extrudeFactor; return p; };
  function objectNames() {
    return ["toolhead", "gcode_move", "heater_bed", "heaters", "print_stats", "pause_resume", "virtual_sdcard", "idle_timeout", "display_status", "bed_mesh", "probe", "configfile",
      "dual_carriage", "motion_report", "system_stats", "webhooks", "exclude_object", "save_variables", "bed_pin_calibration", "quadro_input_shaper", "axis_slip_test", "input_shaper",
      ...EXTRUDERS, ...Object.keys(st.fans), ...Object.keys(st.pins).map((p) => "output_pin " + p), ...Object.keys(st.leds).map((l) => "neopixel " + l), ...[...macros.values()].map((m) => m.section)];
  }
  let settingsCache = null;
  function settings() {
    if (settingsCache) return settingsCache;
    const typed = (v) => { const t = v.trim(); if (/^[-+]?\d+$/.test(t)) return parseInt(t, 10); if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return new PyFloat(parseFloat(t)); if (/^(true|false)$/i.test(t)) return /^true$/i.test(t); return v; };
    const s = {}, c = {};
    for (const [n, o] of Object.entries(S)) { s[n.toLowerCase()] = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typed(v)])); c[n] = Object.assign({}, o); }
    return (settingsCache = { settings: s, config: c });
  }
  function statusOf(n) {
    const m = [...macros.values()].find((x) => x.section === n);
    if (m) return m.vars;
    const kp = kinPos();
    const ex = (e) => { const h = heaters[e]; return { temperature: new PyFloat(Math.round(h.temp * 100) / 100), target: new PyFloat(h.target), power: new PyFloat(h.power), can_extrude: h.temp >= h.minExtrude, pressure_advance: new PyFloat(st.pa[e].pa), smooth_time: new PyFloat(st.pa[e].smooth), motion_queue: null }; };
    switch (n) {
      case "toolhead": {
        const lo = [XR[st.primary][0], YR[0], ZR[0]], hi = [XR[st.primary][1], YR[1], ZR[1]];
        return { position: coord(kp), homed_axes: ["x", "y", "z"].filter((a) => st.homed.has(a)).join(""), extruder: st.extruder, max_velocity: new PyFloat(st.vel), max_accel: new PyFloat(st.accel),
          square_corner_velocity: new PyFloat(st.scv), minimum_cruise_ratio: new PyFloat(st.mcr), axis_minimum: coord([...lo, 0]), axis_maximum: coord([...hi, 0]),
          print_time: new PyFloat(clock), stalls: 0, estimated_print_time: new PyFloat(clock) };
      }
      case "gcode_move": return { speed_factor: new PyFloat(st.speedFactor * 60), speed: new PyFloat(st.speed / st.speedFactor), extrude_factor: new PyFloat(st.extrudeFactor), absolute_coordinates: st.absolute, absolute_extrude: st.absoluteE,
        homing_origin: coord(st.homing), position: coord(kp), gcode_position: coord(gcodePos()), axis_map: { X: 0, Y: 1, Z: 2, E: 3 } };
      case "heater_bed": { const h = heaters.heater_bed; return { temperature: new PyFloat(Math.round(h.temp * 100) / 100), target: new PyFloat(h.target), power: new PyFloat(h.power) }; }
      case "heaters": return { available_heaters: [...EXTRUDERS, "heater_bed"], available_sensors: [...EXTRUDERS, "heater_bed"], available_monitors: [] };
      case "print_stats": return { filename: host.print.filename(), total_duration: new PyFloat(host.print.duration()), print_duration: new PyFloat(host.print.duration()), filament_used: new PyFloat(0),
        state: st.paused ? "paused" : host.print.state(), message: "", info: { total_layer: host.print.layers()[1], current_layer: host.print.layers()[0] } };
      case "pause_resume": return { is_paused: st.paused };
      case "virtual_sdcard": return { file_path: host.print.filename() ? "/home/cp/printer_data/gcodes/" + host.print.filename() : null, progress: new PyFloat(host.print.progress()), is_active: host.print.state() === "printing" && !st.paused, file_position: 0, file_size: 0 };
      case "idle_timeout": return { state: host.print.state() === "printing" ? "Printing" : st.idle, printing_time: new PyFloat(0) };
      case "display_status": return { progress: new PyFloat(st.progress || host.print.progress()), message: st.displayMsg };
      case "bed_mesh": return { profile_name: st.meshActive ? st.meshProfile : "", mesh_min: coord([5, 5]), mesh_max: coord([295, 295]), probed_matrix: MESH ? MESH.pts : [[]], mesh_matrix: MESH ? MESH.pts : [[]], profiles: Object.fromEntries(Object.keys(st.meshProfiles).map((k) => [k, { points: MESH ? MESH.pts : [], mesh_params: {} }])) };
      case "probe": return Object.assign({ name: "load_cell_probe" }, st.probe);
      case "configfile": return Object.assign({ save_config_pending: false, save_config_pending_items: {}, warnings: [] }, settings());
      case "dual_carriage": return { carriages: Object.fromEntries(st.modes.map((m, j) => ["carriage_t" + j, m])) };
      case "motion_report": { const p = host.pose(); return { live_position: coord([p.x[st.primary] + st.kin[0], p.y + st.kin[1], p.z + st.kin[2], st.e]), live_velocity: new PyFloat(host.velocity()), live_extruder_velocity: new PyFloat(0), steppers: [], trapq: [] }; }
      case "system_stats": return { sysload: new PyFloat(0.4), cputime: new PyFloat(clock), memavail: 1500000 };
      case "webhooks": return { state: st.shutdown ? "shutdown" : "ready", state_message: st.shutdown || "Printer is ready" };
      case "exclude_object": return { objects: [{ name: "ALIGNMENT_TEST_CUBE", center: [150, 150], polygon: [[140, 140], [160, 140], [160, 160], [140, 160]] }], excluded_objects: st.excluded.slice(), current_object: st.currentObject };
      case "save_variables": return { variables: PyDict.from(st.saveVars) };
      case "bed_pin_calibration": return { last_result: st.bedPin.last_result, results: st.bedPin.results, offsets: st.bedPin.offsets, last_deltas: st.bedPin.last_deltas, inconsistent_tool: st.bedPin.inconsistent_tool, consistent: st.bedPin.consistent };
      case "quadro_input_shaper": return Object.fromEntries(Object.entries(sec("quadro_input_shaper")).filter(([k]) => k.startsWith("shaper_")));
      case "axis_slip_test": return st.slip;
      case "input_shaper": return {};
    }
    if (EXTRUDERS.includes(n)) return ex(n);
    if (n in st.fans) return { speed: new PyFloat(st.fans[n]), rpm: null };
    if (n.startsWith("output_pin ") && n.slice(11) in st.pins) return { value: new PyFloat(st.pins[n.slice(11)]) };
    if (n.startsWith("neopixel ") && n.slice(9) in st.leds) return { color_data: [st.leds[n.slice(9)].map((v) => new PyFloat(v))] };
    if (n.startsWith("temperature_sensor ") && S[n]) return { temperature: new PyFloat(n.includes("Host") ? 46.2 : n.includes("main") ? 41.5 : 33.0), measured_min_temp: new PyFloat(25), measured_max_temp: new PyFloat(48) };
    return undefined;
  }

  // ---------- motion planning ----------
  let clock = 0;                                  // simulated seconds since start
  let pending = [];                               // linear moves waiting for lookahead
  function queueCall(fn) { flush(); host.enqueue({ kind: "call", T: 0, start: fn }); }
  function queueItem(item) { flush(); host.enqueue(item); }
  function pose() { return { x: st.car.slice(), y: st.y, z: st.z }; }
  // a straight move of the toolhead (primary carriage, Y, Z; COPY/MIRROR carriages follow), optional extrusion
  function addMove(to, speed, opts = {}) {
    const from = pose(), dx = to.x[st.primary] - from.x[st.primary], dy = to.y - from.y, dz = to.z - from.z, de = opts.de || 0;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-9 && !de) return;
    let v = Math.min(speed, st.vel), a = opts.accel ?? st.accel;
    if (L > 1e-9 && Math.abs(dz) > 1e-9) { v = Math.min(v, LIM.vz * L / Math.abs(dz)); a = Math.min(a, LIM.az * L / Math.abs(dz)); }
    const seg = { from, to: clonePose(to), L: L > 1e-9 ? L : Math.abs(de), v, a, kin: L > 1e-9, ux: L ? dx / L : 0, uy: L ? dy / L : 0, uz: L ? dz / L : 0, extrude: opts.extrude || null, label: opts.label || "Moving" };
    st.car = to.x.slice(); st.y = to.y; st.z = to.z;
    pending.push(seg);
  }
  // Klipper's lookahead: junction speeds from square_corner_velocity, backward then forward pass
  function flush() {
    if (!pending.length) return;
    const segs = pending; pending = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]; s.max2 = 0;
      const p = segs[i - 1];
      if (!p || !s.kin || !p.kin) continue;
      const c = -(p.ux * s.ux + p.uy * s.uy + p.uz * s.uz);
      if (c > 0.999999) continue;
      const cos = Math.max(c, -0.999999), sd2 = Math.sqrt(0.5 * (1 - cos)), R = sd2 / (1 - sd2), td2 = sd2 / Math.sqrt(0.5 * (1 + cos));
      const jd = (a) => st.scv ** 2 * (Math.SQRT2 - 1) / a;
      s.max2 = Math.min(R * jd(s.a) * s.a, R * jd(p.a) * p.a, 0.5 * s.L * td2 * s.a, 0.5 * p.L * td2 * p.a, s.v * s.v, p.v * p.v);
    }
    let end2 = 0;
    for (let i = segs.length - 1; i >= 0; i--) { const s = segs[i]; s.e2 = end2; end2 = s.s2 = Math.min(s.max2, end2 + 2 * s.a * s.L); }
    let t = 0, prev2 = 0;
    for (const s of segs) {
      s.s2 = Math.min(s.s2, prev2); s.e2 = Math.min(s.e2, s.s2 + 2 * s.a * s.L);
      const vs = Math.sqrt(s.s2), ve = Math.sqrt(s.e2), vc = Math.sqrt(Math.min(s.v * s.v, (s.s2 + s.e2) / 2 + s.a * s.L));
      const da = (vc * vc - s.s2) / (2 * s.a), dd = (vc * vc - s.e2) / (2 * s.a);
      Object.assign(s, { vs, ve, vc, ta: (vc - vs) / s.a, tc: Math.max(0, (s.L - da - dd) / vc), td: (vc - ve) / s.a, da, t0: t });
      s.T = s.ta + s.tc + s.td; t += s.T; prev2 = s.e2;
    }
    const dist = (s, u) => {
      if (u <= 0) return 0;
      if (u < s.ta) return s.vs * u + s.a * u * u / 2;
      if (u < s.ta + s.tc) return s.da + s.vc * (u - s.ta);
      const w = Math.min(u - s.ta - s.tc, s.td); return Math.min(s.L, s.da + s.vc * s.tc + s.vc * w - s.a * w * w / 2);
    };
    host.enqueue({
      kind: "path", T: t, label: segs[0].label, segs,
      at(time) {
        let lo = 0, hi = segs.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].t0 <= time) lo = m; else hi = m - 1; }
        const s = segs[lo], f = s.L ? Math.min(1, dist(s, time - s.t0) / s.L) : 1;
        return { pose: lerpPose(s.from, s.to, f), seg: s, f };
      },
    });
  }
  function dwell(T, label = "Busy") { if (T > 0) queueItem({ kind: "dwell", T, label }); }
  // Klipper's G-code thread blocks here: the script resumes when the animation reaches this point
  function* waitUntil(check, label) { queueItem({ kind: "until", until: check, label, done: resume }); yield "wait"; }
  function* waitMoves() { queueItem({ kind: "call", T: 0, start: resume }); yield "wait"; }

  // ---------- kinematics checks ----------
  function xRangeFor(j, xs = st.car) {
    return [Math.max(XR[j][0], j > 0 ? xs[j - 1] + CLEAR : -Infinity), Math.min(XR[j][1], j < 3 ? xs[j + 1] - CLEAR : Infinity)];
  }
  function moveError(msg, k) { err(msg + ": " + f3(k[0]) + " " + f3(k[1]) + " " + f3(k[2]) + " [" + f3(k[3] ?? 0) + "]"); }
  // a G1 target in kinematic coordinates -> physical pose, with Klipper's homed/range checks
  function kinTarget(k) {
    const cur = kinPos(), axes = ["x", "y", "z"];
    const lim = [xRangeFor(st.primary), YR, ZR];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(k[i] - cur[i]) < 1e-9) continue;
      if (!st.homed.has(axes[i])) moveError("Must home axis first", k);
      const v = k[i] - st.kin[i];
      if (i === 0) {
        const dx = v - st.car[st.primary];
        const next = st.car.map((x, j) => (j === st.primary ? v : st.modes[j] === "COPY" ? x + dx : st.modes[j] === "MIRROR" ? x - dx : x));
        if (next.some((x, j) => x < XR[j][0] - 1e-6 || x > XR[j][1] + 1e-6) || next.some((x, j) => j < 3 && next[j + 1] - x < CLEAR - 1e-6)) moveError("Move out of range", k);
      } else if (k[i] < lim[i][0] - 1e-6 || k[i] > lim[i][1] + 1e-6) moveError("Move out of range", k);
    }
    const dx = k[0] - st.kin[0] - st.car[st.primary];
    return { x: st.car.map((x, j) => (j === st.primary ? k[0] - st.kin[0] : st.modes[j] === "COPY" ? x + dx : st.modes[j] === "MIRROR" ? x - dx : x)), y: k[1] - st.kin[1], z: k[2] - st.kin[2] };
  }
  const activeTool = () => EXTRUDERS.indexOf(st.extruder);
  function moveTo(k, speed, opts = {}) {
    const de = k[3] - st.e;
    if (Math.abs(de) > 1e-9) {
      const h = heaters[st.extruder];
      if (h.temp < h.minExtrude) err("Extrude below minimum temp\nSee the 'min_extrude_temp' config option for details");
      const moving = Math.abs(k[0] - kinPos()[0]) > 1e-9 || Math.abs(k[1] - kinPos()[1]) > 1e-9;
      if (!moving && Math.abs(de) > 300) err("Extrude only move too long (" + f3(de) + "mm vs 300.000mm)\nSee the 'max_extrude_only_distance' config option for details");
    }
    const to = kinTarget(k);
    const from = pose();
    st.e = k[3];
    const ext = de > 0 && (Math.abs(to.x[st.primary] - from.x[st.primary]) > 1e-6 || Math.abs(to.y - from.y) > 1e-6) ? { tool: activeTool() } : null;
    addMove(to, speed, Object.assign({ de, extrude: ext }, opts));
  }

  // ---------- heaters ----------
  function setTemp(name, degrees) {
    const h = heaters[name];
    if (degrees && (degrees < h.min || degrees > h.max)) err("Requested temperature (" + degrees.toFixed(1) + ") out of range (" + h.min.toFixed(1) + ":" + h.max.toFixed(1) + ")");
    h.target = degrees;
  }
  const settled = (name) => { const h = heaters[name]; return !h.target || Math.abs(h.temp - h.target) <= 1; };
  function heaterName(g, key = "T") {
    if (g.params[key] === undefined) return st.extruder;
    const i = g.int(key, 0, { minval: 0 });
    if (i > 3) err("Extruder not configured"); return EXTRUDERS[i];
  }
  function tickHeaters(dt) {
    for (const h of Object.values(heaters)) {
      const goal = h.target || AMBIENT, d = goal - h.temp;
      const rate = h.target && d > 0 ? Math.min(h.rate, d / h.tau * 3) : d / (h.target ? h.tau : h.tau * 6);
      h.temp += Math.sign(d) * Math.min(Math.abs(d), Math.abs(rate) * dt);
      h.power = h.target ? Math.max(0, Math.min(1, 0.25 + d / 20)) : 0;
    }
  }

  // ---------- homing and probing ----------
  // a homing move runs to the endstop at homing speed; the axis is then at its endstop position
  function homeCarriage(j) {
    const to = pose(); to.x[j] = XEND[j];
    const save = st.primary; st.primary = j;
    addMove(to, XHS[j], { label: "Homing X", accel: st.accel });
    st.primary = save;
  }
  function homeAxes(axes) {
    if (axes.includes("x")) {
      for (const j of [0, 1, 3, 2]) homeCarriage(j);
      st.kin[0] = 0; st.homed.add("x"); setPrimary(0);
    }
    if (axes.includes("y")) { addMove(Object.assign(pose(), { y: fnum(YC.position_endstop, -1) }), fnum(YC.homing_speed, 60), { label: "Homing Y" }); st.kin[1] = 0; st.homed.add("y"); }
    if (axes.includes("z")) {
      const z0 = bedZ(st.car[st.primary], st.y);
      addMove(Object.assign(pose(), { z: z0 }), fnum(ZC.homing_speed, 5), { label: "Homing Z" });
      st.kin[2] = fnum(ZC.position_endstop, 0) - z0; st.homed.add("z");
    }
    st.base = st.base.map((b, i) => (i < 3 && axes.includes("xyz"[i]) ? st.homing[i] : b));
  }
  // probe down to the bed (the saved mesh shape), as load_cell_probe does
  function probeOnce(speed) {
    const x = st.car[st.primary], y = st.y, contact = bedZ(x, y);
    const kz = st.z + st.kin[2];
    if (st.z <= contact + 1e-6) err("Probe triggered prior to movement");
    if (contact + st.kin[2] < ZR[0] - 1e-6 && st.homed.has("z")) err("No trigger on probe after full movement");
    addMove(Object.assign(pose(), { z: contact }), speed, { label: "Probing" });
    const r = [x + st.kin[0], y + st.kin[1], contact + st.kin[2] - PROBE.zoff];
    info("probe: at " + f3(r[0]) + "," + f3(r[1]) + " bed will contact at z=" + f6(r[2]));
    void kz;
    return r;
  }
  function runProbe(g, label = "Probing") {
    const speed = g ? g.float("PROBE_SPEED", PROBE.speed, { above: 0 }) : PROBE.speed;
    const samples = g ? g.int("SAMPLES", PROBE.samples, { minval: 1 }) : PROBE.samples;
    const retract = g ? g.float("SAMPLE_RETRACT_DIST", PROBE.retract, { above: 0 }) : PROBE.retract;
    const lift = g ? g.float("LIFT_SPEED", PROBE.lift, { above: 0 }) : PROBE.lift;
    const zs = [];
    let r;
    for (let i = 0; i < samples; i++) {
      r = probeOnce(speed); zs.push(r[2]);
      addMove(Object.assign(pose(), { z: st.z + retract }), lift, { label });
    }
    zs.sort((a, b) => a - b);
    const z = PROBE.result === "median" ? zs[Math.floor(zs.length / 2)] : zs.reduce((a, b) => a + b, 0) / zs.length;
    st.probe = { last_query: false, last_z_result: new PyFloat(z), last_probe_position: coord([r[0], r[1], z]) };
    return [r[0], r[1], z];
  }

  // ---------- dual carriage ----------
  function setPrimary(j, now) { st.modes = st.modes.map((m, k) => (k === j ? "PRIMARY" : m === "PRIMARY" ? "INACTIVE" : m)); st.primary = j; if (now) host.activate(j); else queueCall(() => host.activate(j)); }

  // ---------- QUADRO_PARALLEL_MOVE (klippy/extras/quadro_parallel_carriage.py) ----------
  const TOOLS = ["T0", "T1", "T2", "T3"];
  function parallelMove(g) {
    if (!st.homed.has("x")) err("X axis must be homed before QUADRO_PARALLEL_MOVE");
    const speedReq = g.float("SPEED", PAR_SPEED, { above: 0 }), gap = g.float("MIN_CLEARANCE", CLEAR, { minval: 0 });
    let yT = null, zT = null;
    if (g.params.Y !== undefined) { yT = parseFloat(g.params.Y); if (isNaN(yT)) err("Invalid Y target '" + g.params.Y + "'"); if (!st.homed.has("y")) err("Y axis must be homed when Y is specified"); }
    if (g.params.Z !== undefined) { zT = parseFloat(g.params.Z); if (isNaN(zT)) err("Invalid Z target '" + g.params.Z + "'"); if (!st.homed.has("z")) err("Z axis must be homed when Z is specified"); }
    const cur = st.car.slice(), to = cur.slice(), requested = [];
    TOOLS.forEach((t, j) => { if (g.params[t] !== undefined) { const v = parseFloat(g.params[t]); if (isNaN(v)) err("Invalid " + t + " target '" + g.params[t] + "'"); to[j] = v; requested.push(t); } });
    if (!requested.length && yT === null && zT === null) err("Specify T0/T1/T2/T3 and/or Y/Z target");
    to.forEach((x, j) => { if (x < XR[j][0] - 1e-6) err("carriage_t" + j + " target " + f3(x) + " is below minimum " + f3(XR[j][0])); if (x > XR[j][1] + 1e-6) err("carriage_t" + j + " target " + f3(x) + " is above maximum " + f3(XR[j][1])); });
    for (const [label, set] of [["START", cur], ["TARGET", to]]) for (let j = 0; j < 3; j++) if (set[j + 1] - set[j] < gap - 1e-6)
      err(label + " clearance violation: carriage_t" + j + "=" + f3(set[j]) + ", carriage_t" + (j + 1) + "=" + f3(set[j + 1]) + ", clearance=" + f3(set[j + 1] - set[j]) + " mm, required=" + f3(gap) + " mm");
    const y1 = yT === null ? st.y : yT - st.kin[1], z1 = zT === null ? st.z : zT - st.kin[2];
    const arriving = g.params.ARRIVING;
    const speed = Math.min(speedReq, st.vel), a = st.accel;
    if (arriving === undefined) {
      if (g.int("PLAN_ONLY", 0)) err("PLAN_ONLY requires ARRIVING");
      // one manual_move: the carriage with the longest travel leads, the others follow scaled
      const save = st.primary, dl = to.map((x, j) => Math.abs(x - cur[j]));
      st.primary = dl.indexOf(Math.max(...dl));
      addMove({ x: to, y: y1, z: z1 }, speed, { label: "Parallel move" });
      st.primary = save;
    } else {
      const arr = String(arriving).toUpperCase();
      if (!TOOLS.includes(arr)) err("ARRIVING must be T0, T1, T2 or T3");
      if (!requested.includes(arr)) err("ARRIVING must have an explicit target");
      const ps = cur.map((x, j) => profile(x, to[j], speed, a));
      const py = profile(st.y, y1, speed, a), pz = profile(st.z, z1, Math.min(speed, LIM.vz), Math.min(a, LIM.az));
      const T = Math.max(py.T, pz.T, ...ps.map((p) => p.T)), ai = TOOLS.indexOf(arr);
      if (ps[ai].T) ps[ai].delay = T - ps[ai].T;
      info("QUADRO delayed plan: ARRIVING=" + arr + " delay=" + f6(ps[ai].delay) + "s finish=" + f6(T) + "s speed=" + f3(speed) + " accel=" + f3(a));
      if (g.int("PLAN_ONLY", 0, { minval: 0, maxval: 1 })) {
        [...TOOLS.map((t, j) => [t, ps[j]]), ["Y", py], ["Z", pz]].forEach(([n, p]) => info(n + ": start=" + f6(p.start) + " target=" + f6(p.target) + " delay=" + f6(p.delay) + " duration=" + f6(p.T) + " peak_speed=" + f3(p.peak)));
        return;
      }
      queueItem({ kind: "plan", T, label: "Parallel move", plan: { ps, py, pz }, at: (t) => ({ pose: { x: ps.map((p) => posAt(p, t)), y: posAt(py, t), z: posAt(pz, t) } }) });
      st.car = to.slice(); st.y = y1; st.z = z1;
      host.lastPlan && queueCall(() => host.lastPlan({ ps, py, pz, T, arriving: ai, kin: st.kin.slice() }));
    }
    st.car = to.slice(); st.y = y1; st.z = z1;
    const fin = st.car;
    info("QUADRO_PARALLEL_MOVE complete\nT0=" + f3(fin[0]) + " T1=" + f3(fin[1]) + " T2=" + f3(fin[2]) + " T3=" + f3(fin[3]) + " Y=" + f3(st.y + st.kin[1]) + " Z=" + f3(st.z + st.kin[2]));
  }

  // ---------- bed_pin_calibration.py ----------
  const OFFSETS_PATH = "/home/cp/printer_data/config/bed_pin_offsets.json";
  const pinPos = (t) => PIN[t];
  function* clearOffsets() { yield* runLine("SET_GCODE_OFFSET X=0.00000 Y=0.00000 Z=0.00000 MOVE=0"); }
  function manualMove(k, speed, label) { const to = kinTarget(k.map((v, i) => (v === null ? kinPos()[i] : v))); addMove(to, speed, { label }); }
  const moveZ = (z, speed, label) => manualMove([null, null, z], speed, label);
  const moveXY = (x, y, speed, label) => manualMove([x, y, null], speed, label);
  function* prepareTool(tool, x, y, z, full, label) {
    if (!["x", "y", "z"].every((a) => st.homed.has(a))) yield* homeAndReset();
    yield* clearOffsets(); moveZ(5, 5, label);
    if (full) {
      const j = TOOLS.indexOf(tool);
      const moves = [...[0, 1, 2].filter((k) => k < j).map((k) => [k, [-169, -112.75, -56.5][k]]), ...[3, 2, 1].filter((k) => k > j).map((k) => [k, [356.5, 412.75, 469][k - 1]]), [j, x]];
      for (const [k, xp] of moves) { setPrimary(k); manualMove([xp, null, null], 50, label); }
      setPrimary(j);
    }
    moveXY(x, y, 50, label); moveZ(z, 2, label);
    dwell(0.2, label);
  }
  function* homeAndReset() { yield* clearOffsets(); yield* runLine("G28"); yield* runLine("G90"); yield* runLine("SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY"); yield* runLine("ACTIVATE_EXTRUDER EXTRUDER=extruder"); yield* clearOffsets(); }
  // coarse 0.2 mm steps until the load cell trips, back off, then 0.01 mm steps: a quick approach, a retract and a slow one
  function touchAxis(axis, dir, contact, retract, label, speeds = [3, 0.4]) {
    const i = "xyz".indexOf(axis), k = kinPos(), go = (v, sp) => { const t = [null, null, null]; t[i] = v; manualMove(t, sp, label); };
    go(contact, speeds[0]); go(contact - dir * retract, axis === "z" ? 5 : 20); dwell(0.25, label); go(contact, speeds[1]);
    void k;
  }
  function* pinCycle(g, tool, cycle, total, full, label) {
    const p = pinPos(tool), retract = g ? g.float("RETRACT", 1.0) : 1.0;
    const sideZ = p.last_measured_top_z - p.side_z_margin;
    yield* prepareTool(tool, p.top_x, p.top_y, 5.0, full, label);
    touchAxis("z", -1, p.last_measured_top_z, retract, label, [2, 0.3]); moveZ(5, 5, label);
    const sides = [["x", 1, p.left_x, p.top_y, p.top_x - PIN_R], ["x", -1, p.right_x, p.top_y, p.top_x + PIN_R], ["y", 1, p.top_x, p.front_y, p.top_y - PIN_R], ["y", -1, p.top_x, p.back_y, p.top_y + PIN_R]];
    for (const [ax, dir, x, y, c] of sides) { moveZ(5, 5, label); moveXY(x, y, 50, label); moveZ(sideZ, 2, label); dwell(0.2, label); touchAxis(ax, dir, c, retract, label); }
    moveZ(5, 5, label);
    const r = { tool, z: { z: p.last_measured_top_z }, x_left: { x: p.top_x - PIN_R }, x_right: { x: p.top_x + PIN_R }, center_x: p.top_x, y_front: { y: p.top_y - PIN_R }, y_back: { y: p.top_y + PIN_R }, center_y: p.top_y, side_z_margin: p.side_z_margin };
    info("BED_PIN_CALIBRATE_TOOL " + tool + " cycle " + (cycle + 1) + "/" + total + ": Z=" + f5(r.z.z) + " X_LEFT=" + f5(r.x_left.x) + " X_RIGHT=" + f5(r.x_right.x) + " Y_BACK=" + f5(r.y_back.y) + " Y_FRONT=" + f5(r.y_front.y) + " CENTER_X=" + f5(r.center_x) + " CENTER_Y=" + f5(r.center_y));
    st.bedPin.last_result = r;
    return r;
  }
  function* pinCalibrateTool(g) {
    const tool = g.get("TOOL", "T0").toUpperCase();
    if (!PIN[tool]) err("Unknown TOOL=" + tool);
    if (g.int("RESET", 1, { minval: 0, maxval: 1 })) yield* homeAndReset();
    const cyclesOverride = g.int("CYCLES", 0, { minval: 0, maxval: 3 }), label = "Bed pin " + tool;
    if (cyclesOverride === 1) { st.bedPin.results[tool] = yield* pinCycle(g, tool, 0, 1, true, label); return; }
    const n = g.int("RETRY", 0) ? 2 : g.int("FIRST", 0) ? 3 : 2, from = g.int("FIRST", 0) && !g.int("RETRY", 0) ? 1 : 0, ms = [];
    for (let i = 0; i < n; i++) ms.push(yield* pinCycle(g, tool, i, n, i === 0, label));
    const A = ms[from], B = ms[ms.length - 1], d = { delta_x: Math.abs(A.center_x - B.center_x), delta_y: Math.abs(A.center_y - B.center_y), delta_z: Math.abs(A.z.z - B.z.z) };
    st.bedPin.last_deltas = d; st.bedPin.consistent = true;
    info("BED_PIN_CALIBRATE_TOOL " + tool + " COMPARE: A CENTER_X=" + f5(A.center_x) + " CENTER_Y=" + f5(A.center_y) + " Z=" + f5(A.z.z) + " B CENTER_X=" + f5(B.center_x) + " CENTER_Y=" + f5(B.center_y) + " Z=" + f5(B.z.z) +
      " DELTA_X=" + f5(d.delta_x) + " DELTA_Y=" + f5(d.delta_y) + " DELTA_Z=" + f5(d.delta_z) + " PASS");
    st.bedPin.results[tool] = B;
    yield* runLine("SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=stage VALUE='\"CALIBRATION_LEVELING_" + tool + "_DONE\"'");
  }
  function* pinCalibrateAll(g) {
    st.bedPin.results = {};
    yield* homeAndReset();
    for (const t of TOOLS) yield* runLine("BED_PIN_CALIBRATE_TOOL TOOL=" + t + " RESET=0 CYCLES=1" + (g.params.RETRACT ? " RETRACT=" + g.params.RETRACT : ""));
    const R = st.bedPin.results, t0 = R.T0;
    for (const t of TOOLS) Object.assign(R[t], { x_offset_vs_t0: R[t].center_x - t0.center_x, y_offset_vs_t0: R[t].center_y - t0.center_y, z_offset_vs_t0: R[t].z.z - t0.z.z });
    info("BED_PIN_CALIBRATE_ALL OFFSETS vs T0: T0 X=0.00000 Y=0.00000 Z=0.00000 " + ["T1", "T2", "T3"].map((t) => t + " X=" + f5(R[t].x_offset_vs_t0) + " Y=" + f5(R[t].y_offset_vs_t0) + " Z=" + f5(R[t].z_offset_vs_t0)).join(" "));
  }

  // ---------- axis_slip_test.py ----------
  function burstScript(axis, accel, velocity, lo, hi, repeat) {
    const mid = (lo + hi) / 2, fast = Math.round(velocity * 60), lead = 20, short = 20, hopD = 40, L = [];
    const g = (v, f) => L.push("G1 " + axis + f3(v) + " F" + f), limit = (a, v) => L.push("SET_VELOCITY_LIMIT" + (v !== undefined ? " VELOCITY=" + f3(v) : "") + (a !== undefined ? " ACCEL=" + f3(a) : ""));
    L.push("SAVE_GCODE_STATE NAME=_AXIS_SLIP_BURST", "G90", "M220 S100"); limit(2000, 100); L.push("G1 Z10.000 F600");
    if (axis === "X") L.push("G1 Y150.000 F6000");
    g(mid, 3000); L.push("M400");
    for (let r = 0; r < repeat; r++) {
      limit(accel, velocity);
      for (const t of [hi, lo, hi, lo, mid]) { L.push("G4 P500"); g(t, fast); L.push("M400"); }
      g(mid - lead, 1800); g(lo, fast);
      for (let i = 0; i < 2; i++) { g(lo + lead, 1800); g(hi, fast); g(hi - lead, 1800); g(lo, fast); }
      g(lo + lead, 1800); g(hi, fast); L.push("M400");
      for (let i = 0; i < 2; i++) { limit(1000); g(hi - lead, 3000); L.push("M400"); limit(accel); g(lo, fast); L.push("M400"); limit(1000); g(lo + lead, 3000); L.push("M400"); limit(accel); g(hi, fast); L.push("M400"); }
      for (let i = 0; i < 10; i++) { g(mid - short, fast); g(mid + short, fast); }
      L.push("M400"); g(mid, 1800);
      for (const t of [lo, lo + hopD, lo, hi, hi - hopD, hi, lo, lo + hopD, lo, hi]) g(t, fast);
      g(hi - lead, 1800); g(lo, fast); L.push("M400");
    }
    limit(2000, 100); g(mid, 3000); L.push("M400", "RESTORE_GCODE_STATE NAME=_AXIS_SLIP_BURST MOVE=0");
    return L.join("\n");
  }
  function* slipTest(g, accels, name) {
    if (st.slip.running) err("Axis slip test is already running");
    const axis = g.get("AXIS", "Y").toUpperCase();
    if (axis !== "X" && axis !== "Y") err("AXIS must be X or Y");
    let tool = g.get("TOOL", "T0").toUpperCase(); if (/^\d$/.test(tool)) tool = "T" + tool;
    if (!TOOLS.includes(tool)) err("Unknown TOOL=" + tool);
    const velocity = g.float("VELOCITY", 300, { above: 0 }), repeat = g.int("REPEAT", 1, { minval: 1, maxval: 100 }), tol = g.float("TOLERANCE", 0.15, { above: 0 });
    const probeOnly = g.int("PROBE_ONLY", 0, { minval: 0, maxval: 1 }), lo = g.float("MIN", 50), hi = g.float("MAX", 250);
    if (hi - lo < 100) err("MAX - MIN must be at least 100 mm");
    if (!["x", "y", "z"].every((a) => st.homed.has(a))) err("Home all axes with G28 before this test");
    if (["printing", "paused"].includes(statusOf("print_stats").state)) err("Run this test only while the printer is idle");
    const [ov, oa] = [st.vel, st.accel], tag = name + " " + axis + " " + tool, label = "Axis slip test", p = pinPos(tool), sideZ = p.last_measured_top_z - p.side_z_margin;
    yield* runLine("SAVE_GCODE_STATE NAME=_AXIS_SLIP_OUTER");
    st.slip.running = true; st.slip.results = []; st.slip.last_result = null;
    info(tag + " version=2026-10-09-compatible-1 PROBE_ONLY=" + probeOnly);
    try {
      yield* runLine("SET_VELOCITY_LIMIT VELOCITY=100.000 ACCEL=2000.000");
      yield* prepareTool(tool, p.top_x, p.top_y, 5.0, true, label);
      yield* runLine("ACTIVATE_EXTRUDER EXTRUDER=" + (tool === "T0" ? "extruder" : "extruder" + tool[1]));
      touchAxis("z", -1, p.last_measured_top_z, 1, label, [2, 0.3]); moveZ(5, 5, label);
      const contact = axis === "X" ? p.top_x - PIN_R : p.top_y - PIN_R;
      const touchPin = () => {
        moveZ(5, 5, label); axis === "X" ? moveXY(p.left_x, p.top_y, 50, label) : moveXY(p.top_x, p.front_y, 50, label);
        moveZ(sideZ, 3, label); dwell(0.2, label); touchAxis(axis.toLowerCase(), 1, contact, 1, label);
        axis === "X" ? moveXY(contact - 1, p.top_y, 20, label) : moveXY(p.top_x, contact - 1, 20, label); moveZ(5, 5, label);
      };
      touchPin();
      info(tag + " REFERENCE=" + f5(contact) + " SIDE_Z=" + f5(sideZ));
      for (const accel of probeOnly ? Array(repeat).fill(null) : accels) {
        if (!probeOnly) yield* runScript(burstScript(axis, accel, velocity, lo, hi, repeat));
        touchPin();
        const result = { axis, tool, accel, velocity: probeOnly ? null : velocity, before: contact, previous: contact, after: contact, diff: 0, step_diff: 0, slipped: false, probe_only: !!probeOnly, status: "OK" };
        st.slip.results.push(result); st.slip.last_result = result;
        info(tag + " ACCEL=" + (accel === null ? "None" : accel.toFixed(1)) + " VEL=" + (probeOnly ? "None" : velocity.toFixed(1)) + " BEFORE=" + f5(contact) + " AFTER=" + f5(contact) + " DIFF=+0.00000 STEP_DIFF=+0.00000 mm TOL=" + tol.toFixed(3) + " -> OK");
      }
    } finally {
      st.slip.running = false;
      yield* runLine("SET_VELOCITY_LIMIT VELOCITY=" + ov.toFixed(6) + " ACCEL=" + oa.toFixed(6));
      yield* runLine("RESTORE_GCODE_STATE NAME=_AXIS_SLIP_OUTER MOVE=0");
      yield* runLine("BED_PIN_APPLY_OFFSET TOOL=" + tool);
      info("Selected tool remains " + tool + "; its stored bed-pin offsets were requested.");
    }
  }

  // ---------- bed meshes ----------
  function meshPoints() {
    const [x0, y0] = (BM.mesh_min || "5,5").split(",").map(Number), [x1, y1] = (BM.mesh_max || "295,295").split(",").map(Number), [nx, ny] = (BM.probe_count || "9,9").split(",").map(Number), pts = [];
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) pts.push([x0 + (r % 2 ? nx - 1 - c : c) * (x1 - x0) / (nx - 1), y0 + r * (y1 - y0) / (ny - 1)]);
    return pts;
  }
  function bedMeshCalibrate(g) {
    const hz = g.float("HORIZONTAL_MOVE_Z", fnum(BM.horizontal_move_z, 5)), speed = fnum(BM.speed, 50), profileName = g.get("PROFILE", "default");
    queueCall(() => host.clearMeshDots());
    meshPoints().forEach(([x, y], i) => {
      manualMove([null, null, hz], i ? PROBE.lift : speed, "Bed mesh"); manualMove([x, y, null], speed, "Bed mesh");
      const r = runProbe(null, "Bed mesh");
      queueCall(() => host.meshDot(x, y));
      void r;
    });
    manualMove([null, null, hz], PROBE.lift, "Bed mesh");
    st.meshProfiles[profileName] = savedMesh; st.meshProfile = profileName; st.meshActive = true;
    info("Mesh Bed Leveling Complete\nBed Mesh state has been saved to profile [" + profileName + "]\nfor the current session.  The SAVE_CONFIG command will\nupdate the printer config file and restart the printer.");
  }
  function quadroCustomMesh(g) {
    const profileName = g.get("PROFILE", "default"), repeats = g.int("REPEATS", 2, { minval: 1 }), hz = g.float("HORIZONTAL_MOVE_Z", fnum(BM.horizontal_move_z, 5)), speed = fnum(BM.speed, 50), pts = meshPoints();
    if (!profileName.trim()) err("Value for parameter 'PROFILE' must be specified");
    st.meshActive = false;
    queueCall(() => host.clearMeshDots());
    for (let pass = 0; pass < repeats; pass++) {
      info("===== QUADRO MESH PASS " + (pass + 1) + "/" + repeats + " =====");
      pts.forEach(([x, y], i) => {
        manualMove([null, null, hz], i === 0 ? speed : PROBE.lift, "Bed mesh"); manualMove([x, y, null], speed, "Bed mesh");
        dwell(0.5, "Bed mesh");
        info("Quadro mesh pass " + (pass + 1) + "/" + repeats + " point " + (i + 1) + "/" + pts.length + ": X=" + f2(x) + " Y=" + f2(y));
        probeOnce(PROBE.speed);
        queueCall(() => host.meshDot(x, y));
      });
      manualMove([null, null, hz], PROBE.lift, "Bed mesh");
      info("===== QUADRO MESH PASS " + (pass + 1) + "/" + repeats + " COMPLETE =====");
    }
    st.meshProfiles[profileName] = savedMesh; st.meshProfile = profileName; st.meshActive = true;
    info("Mesh Bed Leveling Complete\nBed Mesh state has been saved to profile [" + profileName + "]\nfor the current session.  The SAVE_CONFIG command will\nupdate the printer config file and restart the printer.");
  }

  // ---------- resonance testing (resonance_tester, quadro_input_shaper) ----------
  function resonanceSweep(axis, label) {
    const pt = (sec("resonance_tester").probe_points || "150,150,20").trim().split(/[\s,]+/).map(Number);
    manualMove([pt[0], pt[1], pt[2]], 50, label);
    for (let f = 5; f <= 133; f += 16) { const ff = f; queueCall(() => host.respond("// Testing frequency " + ff + " Hz", "info")); dwell(16, label + " " + axis.toUpperCase()); }
  }

  // ---------- G-code commands ----------
  const AX = ["X", "Y", "Z", "E"];
  function cmdG1(g) {
    const k = kinPos(), p = g.params;
    for (let i = 0; i < 4; i++) {
      if (p[AX[i]] === undefined) continue;
      let v = parseFloat(p[AX[i]]);
      if (isNaN(v)) err("Unable to parse move '" + g.origline + "'");
      let abs = st.absolute;
      if (i === 3) { v *= st.extrudeFactor; if (!st.absoluteE) abs = false; }
      k[i] = abs ? v + st.base[i] : k[i] + v;
    }
    if (p.F !== undefined) { const f = parseFloat(p.F); if (!(f > 0)) err("Invalid speed in '" + g.origline + "'"); st.speed = f * st.speedFactor; }
    moveTo(k, st.speed);
  }
  // G2/G3 (gcode_arcs): the arc in segments of `resolution` mm
  function cmdArc(g, clockwise) {
    const p = g.params;
    if (p.R !== undefined) err("G2/G3 does not support R moves");
    const k0 = kinPos(), cur = k0.map((v, i) => v - st.base[i]);
    const tgt = cur.slice();
    for (let i = 0; i < 4; i++) if (p[AX[i]] !== undefined) tgt[i] = st.absolute ? parseFloat(p[AX[i]]) : cur[i] + parseFloat(p[AX[i]]);
    const I = parseFloat(p.I || 0), J = parseFloat(p.J || 0);
    if (!I && !J) err("G2/G3 requires IJ, IK or JK parameters");
    if (p.F !== undefined) st.speed = parseFloat(p.F) * st.speedFactor;
    const cx = cur[0] + I, cy = cur[1] + J, r = Math.hypot(I, J);
    let a0 = Math.atan2(cur[1] - cy, cur[0] - cx), a1 = Math.atan2(tgt[1] - cy, tgt[0] - cx), da = a1 - a0;
    if (clockwise && da >= 0) da -= 2 * Math.PI; if (!clockwise && da <= 0) da += 2 * Math.PI;
    const res = fnum(sec("gcode_arcs").resolution, 1), n = Math.max(1, Math.floor(Math.abs(da) * r / res));
    for (let i = 1; i <= n; i++) {
      const f = i / n, a = a0 + da * f;
      const kp = [cx + r * Math.cos(a), cy + r * Math.sin(a), cur[2] + (tgt[2] - cur[2]) * f, cur[3] + (tgt[3] - cur[3]) * f].map((v, j) => v + st.base[j]);
      if (i === n) { kp[0] = tgt[0] + st.base[0]; kp[1] = tgt[1] + st.base[1]; }
      moveTo(kp, st.speed);
    }
  }
  function saveState(name) { st.saved[name] = { absolute: st.absolute, absoluteE: st.absoluteE, base: st.base.slice(), last: kinPos(), homing: st.homing.slice(), speed: st.speed, speedFactor: st.speedFactor, extrudeFactor: st.extrudeFactor }; }
  function restoreState(g) {
    const name = g.get("NAME", "default"), s = st.saved[name];
    if (!s) err("Unknown g-code state: " + name);
    Object.assign(st, { absolute: s.absolute, absoluteE: s.absoluteE, homing: s.homing.slice(), speed: s.speed, speedFactor: s.speedFactor, extrudeFactor: s.extrudeFactor });
    st.base = s.base.slice(); st.base[3] += st.e - s.last[3];
    if (g.int("MOVE", 0)) { const speed = g.float("MOVE_SPEED", st.speed, { above: 0 }); moveTo([...s.last.slice(0, 3), st.e], speed); }
  }
  function shutdown(msg) {
    st.shutdown = msg; pending = []; busy = null; inputs.length = 0;
    for (const h of Object.values(heaters)) h.target = 0;
    host.halt();
    host.respond("!! " + msg, "error");
  }

  function registerAll() {
    commands.clear();
    // gcode.py
    register("HELP", () => {
      const lines = ["Available extended commands:"];
      for (const n of [...commands.keys()].sort()) { const c = commands.get(n); if (c.desc && !isTraditionalCmd(n)) lines.push(n.padEnd(10) + ": " + c.desc); }
      info(lines.join("\n"));
    }, "Report the list of available extended G-Code commands");
    register("STATUS", () => { if (st.shutdown) err(st.shutdown + "\nKlipper state: Not ready"); info("Klipper state: Ready"); }, "Report the printer status");
    register("RESTART", () => restartHost("Klipper state: Ready"), "Reload config file and restart host software");
    register("FIRMWARE_RESTART", () => restartHost("Klipper state: Ready"), "Restart firmware, host, and reload config");
    register("ECHO", (g) => info(g.origline), null);
    register("M112", () => shutdown("Shutdown due to M112 command"), null);
    register("M115", () => raw("FIRMWARE_NAME:Klipper FIRMWARE_VERSION:quadro-0.2.1 (browser simulation)"), null);
    register("M400", function* () { yield* waitMoves(); }, null);
    register("G4", (g) => dwell(g.float("P", 0, { minval: 0 }) / 1000, "Dwell"), null);
    register("M105", () => raw("ok " + EXTRUDERS.map((e, i) => (i === 0 ? "T:" + heaters[e].temp.toFixed(1) + " /" + heaters[e].target.toFixed(1) + " " : "") + "T" + i + ":" + heaters[e].temp.toFixed(1) + " /" + heaters[e].target.toFixed(1)).join(" ") + " B:" + heaters.heater_bed.temp.toFixed(1) + " /" + heaters.heater_bed.target.toFixed(1)), null);
    // gcode_move.py
    register("G1", cmdG1, null); register("G0", cmdG1, null);
    register("G2", (g) => cmdArc(g, true), null); register("G3", (g) => cmdArc(g, false), null);
    register("G17", () => {}, null); register("G18", () => err("G18 is not supported by this simulation"), null); register("G19", () => err("G19 is not supported by this simulation"), null);
    register("G20", () => err("Machine does not support G20 (inches) command"), null); register("G21", () => {}, null);
    register("M82", () => (st.absoluteE = true), null); register("M83", () => (st.absoluteE = false), null);
    register("G90", () => (st.absolute = true), null); register("G91", () => (st.absolute = false), null);
    register("G92", (g) => {
      const offs = AX.map((a) => (g.params[a] === undefined ? null : parseFloat(g.params[a]))), k = kinPos();
      offs.forEach((o, i) => { if (o !== null) st.base[i] = k[i] - (i === 3 ? o * st.extrudeFactor : o); });
      if (offs.every((o) => o === null)) st.base = k.slice();
    }, null);
    register("M114", () => { const p = gcodePos(); raw("X:" + f3(p[0]) + " Y:" + f3(p[1]) + " Z:" + f3(p[2]) + " E:" + f3(p[3])); }, null);
    register("M220", (g) => { const v = g.float("S", 100, { above: 0 }) / (60 * 100); st.speed = (st.speed / st.speedFactor) * v; st.speedFactor = v; }, null);
    register("M221", (g) => { const nf = g.float("S", 100, { above: 0 }) / 100, ev = (st.e - st.base[3]) / st.extrudeFactor; st.base[3] = st.e - ev * nf; st.extrudeFactor = nf; }, null);
    register("SET_GCODE_OFFSET", (g) => {
      const delta = [0, 0, 0, 0];
      AX.forEach((a, i) => {
        let o = g.params[a] !== undefined ? g.float(a) : null;
        if (o === null) { const adj = g.params[a + "_ADJUST"] !== undefined ? g.float(a + "_ADJUST") : null; if (adj === null) return; o = adj + st.homing[i]; }
        delta[i] = o - st.homing[i]; st.base[i] += delta[i]; st.homing[i] = o;
      });
      if (g.int("MOVE", 0)) { const speed = g.float("MOVE_SPEED", st.speed, { above: 0 }), k = kinPos().map((v, i) => v + delta[i]); moveTo(k, speed); }
    }, "Set a virtual offset to g-code positions");
    register("SAVE_GCODE_STATE", (g) => saveState(g.get("NAME", "default")), "Save G-Code coordinate state");
    register("RESTORE_GCODE_STATE", restoreState, "Restore a previously saved G-Code state");
    register("GET_POSITION", () => {
      const steps = (v, spm) => Math.round(v * spm);
      const sp = [["stepper_t0", st.car[0], 80], ["stepper_t1", st.car[1], 80], ["stepper_t2", st.car[2], 80], ["stepper_t3", st.car[3], 80], ["stepper_y2", st.y, 80], ["stepper_y1", st.y, 80], ["stepper_z", st.z, 800]];
      const k = kinPos();
      info("mcu: " + sp.map(([n, v, s]) => n + ":" + steps(v, s)).join(" ") + "\nstepper: " + sp.map(([n, v]) => n + ":" + f6(v)).join(" ") + "\nkinematic: X:" + f6(st.car[st.primary]) + " Y:" + f6(st.y) + " Z:" + f6(st.z) +
        "\ntoolhead: " + k.map((v, i) => AX[i] + ":" + f6(v)).join(" ") + "\ngcode: " + k.map((v, i) => AX[i] + ":" + f6(v)).join(" ") + "\ngcode base: " + st.base.map((v, i) => AX[i] + ":" + f6(v)).join(" ") + "\ngcode homing: " + st.homing.slice(0, 3).map((v, i) => AX[i] + ":" + f6(v)).join(" "));
    }, "Return information on the current location of the toolhead");
    // toolhead.py
    register("SET_VELOCITY_LIMIT", (g) => {
      const v = g.float("VELOCITY", null, { above: 0 }), a = g.float("ACCEL", null, { above: 0 }), scv = g.float("SQUARE_CORNER_VELOCITY", null, { minval: 0 }), mcr = g.float("MINIMUM_CRUISE_RATIO", null, { minval: 0, below: 1 });
      if (v !== null) st.vel = v; if (a !== null) st.accel = a; if (scv !== null) st.scv = scv; if (mcr !== null) st.mcr = mcr;
      if (v === null && a === null && scv === null && mcr === null) info("max_velocity: " + f6(st.vel) + "\nmax_accel: " + f6(st.accel) + "\nminimum_cruise_ratio: " + f6(st.mcr) + "\nsquare_corner_velocity: " + f6(st.scv));
    }, "Set printer velocity limits");
    register("M204", (g) => {
      let a = g.float("S", null, { above: 0 });
      if (a === null) { const p = g.float("P", null, { above: 0 }), t = g.float("T", null, { above: 0 }); if (p === null || t === null) { info('Invalid M204 command "' + g.origline + '"'); return; } a = Math.min(p, t); }
      st.accel = a;
    }, null);
    // homing (the base G28; the printer's [homing_override] wraps it)
    register("G28", (g) => {
      const axes = ["x", "y", "z"].filter((a) => g.params[a.toUpperCase()] !== undefined);
      homeAxes(axes.length ? axes : ["x", "y", "z"]);
    }, null);
    register("SET_KINEMATIC_POSITION", (g) => {
      const k = kinPos();
      ["X", "Y", "Z"].forEach((a, i) => { if (g.params[a] !== undefined) { const v = g.float(a); st.kin[i] = v - (i === 0 ? st.car[st.primary] : i === 1 ? st.y : st.z); st.homed.add(a.toLowerCase()); } });
      const clear = (g.get("CLEAR", "") || "").toLowerCase();
      for (const c of clear) st.homed.delete(c);
      if (g.params.SET_HOMED !== undefined) for (const c of g.get("SET_HOMED").toLowerCase()) if ("xyz".includes(c)) st.homed.add(c);
      void k;
    }, "Force a low-level kinematic position");
    register("FORCE_MOVE", (g) => {
      const s = g.get("STEPPER"), d = g.float("DISTANCE"), v = g.float("VELOCITY", null, { above: 0 }), to = pose();
      const m = /^stepper_t([0-3])$/.exec(s);
      if (m) to.x[+m[1]] += d; else if (/^stepper_y[12]$/.test(s)) to.y += d; else if (s === "stepper_z") to.z += d; else err("Unknown stepper " + s);
      const save = st.primary; if (m) st.primary = +m[1];
      addMove(to, v, { label: "Force move" }); st.primary = save;
    }, "Manually move a stepper; invalidates kinematics");
    const motorsOff = () => { flush(); st.homed.clear(); };
    register("M84", motorsOff, null); register("M18", motorsOff, null);
    register("SET_STEPPER_ENABLE", (g) => { if (!g.int("ENABLE", 1)) st.homed.clear(); }, "Enable/disable individual stepper by name");
    // dual carriage
    register("SET_DUAL_CARRIAGE", (g) => {
      const name = g.get("CARRIAGE"), j = ["carriage_t0", "carriage_t1", "carriage_t2", "carriage_t3"].indexOf(name);
      if (j < 0) err("Invalid carriage '" + name + "'");
      const mode = g.get("MODE", "PRIMARY").toUpperCase();
      if (!["PRIMARY", "COPY", "MIRROR"].includes(mode)) err("Invalid mode=" + mode + " specified");
      if (mode === "PRIMARY") { flush(); setPrimary(j); }
      else { if (j === st.primary) err("Mode=" + mode + " is not supported for carriage=" + name); st.modes[j] = mode; }
    }, "Configure the dual carriages mode");
    register("SAVE_DUAL_CARRIAGE_STATE", (g) => { st.dcSaved = st.dcSaved || {}; st.dcSaved[g.get("NAME", "default")] = { modes: st.modes.slice(), primary: st.primary, car: st.car.slice() }; }, "Save dual carriages modes and positions");
    register("RESTORE_DUAL_CARRIAGE_STATE", (g) => {
      const s = (st.dcSaved || {})[g.get("NAME", "default")];
      if (!s) err("Unknown DUAL_CARRIAGE state: " + g.get("NAME", "default"));
      if (g.int("MOVE", 1)) { const speed = g.float("MOVE_SPEED", 0) || st.speed; const save = st.primary, dl = s.car.map((x, j) => Math.abs(x - st.car[j])); st.primary = dl.indexOf(Math.max(...dl)); addMove({ x: s.car, y: st.y, z: st.z }, speed, { label: "Moving" }); st.primary = save; }
      st.modes = s.modes.slice(); setPrimary(s.primary);
    }, "Restore dual carriages modes and positions");
    // extruders and heaters
    register("ACTIVATE_EXTRUDER", (g) => {
      const e = g.get("EXTRUDER");
      if (!EXTRUDERS.includes(e)) err("'" + e + "' is not a valid extruder.");
      if (st.extruder === e) { info("Extruder " + e + " already active"); return; }
      info("Activating extruder " + e); st.extruder = e; st.e = 0; st.base[3] = 0; st.extrudeFactor = 1;
    }, "Change the active extruder");
    register("SET_PRESSURE_ADVANCE", (g) => {
      const e = g.get("EXTRUDER", st.extruder); if (!st.pa[e]) err("Unknown extruder " + e);
      const pa = g.float("ADVANCE", st.pa[e].pa, { minval: 0 }), sm = g.float("SMOOTH_TIME", st.pa[e].smooth, { minval: 0, maxval: 0.2 });
      st.pa[e] = { pa, smooth: sm };
      info("pressure_advance: " + f6(pa) + "\npressure_advance_smooth_time: " + f6(sm));
    }, "Set pressure advance parameters");
    register("SET_EXTRUDER_ROTATION_DISTANCE", (g) => { const e = g.get("EXTRUDER"); if (!st.pa[e]) err("Unknown extruder " + e); info("Extruder '" + e + "' rotation distance set to " + f6(g.float("DISTANCE", parseFloat(sec(e).rotation_distance)))); }, "Set extruder rotation distance");
    register("SYNC_EXTRUDER_MOTION", (g) => { const e = g.get("EXTRUDER"), m = g.get("MOTION_QUEUE"); info("Extruder '" + e + "' now syncing with '" + m + "'"); }, "Set extruder stepper motion queue");
    register("M104", (g) => setTemp(heaterName(g), g.float("S", 0)), null);
    register("M109", function* (g) { const h = heaterName(g); setTemp(h, g.float("S", 0)); yield* waitUntil(() => settled(h), "Heating " + h); }, null);
    register("M140", (g) => setTemp("heater_bed", g.float("S", 0)), null);
    register("M190", function* (g) { setTemp("heater_bed", g.float("S", 0)); yield* waitUntil(() => settled("heater_bed"), "Heating bed"); }, null);
    register("SET_HEATER_TEMPERATURE", (g) => { const h = g.get("HEATER"); if (!heaters[h]) err("Unknown heater '" + h + "'"); setTemp(h, g.float("TARGET", 0)); }, "Sets a heater temperature");
    register("TURN_OFF_HEATERS", () => { for (const h of Object.values(heaters)) h.target = 0; }, "Turn off all heaters");
    register("TEMPERATURE_WAIT", function* (g) {
      const s = g.get("SENSOR"); if (!heaters[s] && !S["temperature_sensor " + s]) err("Unknown sensor '" + s + "'");
      if (g.params.MINIMUM === undefined && g.params.MAXIMUM === undefined) err("Error on 'TEMPERATURE_WAIT': missing MINIMUM or MAXIMUM.");
      const lo = g.float("MINIMUM", -Infinity), hi = g.float("MAXIMUM", Infinity);
      if (heaters[s]) yield* waitUntil(() => heaters[s].temp >= lo && heaters[s].temp <= hi, "Waiting for " + s);
    }, "Wait for a temperature on a sensor");
    // fans, pins, LEDs
    register("M106", (g) => { st.fans["fan_generic fan_t" + activeTool()] = g.float("S", 255, { minval: 0 }) / 255; }, null);
    register("M107", () => { st.fans["fan_generic fan_t" + activeTool()] = 0; }, null);
    register("SET_FAN_SPEED", (g) => { const f = "fan_generic " + g.get("FAN"); if (!(f in st.fans)) err("Unknown fan " + g.get("FAN")); st.fans[f] = Math.min(1, g.float("SPEED", 0, { minval: 0 })); }, "Sets the speed of a fan");   // fan_generic clamps to max_power
    register("SET_PIN", (g) => { const p = g.get("PIN"); if (!(p in st.pins)) err("Unknown pin " + p); st.pins[p] = g.float("VALUE", 0, { minval: 0, maxval: 1 }); }, "Set the value of an output pin");
    register("SET_LED", (g) => {
      const name = g.get("LED"); if (!(name in st.leds)) err("Unknown LED " + name);
      const c = ["RED", "GREEN", "BLUE", "WHITE"].map((k) => g.float(k, 0, { minval: 0, maxval: 1 }));
      st.leds[name] = c; ledToHost(name);
    }, "Set the color of an LED");
    // display, respond
    register("M117", (g) => { st.displayMsg = rawParams("M117", g.origline) || null; }, null);
    register("SET_DISPLAY_TEXT", (g) => { st.displayMsg = g.get("MSG", null); }, "Set or clear the display message");
    register("M73", (g) => { st.progress = g.float("P", 0) / 100; }, null);
    register("M118", (g) => raw("echo: " + rawParams("M118", g.origline)), null);
    register("RESPOND", (g) => {
      const type = g.get("TYPE", "echo").toLowerCase(), msg = g.get("MSG", "");
      if (type === "error") raw("!! " + msg); else if (type === "command") raw("// " + msg); else raw(g.get("PREFIX", "echo:") + " " + msg);
    }, "Echo the message prepended with a prefix");
    // macros and state
    register("SET_GCODE_VARIABLE", (g) => {
      const mname = g.get("MACRO"), m = [...macros.values()].find((x) => x.section.slice(12).toLowerCase() === mname.toLowerCase());
      if (!m) err("The value '" + mname + "' is not valid for MACRO");
      const v = g.get("VARIABLE"), value = g.get("VALUE");
      if (!m.vars.has(v)) err("Unknown gcode_macro variable '" + v + "'");
      let lit; try { lit = literalEval(value); } catch (e) { err("Unable to parse '" + value + "' as a literal: " + e.message + " in '" + g.origline + "'"); }
      const nv = new PyDict(m.vars.m); nv.set(v, lit); m.vars = nv;
    }, "Set the value of a G-Code macro variable");
    register("UPDATE_DELAYED_GCODE", (g) => {
      const id = g.get("ID"), d = delayed.find((x) => x.name.toLowerCase() === id.toLowerCase());
      if (!d) err("The value '" + id + "' is not valid for ID");
      const dur = g.float("DURATION", 0, { minval: 0 }); d.at = dur ? clock + dur : null;
    }, "Update the duration of a delayed_gcode");
    register("SAVE_VARIABLE", (g) => { const v = g.get("VARIABLE"); let lit; try { lit = literalEval(g.get("VALUE")); } catch (e) { err("Unable to parse '" + g.get("VALUE") + "' as a literal"); } st.saveVars[v] = lit; }, "Save arbitrary variables to disk");
    register("SAVE_CONFIG", () => info("SAVE_CONFIG is not available in this simulation: nothing was written."), "Overwrite config file and restart");
    register("SET_IDLE_TIMEOUT", (g) => info("idle_timeout: Timeout set to " + g.float("TIMEOUT", 99999999).toFixed(2) + " s"), "Set the idle timeout in seconds");
    register("QUERY_ENDSTOPS", () => info(["carriage_t0", "carriage_t1", "carriage_t2", "carriage_t3", "carriage_y", "carriage_z"].map((n) => n + ":open").join(" ")), "Report on the status of each endstop");
    register("QUERY_PROBE", () => { const t = st.z <= bedZ(st.car[st.primary], st.y) + 1e-3; st.probe.last_query = t; info("probe: " + (t ? "TRIGGERED" : "open")); }, "Return the status of the z-probe");
    register("PROBE", (g) => { const r = runProbe(g); info("Result: at " + f3(r[0]) + "," + f3(r[1]) + " estimate contact at z=" + f6(r[2])); }, "Probe Z-height at current XY position");
    register("PROBE_ACCURACY", (g) => {
      const n = g.int("SAMPLES", 10, { minval: 1 }), zs = [];
      info("PROBE_ACCURACY at X:" + f3(kinPos()[0]) + " Y:" + f3(kinPos()[1]) + " Z:" + f3(kinPos()[2]) + " (samples=" + n + " retract=" + f3(PROBE.retract) + " speed=" + f1(PROBE.speed) + " lift_speed=" + f1(PROBE.lift) + ")");
      for (let i = 0; i < n; i++) { const r = probeOnce(PROBE.speed); zs.push(r[2]); addMove(Object.assign(pose(), { z: st.z + PROBE.retract }), PROBE.lift, { label: "Probing" }); }
      const mx = Math.max(...zs), mn = Math.min(...zs), avg = zs.reduce((a, b) => a + b, 0) / n, med = zs.slice().sort((a, b) => a - b)[n >> 1];
      info("probe accuracy results: maximum " + f6(mx) + ", minimum " + f6(mn) + ", range " + f6(mx - mn) + ", average " + f6(avg) + ", median " + f6(med) + ", standard deviation 0.000000");
    }, "Probe Z-height accuracy at current XY position");
    register("LOAD_CELL_TARE", () => dwell(0.1, "Tare"), "Set the Zero point of the load cell");
    register("LOAD_CELL_READ", () => info("Load cell readings are not available in this simulation"), "Take a reading from the load cell");
    register("LOAD_CELL_DIAGNOSTIC", () => info("Load cell readings are not available in this simulation"), "Check the health of the load cell");
    // bed mesh
    register("BED_MESH_CALIBRATE", bedMeshCalibrate, "Perform Mesh Bed Leveling");
    register("BED_MESH_CLEAR", () => { st.meshActive = false; }, "Clear the Mesh so no z-adjustment is made");
    register("BED_MESH_OUTPUT", () => {
      if (!st.meshActive || !MESH) { info("Bed has not been probed"); return; }
      info("Mesh Leveling Probed Z positions:\n" + MESH.pts.map((r) => r.map((v) => " " + f6(v)).join("")).join("\n") + "\nMesh X,Y: " + MESH.pts[0].length + "," + MESH.pts.length + "\nSearch Height: 3\nMesh Offsets: X=0.0000, Y=0.0000\nMesh Average: " + f2(MESH.pts.flat().reduce((a, b) => a + b, 0) / MESH.pts.flat().length) + "\nMesh Range: min=" + f6(Math.min(...MESH.pts.flat())) + " max=" + f6(Math.max(...MESH.pts.flat())));
    }, "Retrieve interpolated grid of probed z-points");
    register("BED_MESH_PROFILE", (g) => {
      const p = g.params;
      if (p.LOAD) { if (!st.meshProfiles[p.LOAD]) err("bed_mesh: Unknown profile [" + p.LOAD + "]"); st.meshProfile = p.LOAD; st.meshActive = true; }
      else if (p.SAVE) { st.meshProfiles[p.SAVE] = savedMesh; info("Bed Mesh state has been saved to profile [" + p.SAVE + "]\nfor the current session.  The SAVE_CONFIG command will\nupdate the printer config file and restart the printer."); }
      else if (p.REMOVE) { delete st.meshProfiles[p.REMOVE]; info("Profile [" + p.REMOVE + "] removed from storage for this session.\nThe SAVE_CONFIG command will update the printer\nconfiguration and restart the printer"); }
      else info("Invalid syntax '" + g.origline + "'");
    }, "Bed Mesh Persistent Storage management");
    register("BED_MESH_MAP", () => info("mesh_map_output " + JSON.stringify({ mesh_min: [5, 5], mesh_max: [295, 295], z_positions: MESH ? MESH.pts : [] })), "Serialize mesh and output to terminal");
    register("BED_MESH_OFFSET", () => {}, "Add X/Y offsets to the mesh lookup");
    register("QUADRO_CUSTOM_BED_MESH", quadroCustomMesh, "Quadro bed mesh calibration with repeated probing and averaging");
    // input shaping and resonances
    register("SET_INPUT_SHAPER", (g) => {
      // input shaping follows the active carriage, so X settings are kept per carriage
      const sh = (st.shaper[st.primary] ||= { X: { type: "mzv", freq: 0, damp: 0.1 }, Y: null });
      st.shaper.Y ||= { type: "mzv", freq: 0, damp: 0.1 };
      for (const a of ["X", "Y"]) {
        const t = a === "X" ? sh.X : st.shaper.Y;
        if (g.params["SHAPER_FREQ_" + a] !== undefined) t.freq = g.float("SHAPER_FREQ_" + a, 0, { minval: 0 });
        if (g.params["SHAPER_TYPE_" + a] !== undefined) t.type = g.get("SHAPER_TYPE_" + a).toLowerCase();
        if (g.params["DAMPING_RATIO_" + a] !== undefined) t.damp = g.float("DAMPING_RATIO_" + a, 0.1, { minval: 0, maxval: 1 });
      }
      for (const [a, t] of [["x", sh.X], ["y", st.shaper.Y]]) info("shaper_type_" + a + ":" + t.type + " shaper_freq_" + a + ":" + f3(t.freq) + " damping_ratio_" + a + ":" + f6(t.damp));
    }, "Set cartesian parameters for input shaper");
    const qis = sec("quadro_input_shaper");
    register("TEST_RESONANCES", (g) => { const ax = g.get("AXIS").toLowerCase(); resonanceSweep(ax, "Resonance test"); info("Resonances data not available in this simulation (no accelerometer)"); }, "Runs the resonance test for a specifed axis");
    register("SHAPER_CALIBRATE", (g) => {
      const axes = g.params.AXIS ? [g.get("AXIS").toLowerCase()] : ["x", "y"];
      for (const ax of axes) { resonanceSweep(ax, "Shaper calibration"); const t = ax === "y" ? qis.shaper_type_y : qis.shaper_type_x_carriage_t0, fq = ax === "y" ? qis.shaper_freq_y : qis.shaper_freq_x_carriage_t0; info("Recommended shaper_type_" + ax + " = " + t + ", shaper_freq_" + ax + " = " + f1(parseFloat(fq)) + " Hz  (the printer's last calibration; accelerometers are not simulated)"); }
    }, "Similar to TEST_RESONANCES but suggest input shaper config");
    register("MEASURE_AXES_NOISE", () => info("Accelerometer readings are not available in this simulation"), "Measures noise of all enabled accelerometer chips");
    register("ACCELEROMETER_QUERY", () => info("Accelerometer readings are not available in this simulation"), "Query accelerometer for the current values");
    register("QUADRO_SHAPER_CALIBRATE", function* (g) {
      const cars = (qis.carriages || "").split(",").map((s) => s.trim()), only = g.params.CARRIAGE;
      if (only && !cars.includes(only)) err("Bilinmeyen karet '" + only + "'. Gecerli degerler: " + cars.join(", "));
      for (const c of only ? [only] : cars) {
        info("Kafa " + c + ": parklaniyor..."); yield* runLine(qis["change_cmd_" + c]);
        for (const ax of c === cars[0] ? ["x", "y"] : ["x"]) {
          info("Kafa " + c + " " + ax + " ekseni: olcum yapiliyor..."); resonanceSweep(ax, "Shaper calibration");
          const t = ax === "y" ? qis.shaper_type_y : qis["shaper_type_x_" + c], fq = ax === "y" ? qis.shaper_freq_y : qis["shaper_freq_x_" + c];
          info("Kafa " + c + " " + ax + " ekseni: " + t + " @ " + f1(parseFloat(fq)) + " Hz  (the printer's last calibration; accelerometers are not simulated)");
        }
      }
      info("Kalibrasyon bitti (" + (only ? only : cars.join(", ")) + "). Kaydetmek icin SAVE_CONFIG calistirin.");
    }, "Park each head and calibrate its input shaper");
    // TMC drivers
    register("SET_TMC_FIELD", (g) => { g.get("STEPPER"); g.get("FIELD"); }, "Set a register field of a TMC driver");
    register("SET_TMC_CURRENT", (g) => info("Run Current: " + f2(g.float("CURRENT", 1)) + "A Hold Current: " + f2(g.float("HOLDCURRENT", g.float("CURRENT", 1))) + "A"), "Set the current of a TMC driver");
    register("DUMP_TMC", () => info("TMC driver registers are not available in this simulation"), "Read and display TMC stepper driver registers");
    register("INIT_TMC", () => {}, "Initialize TMC stepper driver registers");
    // pause / resume / virtual sdcard / print stats
    register("PAUSE", () => {
      if (st.paused) { info("Print already paused"); return; }
      if (!st.pauseSent) { st.pauseSent = true; if (host.print.state() !== "printing") info("action:paused"); }
      saveState("PAUSE_STATE"); st.paused = true;
    }, "Pauses the current print");
    register("RESUME", function* (g) {
      if (!st.paused) { info("Print is not paused, resume aborted"); return; }
      const v = g.float("VELOCITY", 50);
      yield* runLine("RESTORE_GCODE_STATE NAME=PAUSE_STATE MOVE=1 MOVE_SPEED=" + v.toFixed(4));
      st.pauseSent = false; st.paused = false;
      queueItem({ kind: "resume", T: 0, label: "Resuming", resume: true });
    }, "Resumes the print from a pause");
    register("CLEAR_PAUSE", () => { st.paused = st.pauseSent = false; }, "Clears the current paused state without resuming the print");
    register("CANCEL_PRINT", () => { queueCall(() => host.print.cancel()); st.paused = st.pauseSent = false; }, "Cancel the current print");
    register("SDCARD_PRINT_FILE", (g) => {
      const f = g.get("FILENAME").replace(/^\/+/, "");
      if (!sdFiles().includes(f)) err("Unable to open file");
      if (host.print.state() === "printing") err("SD busy");
      queueCall(() => host.print.start(f));
    }, "Loads a SD file and starts the print.  May include files in subdirectories.");
    register("SDCARD_RESET_FILE", () => { if (host.print.state() === "printing") err("Cannot reset file while printing"); }, "Clears a loaded SD File. Stops the print if necessary");
    register("M20", () => raw("Begin file list\n" + sdFiles().map((f) => f + " 412844").join("\n") + "\nEnd file list"), null);
    register("M23", (g) => { const f = rawParams("M23", g.origline).trim(); if (!sdFiles().includes(f)) err("Unable to open file"); st.sdFile = f; raw("File opened:" + f + " Size:412844\nFile selected"); }, null);
    register("M24", function* () { if (st.paused) yield* runLine("RESUME"); else queueCall(() => host.print.start(st.sdFile)); }, null);
    register("M25", function* () { yield* runLine("PAUSE"); }, null);
    register("M26", () => {}, null);
    register("M27", () => raw(host.print.state() === "printing" ? "SD printing byte " + Math.round(host.print.progress() * 412844) + "/412844" : "Not SD printing."), null);
    register("SET_PRINT_STATS_INFO", (g) => { void g; }, "Pass slicer info like layer act and total to klipper");
    register("EXCLUDE_OBJECT", (g) => {
      if (g.params.NAME === undefined) { info("Excluded objects: " + (st.excluded.join(" ") || "none")); return; }
      const n = g.get("NAME").toUpperCase(); if (n !== "ALIGNMENT_TEST_CUBE") err("Unknown object " + n); if (!st.excluded.includes(n)) st.excluded.push(n);
      info("Excluding object " + n);
      queueCall(() => host.print.cancel());
    }, "Cancel moves for the current or specified object");
    register("EXCLUDE_OBJECT_START", (g) => { st.currentObject = g.get("NAME").toUpperCase(); }, "Marks the beginning the current object as labeled");
    register("EXCLUDE_OBJECT_END", () => { st.currentObject = null; }, "Marks the end the current object");
    register("EXCLUDE_OBJECT_DEFINE", () => {}, "Provides a summary of an object");
    // the printer's own modules
    register("QUADRO_PARALLEL_MOVE", parallelMove, "Move multiple Quadro X carriages and optional shared Y/Z simultaneously");
    register("QUADRO_RUN_TOOLCHANGE", function* (g) {
      const accel = g.float("ACCEL", 10000, { above: 0 }), prev = st.accel, script = g.get("SCRIPT", "");
      st.accel = accel; try { yield* runScript(script.replace(/\\n/g, "\n")); } finally { st.accel = prev; }
    }, null);
    register("BED_PIN_CALIBRATE_TOOL", pinCalibrateTool, null);
    register("BED_PIN_CALIBRATE_ALL", pinCalibrateAll, null);
    register("BED_PIN_SAVE_OFFSETS", () => {
      const R = st.bedPin.results, missing = TOOLS.filter((t) => !R[t]);
      if (missing.length) err("Refusing to overwrite offsets with incomplete calibration. Missing: " + missing.join(", ") + ". Run BED_PIN_CALIBRATE_ALL first.");
      if (R.T0.x_offset_vs_t0 === undefined) { info("Calculating offsets vs T0..."); for (const t of TOOLS) Object.assign(R[t], { x_offset_vs_t0: R[t].center_x - R.T0.center_x, y_offset_vs_t0: R[t].center_y - R.T0.center_y, z_offset_vs_t0: R[t].z.z - R.T0.z.z }); }
      st.bedPin.offsets = Object.fromEntries(TOOLS.map((t) => [t, { x: R[t].x_offset_vs_t0, y: R[t].y_offset_vs_t0, z: R[t].z_offset_vs_t0 }]));
      info("Offsets saved to " + OFFSETS_PATH + ":\n" + TOOLS.map((t) => t + ": X=" + f3(R[t].x_offset_vs_t0) + " Y=" + f3(R[t].y_offset_vs_t0) + " Z=" + f3(R[t].z_offset_vs_t0)).join("\n"));
    }, null);
    register("BED_PIN_LOAD_OFFSETS", () => { st.bedPin.offsets = JSON.parse(JSON.stringify(CFG.bedPinOffsets || {})); info("Bed pin offsets loaded from " + OFFSETS_PATH); }, null);
    register("BED_PIN_APPLY_OFFSET", function* (g) {
      const tool = g.get("TOOL", "T0").toUpperCase(), o = st.bedPin.offsets[tool] || { x: 0, y: 0, z: 0 };
      yield* runLine("SET_GCODE_OFFSET Z=" + f5(o.z) + " MOVE=0"); yield* runLine("SET_GCODE_OFFSET X=" + f5(o.x) + " Y=" + f5(o.y) + " MOVE=0");
      info("Applied offset for " + tool + ": X=" + f5(o.x) + " Y=" + f5(o.y) + " Z=" + f5(o.z));
    }, null);
    register("BED_PIN_PARK_FOR_CLEAN", function* () { yield* clearOffsets(); moveZ(20, 5, "Parking"); moveXY(150, 0, 50, "Parking"); info("BED_PIN_PARK_FOR_CLEAN X=150 Y=0 Z=20"); }, null);
    register("AXIS_SLIP_TEST", (g) => slipTest(g, [g.float("ACCEL", 7000, { above: 0 })], "AXIS_SLIP_TEST"), "Touch the bed pin, run a burst and measure lost steps");
    register("AXIS_SLIP_SWEEP", (g) => {
      const s = g.float("START", 4000, { above: 0 }), e = g.float("END", 12000, { minval: s }), stp = g.float("STEP", 1000, { above: 0 }), a = [];
      for (let v = s; v <= e + 1e-9; v += stp) a.push(v);
      slipTest(g, a, "AXIS_SLIP_SWEEP");
    }, "Run AXIS_SLIP_TEST over a range of accelerations");
    register("PA_CALIBRATE_LOADCELL", () => {
      info("PA kalibrasyonu basliyor - purge pozisyonuna gidiliyor...");
      manualMove([null, null, 12], 10, "PA calibration"); manualMove([5, 150, null], 100, "PA calibration");
      for (const flow of [4.2, 15.0, 28.0]) { info("Hiz test ediliyor: " + f2(flow) + " mm3/s"); dwell(13 * (3 / (flow / 2.405) + 0.05), "PA calibration"); }
      info("Load cell force readings are not available in this simulation, so no K value was calculated.");
    }, "Load cell ile pressure advance (K) kalibrasyonu yapar");
    // coprint_leds.py
    const thIndex = (g) => { const n = g.get("LED_NAME"); if (!(n in st.leds)) err("Bilinmeyen LED_NAME: " + n); return n; };
    register("TH_SET_FILAMENT", (g) => { const n = thIndex(g), hex = g.get("HEX", "FFFFFF"); st.leds[n] = [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, 0]; ledToHost(n); }, "TH_SET_FILAMENT LED_NAME=th1_led HEX=FF8800");
    register("TH_CLEAR_FILAMENT", (g) => { const n = thIndex(g); st.leds[n] = [0, 0, 0, 0]; ledToHost(n); }, "TH_CLEAR_FILAMENT LED_NAME=th1_led");
    register("TH_LOADING_START", (g) => { thIndex(g); }, "TH_LOADING_START LED_NAME=th1_led");
    register("TH_LOADING_END", (g) => { thIndex(g); }, "TH_LOADING_END LED_NAME=th1_led");
    register("PRINT_STATE_START", (g) => { g.int("EXTRUDER_INDEX", 0); }, "PRINT_STATE_START EXTRUDER_INDEX=0");
    register("PRINT_STATE_TOOLCHANGE", (g) => { g.int("EXTRUDER_INDEX", 0); }, "PRINT_STATE_TOOLCHANGE EXTRUDER_INDEX=1");
    register("PRINT_STATE_END", () => {}, "PRINT_STATE_END");
    register("START_WHITE_WAVE", () => {}, "START_WHITE_WAVE [STEP=0.08] [WIDTH=1.3] [INTERVAL=0.15]");
    register("STOP_WHITE_WAVE", () => {}, "STOP_WHITE_WAVE");
    // [homing_override] replaces G28; inside its own script G28 is the real homing
    const ho = S.homing_override;
    if (ho) {
      const tpl = compile(ho.gcode, "homing_override:gcode"), axes = (ho.axes || "XYZ").toUpperCase(), prev = commands.get("G28").fn;
      let inHo = false;
      register("G28", function* (g) {
        if (inHo) return prev(g);
        const given = ["X", "Y", "Z"].filter((a) => g.params[a] !== undefined);
        if (given.length && !given.some((a) => axes.includes(a))) return prev(g);
        const ctx = templateContext(); ctx.params = g.paramsDict(); ctx.rawparams = g.raw;
        inHo = true;
        try { yield* runScript(renderTpl(tpl, ctx, "homing_override:gcode")); } finally { inHo = false; }
      }, null);
    }
    installMacros();
  }
  const isTraditionalCmd = (n) => isTraditional(n);
  const f1 = (v) => Number(v).toFixed(1);
  function ledToHost(name) { const j = Number(name.slice(2, 3)) - 1, c = st.leds[name]; queueCall(() => host.setLed(j, c.some((v) => v > 0) ? c : null)); }

  // ---------- delayed_gcode ----------
  let delayed = [];
  function setupDelayed() {
    delayed = Object.entries(S).filter(([n]) => n.startsWith("delayed_gcode ")).map(([n, o]) => ({ name: n.slice(14).trim(), tpl: compile(o.gcode || "", n + ":gcode"), at: o.initial_duration && parseFloat(o.initial_duration) ? clock + parseFloat(o.initial_duration) : null }));
  }
  function runDelayed() {
    for (const d of delayed) if (d.at !== null && clock >= d.at && !st.shutdown) {
      d.at = null;
      if (busy) { d.at = clock; continue; }
      startJob(runScript(renderTpl(d.tpl, templateContext(), "delayed_gcode " + d.name + ":gcode")), "delayed_gcode " + d.name);
    }
  }

  function restartHost(stateMsg) {
    host.halt(); pending = []; busy = null; inputs.length = 0;
    const p = host.pose();
    st = freshState({ x: p.x, y: p.y, z: p.z, active: 0, homed: [] });
    for (const h of Object.values(heaters)) h.target = 0;
    loadMacros(); registerAll(); setupDelayed(); settingsCache = null;
    host.activate(0);
    info(stateMsg);
  }

  // ---------- the G-code thread: one command at a time; waits (M109, M400, ...) suspend it ----------
  let busy = null;
  const inputs = [];
  function startJob(gen, line) { busy = { gen, line }; drive(); }
  function nextInput() { while (!busy && inputs.length) { const line = inputs.shift(); let gen; try { gen = runLine(line); } catch (e) { report(e, line); continue; } startJob(gen, line); } }
  function drive() {
    while (busy) {
      let r;
      try { r = busy.gen.next(); }
      catch (e) { pending = []; const line = busy.line; busy = null; report(e, line); break; }
      if (r.done) { flush(); busy = null; break; }
      flush(); return;                       // suspended until resume()
    }
    nextInput();
  }
  function resume() { if (busy) drive(); }
  function report(e, line) {
    if (e instanceof CommandError) {
      const lines = e.message.trim().split("\n");
      if (lines.length > 1) host.respond("// " + lines.join("\n// "), "info");
      host.respond("!! " + lines[0].trim(), "error");
    } else if (e instanceof TemplateError) host.respond("!! " + e.message, "error");
    else { host.respond("!! Internal error on command:\"" + String(line).trim().split(/\s+/)[0].toUpperCase() + "\"", "error"); console.error(e); }
  }

  // ---------- public API ----------
  st = freshState(Object.assign({ active: 0 }, host.pose()));
  loadMacros(); registerAll(); setupDelayed();
  return {
    // run one console line, as Mainsail would send it
    run(line) {
      // M112 is handled at once, even while another command waits
      if (/^\s*M112\b/i.test(line)) { busy = null; inputs.length = 0; }
      inputs.push(line); if (!busy) nextInput();
    },
    abort() { busy = null; inputs.length = 0; pending = []; },
    busy: () => !!busy,
    // adopt the animated machine as the commanded state (after the print hands over to the console)
    sync(p) {
      st.car = p.x.slice(); st.y = p.y; st.z = p.z; st.kin = [0, 0, 0];
      if (p.homed) st.homed = new Set(p.homed);
      if (p.active >= 0) { st.modes = st.modes.map((m, k) => (k === p.active ? "PRIMARY" : "INACTIVE")); st.primary = p.active; st.extruder = EXTRUDERS[p.active]; }
    },
    tick(dt) { clock += dt; tickHeaters(dt); runDelayed(); },
    heaters: () => Object.fromEntries(Object.entries(heaters).map(([k, h]) => [k, { temp: h.temp, target: h.target, power: h.power }])),
    setHeaters(targets) { for (const [k, v] of Object.entries(targets)) { heaters[k].target = v; heaters[k].temp = v || AMBIENT; } },
    state: () => st,
    commandNames: () => [...commands.keys()].sort(),
    isShutdown: () => !!st.shutdown,
    // a gcode_macro variable as plain text (the screen follows CALIBRATION_STATUS this way)
    macroVar(macro, name) {
      const m = [...macros.values()].find((x) => x.section.slice(12).toLowerCase() === macro.toLowerCase());
      const v = m && m.vars.get(name);
      return v == null ? null : String(v);
    },
    bedZ,
  };
}
