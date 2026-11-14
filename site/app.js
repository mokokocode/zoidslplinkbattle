// Zoids Legacy Plus Link Battle: page logic.
// Each player runs their own game in their own browser. The two emulators are joined by a network link cable
// (see emulator/netlink.c): only link cable words travel between the players, over a WebRTC data channel.

const PROTO = 1;                       // bump when the messages below change
const ROOM_PREFIX = "zlplus-link-v1-room-";
const ROOM_SLOTS = 12;                 // rooms that can be open at once
const PACKET_MS = 14.25;               // one 11-word link packet of the game
const SAVE_SIZE = 32768;               // the game's battery save
const PUMP_MS = 4;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  roms: null,          // roms.json
  rom: null,           // { kind: "clean" | build id, bytes }
  built: {},           // build id -> patched ROM bytes
  save: null,          // Uint8Array(SAVE_SIZE)
  peer: null,
  room: null,          // { host: bool, slot, build, hostName, guestName, ctl, link, ready, playing }
  emu: null,
  pump: 0,
  statTimer: 0,
  navBusy: false,
  muted: false,
};

/* ---------------------------------------------------------------- small helpers */

function show(view) {
  for (const v of ["setup", "lobby", "room", "game"]) $("view-" + v).hidden = v !== view;
}
function setStatus(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
}
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) { /* private window, blocked storage: the page works without it */ }
  return null;
}
async function sha1(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
function playerName() {
  return ($("name").value.trim() || "Player").slice(0, 16);
}
function buildLabel(id) {
  const b = state.roms.builds[id];
  return b ? b.label : id;
}

/* ---------------------------------------------------------------- ROM and save */

function applyIps(source, patch) {
  const p = patch;
  if (String.fromCharCode(p[0], p[1], p[2], p[3], p[4]) !== "PATCH") throw new Error("bad patch file");
  const records = [];
  let i = 5, end = source.length;
  while (i + 3 <= p.length) {
    if (p[i] === 0x45 && p[i + 1] === 0x4f && p[i + 2] === 0x46) { i += 3; break; }   // "EOF"
    const off = (p[i] << 16) | (p[i + 1] << 8) | p[i + 2];
    let size = (p[i + 3] << 8) | p[i + 4];
    i += 5;
    if (size) {
      records.push([off, size, i, -1]);
      i += size;
    } else {
      size = (p[i] << 8) | p[i + 1];
      records.push([off, size, -1, p[i + 2]]);
      i += 3;
    }
    end = Math.max(end, off + size);
  }
  if (i + 3 <= p.length) end = (p[i] << 16) | (p[i + 1] << 8) | p[i + 2];              // truncate
  const out = new Uint8Array(end);
  out.set(source.subarray(0, Math.min(source.length, end)));
  for (const [off, size, at, fill] of records) {
    if (at >= 0) out.set(p.subarray(at, at + size), off);
    else out.fill(fill, off, off + size);
  }
  return out;
}

async function onRomFile(file) {
  state.rom = null;
  state.built = {};
  $("lang-row").hidden = true;
  updateContinue();
  if (!file) return setStatus("rom-status", "");
  setStatus("rom-status", "Checking…");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha1(bytes);
  const r = state.roms;
  if (hash === r.clean.sha1) {
    state.rom = { kind: "clean", bytes };
    $("lang-row").hidden = false;
    setStatus("rom-status", "Clean Zoids Legacy (USA). It will be patched to Plus " + r.version + " in your browser.", "ok");
  } else {
    const id = Object.keys(r.builds).find((k) => r.builds[k].sha1 === hash);
    if (id) {
      state.rom = { kind: id, bytes };
      state.built[id] = bytes;
      setStatus("rom-status", "Zoids Legacy Plus " + r.version + " (" + buildLabel(id) + ").", "ok");
    } else {
      const code = bytes.length >= 0xb0 ? String.fromCharCode(...bytes.subarray(0xac, 0xb0)) : "";
      setStatus("rom-status", code === r.gameCode
        ? "This is a Zoids Legacy ROM, but not a clean USA ROM and not the current Plus " + r.version +
          ". Use the latest Plus " + r.version + " file, or a clean ROM and let this page patch it."
        : "This is not a Zoids Legacy (USA) ROM.", "bad");
    }
  }
  updateContinue();
}

async function onSaveFile(file) {
  state.save = null;
  updateContinue();
  if (!file) return setStatus("save-status", "");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = String.fromCharCode(...bytes.subarray(0, 32));
  let msg = "", kind = "ok";
  if (/ADVSAVEG|SharkPortSave/.test(head)) {
    msg = "This is a GameShark or Action Replay save. Export a plain .sav from your emulator instead."; kind = "bad";
  } else if (bytes.length < SAVE_SIZE) {
    msg = "This file is too small to be a Zoids Legacy save (" + bytes.length + " bytes)."; kind = "bad";
  } else if (bytes.length > 139264 + 16) {
    msg = "This file is too large to be a battery save. Save states do not work here."; kind = "bad";
  } else {
    const save = bytes.slice(0, SAVE_SIZE);
    if (save.every((b) => b === 0xff) || save.every((b) => b === 0)) {
      msg = "This save is empty."; kind = "bad";
    } else {
      state.save = save;
      msg = bytes.length === SAVE_SIZE ? "Save loaded." : "Save loaded (extra data after the first 32 KB is ignored).";
    }
  }
  setStatus("save-status", msg, kind);
  updateContinue();
}

function updateContinue() {
  $("to-lobby").disabled = !(state.rom && state.save);
}

// the ROM for a Plus build: the uploaded file itself, or the clean ROM patched here
async function romFor(build) {
  if (state.built[build]) return state.built[build];
  if (!state.rom || state.rom.kind !== "clean") throw new Error("Your ROM is a different language build than this room.");
  const info = state.roms.builds[build];
  const res = await fetch(info.patch);
  if (!res.ok) throw new Error("Could not download the patch.");
  const out = applyIps(state.rom.bytes, new Uint8Array(await res.arrayBuffer()));
  if ((await sha1(out)) !== info.sha1) throw new Error("Patching did not give the expected ROM.");
  state.built[build] = out;
  return out;
}

/* ---------------------------------------------------------------- rooms (PeerJS) */

function peerOptions() {
  const o = { debug: 0 };
  if (params.get("peerhost")) {          // a self-hosted PeerServer (also used by the tests)
    o.host = params.get("peerhost");
    o.port = +(params.get("peerport") || 9000);
    o.path = params.get("peerpath") || "/";
    o.secure = params.get("peersecure") === "1";
  }
  return o;
}
function randomId() {
  const a = crypto.getRandomValues(new Uint8Array(9));
  return "zlplus-link-p-" + Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("");
}
function openPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(id, peerOptions());
    peer.once("open", () => resolve(peer));
    peer.once("error", (err) => { if (!peer.open) { peer.destroy(); reject(err); } });
  });
}
function closePeer() {
  if (state.peer) { try { state.peer.destroy(); } catch (e) { /* already gone */ } }
  state.peer = null;
}
async function lobbyPeer() {
  if (state.peer && state.peer.open && !state.peer.destroyed) return state.peer;
  closePeer();
  state.peer = await openPeer(randomId());
  return state.peer;
}

// ask one room slot who is there; null if nobody
function askRoom(peer, slot) {
  return new Promise((resolve) => {
    const id = ROOM_PREFIX + slot;
    let done = false;
    const conn = peer.connect(id, { label: "ctl", serialization: "json", reliable: true, metadata: { want: "info", v: PROTO } });
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      peer.off("error", onErr);
      try { conn.close(); } catch (e) { /* not open */ }
      resolve(v);
    };
    const onErr = (err) => { if (err.type === "peer-unavailable" && String(err.message).includes(id)) finish(null); };
    const timer = setTimeout(() => finish(null), 7000);
    peer.on("error", onErr);
    conn.on("data", (m) => { if (m && m.t === "info") finish({ slot, ...m }); });
    conn.on("error", () => finish(null));
  });
}

async function refreshRooms() {
  $("rooms").textContent = "";
  $("no-rooms").hidden = true;
  $("refresh").disabled = true;
  setStatus("lobby-status", "Looking for rooms…");
  try {
    const peer = await lobbyPeer();
    const found = (await Promise.all(Array.from({ length: ROOM_SLOTS }, (_, i) => askRoom(peer, i + 1)))).filter(Boolean);
    setStatus("lobby-status", "");
    $("no-rooms").hidden = found.length > 0;
    for (const r of found) {
      const li = document.createElement("li");
      const who = document.createElement("span"); who.className = "who"; who.textContent = r.name;
      const meta = document.createElement("span"); meta.className = "meta";
      const mine = state.rom.kind === "clean" || state.rom.kind === r.build;
      meta.textContent = buildLabel(r.build) + " · " + ({ open: "Open", full: "Full", playing: "In battle" }[r.state] || r.state) +
        (r.v !== PROTO ? " · other page version" : "");
      const btn = document.createElement("button"); btn.textContent = "Join";
      btn.disabled = r.state !== "open" || !mine || r.v !== PROTO;
      if (!mine) btn.title = "Your ROM is a different language build";
      btn.addEventListener("click", () => joinRoom(r));
      li.append(who, meta, btn);
      $("rooms").append(li);
    }
  } catch (e) {
    setStatus("lobby-status", "Could not reach the room service. Check your connection and press Refresh. (" + (e.type || e.message) + ")", "bad");
  }
  $("refresh").disabled = false;
}

/* host */

async function createRoom() {
  $("create-room").disabled = true;
  try {
    const build = state.rom.kind === "clean" ? $("lang").value : state.rom.kind;
    setStatus("lobby-status", state.rom.kind === "clean" ? "Patching your ROM…" : "Opening a room…");
    await romFor(build);
    setStatus("lobby-status", "Opening a room…");
    closePeer();
    let peer = null, slot = 0;
    for (let s = 1; s <= ROOM_SLOTS && !peer; s++) {
      try { peer = await openPeer(ROOM_PREFIX + s); slot = s; }
      catch (e) { if (e.type !== "unavailable-id") throw e; }
    }
    if (!peer) throw new Error("All rooms are in use. Try again later.");
    state.peer = peer;
    state.room = { host: true, slot, build, hostName: playerName(), guestName: "", ctl: null, link: null, ready: false, playing: false };
    peer.on("connection", onHostConnection);
    peer.on("disconnected", () => { if (state.peer === peer && !peer.destroyed) peer.reconnect(); });
    setStatus("lobby-status", "");
    renderRoom();
    show("room");
  } catch (e) {
    setStatus("lobby-status", e.message || String(e.type || e), "bad");
    closePeer();
  }
  $("create-room").disabled = false;
}

function onHostConnection(conn) {
  const room = state.room;
  const meta = conn.metadata || {};
  if (!room || !room.host) return conn.close();
  if (conn.label === "link") {
    if (!room.ctl || conn.peer !== room.ctl.peer) return conn.close();
    room.link = conn;
    wireLink(conn);
    conn.on("open", renderRoom);
    return;
  }
  conn.on("open", () => {
    const info = { t: "info", v: PROTO, name: room.hostName, build: room.build, state: room.playing ? "playing" : room.ctl ? "full" : "open" };
    if (meta.want !== "join") { conn.send(info); return; }
    let why = "";
    if (meta.v !== PROTO) why = "version";
    else if (room.ctl) why = "full";
    else if (meta.build && meta.build !== room.build) why = "build";
    if (why) { conn.send({ t: "refused", why }); setTimeout(() => conn.close(), 500); return; }
    room.ctl = conn;
    room.guestName = String(meta.name || "Player").slice(0, 16);
    room.ready = false;
    conn.on("data", onHostData);
    conn.on("close", () => { if (state.room === room && room.ctl === conn) otherLeft(); });
    conn.send({ t: "joined", name: room.hostName, build: room.build });
    renderRoom();
  });
}

function onHostData(m) {
  const room = state.room;
  if (!room || !m) return;
  if (m.t === "ready") { room.ready = !!m.ready; renderRoom(); }
  else if (m.t === "pong") { const w = pongWaiters.get(m.n); if (w) w(performance.now() - m.ts); }
  else if (m.t === "end") endGame("The other player left the battle.");
  else if (m.t === "leave") otherLeft();
}

const pongWaiters = new Map();
async function measureRoundTrip(conn) {
  const times = [];
  for (let n = 0; n < 10; n++) {
    const t = await new Promise((resolve) => {
      pongWaiters.set(n, resolve);
      conn.send({ t: "ping", n, ts: performance.now() });
      setTimeout(() => resolve(null), 2000);
    });
    pongWaiters.delete(n);
    if (t != null) times.push(t);
    await sleep(60);
  }
  if (times.length < 3) throw new Error("The connection to the other player is too unstable to start.");
  times.sort((a, b) => a - b);
  return { median: times[times.length >> 1], max: times[times.length - 1] };
}
// whole link packets player 1 runs behind player 2's replies: round trip, its spread, both pages' send timers, a margin
function lagFor(rt) {
  return Math.max(3, Math.min(80, Math.ceil((rt.max + (rt.max - rt.median) + 3 * PUMP_MS) / PACKET_MS) + 2));
}

async function hostStart() {
  const room = state.room;
  $("start").disabled = true;
  try {
    setStatus("room-status", "Measuring the connection…");
    const rt = await measureRoundTrip(room.ctl);
    const lag = +(params.get("lag") || 0) || lagFor(rt);
    room.ctl.send({ t: "start", lag, rt: Math.round(rt.median) });
    await startGame(0, lag, rt.median);
  } catch (e) {
    setStatus("room-status", e.message || String(e), "bad");
    renderRoom();
  }
}

/* guest */

async function joinRoom(r) {
  setStatus("lobby-status", "Joining " + r.name + "…");
  try {
    const peer = await lobbyPeer();
    const fixed = state.rom.kind === "clean" ? null : state.rom.kind;
    const ctl = peer.connect(ROOM_PREFIX + r.slot, { label: "ctl", serialization: "json", reliable: true,
      metadata: { want: "join", v: PROTO, name: playerName(), build: fixed } });
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The room did not answer.")), 10000);
      ctl.on("data", function first(m) {
        if (m && (m.t === "joined" || m.t === "refused")) { clearTimeout(timer); ctl.off("data", first); resolve(m); }
      });
      ctl.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    if (answer.t === "refused") {
      try { ctl.close(); } catch (e) { /* closed */ }
      throw new Error({ full: "That room is full.", build: "Your ROM is a different language build than that room.",
        version: "That room uses a different version of this page. Reload and try again." }[answer.why] || "The room refused.");
    }
    if (state.rom.kind === "clean") setStatus("lobby-status", "Patching your ROM…");
    await romFor(answer.build);
    const link = peer.connect(ROOM_PREFIX + r.slot, { label: "link", serialization: "raw", reliable: true });
    wireLink(link);
    state.room = { host: false, slot: r.slot, build: answer.build, hostName: answer.name, guestName: playerName(), ctl, link, ready: false, playing: false };
    const room = state.room;
    ctl.on("data", onGuestData);
    ctl.on("close", () => { if (state.room === room) otherLeft(); });
    link.on("open", renderRoom);
    setStatus("lobby-status", "");
    renderRoom();
    show("room");
  } catch (e) {
    setStatus("lobby-status", e.message || String(e.type || e), "bad");
  }
}

function onGuestData(m) {
  const room = state.room;
  if (!room || !m) return;
  if (m.t === "ping") room.ctl.send({ t: "pong", n: m.n, ts: m.ts });
  else if (m.t === "start") startGame(1, m.lag, m.rt).catch((e) => { setStatus("room-status", e.message || String(e), "bad"); renderRoom(); });
  else if (m.t === "end") endGame("The other player left the battle.");
  else if (m.t === "leave") otherLeft();
}

/* both */

function renderRoom() {
  const room = state.room;
  if (!room) return;
  $("room-title").textContent = room.hostName + "'s room · " + buildLabel(room.build);
  $("p1-name").textContent = room.hostName;
  $("p1-state").textContent = room.host ? "you" : "";
  $("p2-name").textContent = room.guestName || "Waiting for a player…";
  $("p2-state").textContent = !room.guestName ? "" : (room.ready ? "ready" : "not ready") + (room.host ? "" : " · you");
  $("ready").hidden = room.host;
  $("start").hidden = !room.host;
  const linked = room.link && room.link.open;
  $("ready").textContent = room.ready ? "Not ready" : "Ready";
  $("ready").disabled = !linked;
  $("start").disabled = !(room.ctl && room.ready && linked);
  if (!room.playing) {
    setStatus("room-status", room.host
      ? (!room.ctl ? "Waiting for someone to join." : !room.ready ? "Waiting for " + room.guestName + " to press Ready." : "Both ready. Press Start.")
      : (!linked ? "Connecting to " + room.hostName + "…" : room.ready ? "Waiting for " + room.hostName + " to start." : "Press Ready when you are."));
  }
}

function otherLeft() {
  const room = state.room;
  if (!room) return;
  const wasPlaying = room.playing;
  if (wasPlaying) stopEmulator();
  if (room.host) {
    room.ctl = null; room.link = null; room.guestName = ""; room.ready = false; room.playing = false;
    renderRoom();
    show("room");
    setStatus("room-status", "The other player left. Waiting for someone to join.");
  } else {
    state.room = null;
    show("lobby");
    refreshRooms().then(() => setStatus("lobby-status", "The room was closed."));
  }
}

function leaveRoom() {
  const room = state.room;
  if (!room) return;
  if (room.playing) stopEmulator();
  try { if (room.ctl && room.ctl.open) room.ctl.send({ t: "leave" }); } catch (e) { /* gone */ }
  state.room = null;
  setTimeout(() => {
    if (room.host) closePeer();
    else { try { room.link && room.link.close(); room.ctl && room.ctl.close(); } catch (e) { /* gone */ } }
    refreshRooms();
  }, 150);
  show("lobby");
}

/* ---------------------------------------------------------------- emulator */

function wireLink(conn) {
  conn.on("data", (data) => {
    if (!state.room || !state.room.playing || !state.emu || !state.emu.netLinkReceive) return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (bytes && bytes.length) state.emu.netLinkReceive(bytes);
  });
}

async function emulator() {
  if (state.emu) return state.emu;
  const { default: mGBA } = await import("./emu/mgba.js");
  const emu = await mGBA({ canvas: $("canvas") });
  await emu.FSInit();
  state.emu = emu;
  return emu;
}

// The title screen keys that open Options > Multiplayer: [game frames to wait first, button].
// The title appears between frames 900 and 1200 and Start does not skip the logos, so the first key waits for it.
const NAV = [[1260, "start"], [70, "down"], [40, "down"], [40, "a"], [110, "down"], [40, "a"]];
const FPS = 59.7275;

async function startGame(role, lag, rt) {
  const room = state.room;
  room.playing = true;
  show("game");
  $("overlay").hidden = false;
  $("overlay").textContent = "Starting the game…";
  setStatus("link-status", "");
  const emu = await emulator();
  if (state.room !== room || !room.playing) return;
  const paths = emu.filePaths();
  const romPath = paths.gamePath + "/zlplus-" + room.build + ".gba";
  const savePath = paths.savePath + "/zlplus-" + room.build + ".sav";
  emu.FS.writeFile(romPath, await romFor(room.build));
  emu.FS.writeFile(savePath, state.save);          // a copy: your own save file is never changed
  // No save states here. The emulator's 30 second autosave pauses the game thread from the page's thread, which
  // freezes the link while player 1 waits for a reply, and restoring an old autosave would resume a previous battle.
  if (emu.setCoreSettings) emu.setCoreSettings({ autoSaveStateEnable: false, restoreAutoSaveStateOnLoad: false, rewindEnable: false });
  if (!emu.loadGame(romPath, savePath)) throw new Error("The emulator could not load the ROM.");
  emu.toggleInput(false);                           // keys are handled by this page
  if (emu.setVolume) emu.setVolume(state.muted ? 0 : 1);
  const linked = !!emu.netLinkStart && emu.netLinkStart(role, lag);
  if (linked) {
    state.pump = setInterval(() => {
      const out = emu.netLinkTake();
      if (out.length && room.link && room.link.open) room.link.send(out);
    }, PUMP_MS);
  }
  state.statTimer = setInterval(() => {
    if (!linked) return setStatus("link-status", "This emulator build has no network link.", "bad");
    const s = emu.netLinkStats();
    setStatus("link-status", "Player " + (role + 1) + " · round trip about " + Math.round(rt) + " ms" +
      (s.peerMulti && s.multi ? " · linked" : " · waiting for both games to open Multiplayer") +
      (s.timeouts ? " · connection stalled " + s.timeouts + "×" : ""), s.timeouts ? "bad" : "");
  }, 1000);
  // walk the title menu to Options > Multiplayer for the player
  state.navBusy = true;
  const began = performance.now();
  const frames = () => (emu.frameCount ? emu.frameCount() : (performance.now() - began) / 1000 * FPS);
  let at = 0;
  for (const [wait, key] of NAV) {
    at += wait;
    while (frames() < at) {
      $("overlay").textContent = "Starting the game… " + Math.min(99, Math.round(frames() / 1500 * 100)) + "%";
      await sleep(50);
      if (state.room !== room || !room.playing) return;
    }
    emu.buttonPress(key);
    await sleep(100);
    emu.buttonUnpress(key);
    at = frames();
  }
  await sleep(1200);
  state.navBusy = false;
  $("overlay").hidden = true;
}

function stopEmulator() {
  clearInterval(state.pump); state.pump = 0;
  clearInterval(state.statTimer); state.statTimer = 0;
  state.navBusy = false;
  const emu = state.emu;
  if (emu) {
    try { for (const k of BUTTONS) emu.buttonUnpress(k); } catch (e) { /* no game */ }
    try { if (emu.netLinkStop) emu.netLinkStop(); } catch (e) { /* not started */ }
    try { emu.quitGame(); } catch (e) { /* no game */ }
  }
}

function endGame(message) {
  const room = state.room;
  if (!room || !room.playing) return;
  stopEmulator();
  room.playing = false;
  room.ready = false;
  renderRoom();
  show("room");
  if (message) setStatus("room-status", message);
}

function leaveGame() {
  const room = state.room;
  if (!room) return;
  try { room.ctl.send({ t: "end" }); } catch (e) { /* gone */ }
  endGame("");
}

/* ---------------------------------------------------------------- controls */

const BUTTONS = ["up", "down", "left", "right", "a", "b", "l", "r", "start", "select"];
const BUTTON_LABEL = { up: "Up", down: "Down", left: "Left", right: "Right", a: "A", b: "B", l: "L", r: "R", start: "Start", select: "Select" };
// mGBA's default keyboard layout
const DEFAULT_KEYS = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", a: "KeyX", b: "KeyZ", l: "KeyA", r: "KeyS", start: "Enter", select: "Backspace" };
let keys = { ...DEFAULT_KEYS };
let listening = null;

function loadKeys() {
  try {
    const saved = JSON.parse(store("zlplus.keys") || "null");
    if (saved) for (const b of BUTTONS) if (typeof saved[b] === "string") keys[b] = saved[b];
  } catch (e) { /* bad stored value: defaults */ }
}
function keyName(code) {
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "Arrow ").replace(/^Numpad/, "Numpad ");
}
function renderKeys() {
  const t = $("keys");
  t.textContent = "";
  for (const b of BUTTONS) {
    const tr = document.createElement("tr");
    const name = document.createElement("td"); name.textContent = BUTTON_LABEL[b];
    const cell = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = listening === b ? "Press a key…" : keyName(keys[b]);
    if (listening === b) btn.className = "listening";
    btn.addEventListener("click", () => { listening = b; renderKeys(); });
    cell.append(btn); tr.append(name, cell); t.append(tr);
  }
}
function press(button, down) {
  const emu = state.emu;
  if (!emu || state.navBusy || !state.room || !state.room.playing) return;
  if (down) emu.buttonPress(button); else emu.buttonUnpress(button);
}
function onKey(e, down) {
  if (listening) {
    if (!down) return;
    e.preventDefault();
    if (e.code !== "Escape") {
      for (const b of BUTTONS) if (keys[b] === e.code) keys[b] = keys[listening];   // swap, so no key does two things
      keys[listening] = e.code;
      store("zlplus.keys", JSON.stringify(keys));
    }
    listening = null;
    return renderKeys();
  }
  if ($("view-game").hidden || $("controls").open || e.repeat && down) { if (!$("view-game").hidden && !$("controls").open) e.preventDefault(); return; }
  const b = BUTTONS.find((k) => keys[k] === e.code);
  if (!b) return;
  e.preventDefault();
  press(b, down);
}
function setupPad() {
  for (const btn of document.querySelectorAll("#pad button")) {
    const k = btn.dataset.k;
    const down = (e) => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (x) { /* fine */ } btn.classList.add("on"); press(k, true); };
    const up = (e) => { e.preventDefault(); btn.classList.remove("on"); press(k, false); };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  const touch = matchMedia("(pointer: coarse)").matches;
  const saved = store("zlplus.pad");
  $("pad").hidden = saved ? saved !== "1" : !touch;
  $("toggle-pad").addEventListener("click", () => { $("pad").hidden = !$("pad").hidden; store("zlplus.pad", $("pad").hidden ? "0" : "1"); });
}

/* ---------------------------------------------------------------- start */

async function main() {
  state.roms = await (await fetch("roms.json")).json();
  $("version-line").textContent = "For Zoids Legacy Plus " + state.roms.version + ". Both players need the same language.";
  for (const el of document.querySelectorAll(".ver")) el.textContent = state.roms.version;
  for (const [id, b] of Object.entries(state.roms.builds)) $("lang").append(new Option(b.label, id));
  $("name").value = store("zlplus.name") || "";
  loadKeys();
  renderKeys();
  setupPad();

  $("rom-file").addEventListener("change", (e) => onRomFile(e.target.files[0]).catch((x) => setStatus("rom-status", String(x.message || x), "bad")));
  $("save-file").addEventListener("change", (e) => onSaveFile(e.target.files[0]).catch((x) => setStatus("save-status", String(x.message || x), "bad")));
  $("name").addEventListener("change", () => store("zlplus.name", $("name").value.trim()));
  $("to-lobby").addEventListener("click", () => { show("lobby"); refreshRooms(); });
  $("back-setup").addEventListener("click", () => { closePeer(); show("setup"); });
  $("refresh").addEventListener("click", refreshRooms);
  $("create-room").addEventListener("click", createRoom);
  $("leave-room").addEventListener("click", leaveRoom);
  $("ready").addEventListener("click", () => {
    const room = state.room;
    room.ready = !room.ready;
    room.ctl.send({ t: "ready", ready: room.ready });
    renderRoom();
  });
  $("start").addEventListener("click", hostStart);
  $("leave-game").addEventListener("click", leaveGame);
  $("sound").addEventListener("click", () => {
    state.muted = !state.muted;
    $("sound").textContent = state.muted ? "Sound off" : "Sound on";
    if (state.emu && state.emu.setVolume) state.emu.setVolume(state.muted ? 0 : 1);
  });
  for (const id of ["open-controls-1", "open-controls-2"]) $(id).addEventListener("click", () => { listening = null; renderKeys(); $("controls").showModal(); });
  $("keys-close").addEventListener("click", () => { listening = null; $("controls").close(); });
  $("keys-default").addEventListener("click", () => { keys = { ...DEFAULT_KEYS }; listening = null; store("zlplus.keys", JSON.stringify(keys)); renderKeys(); });
  window.addEventListener("keydown", (e) => onKey(e, true));
  window.addEventListener("keyup", (e) => onKey(e, false));
  window.addEventListener("pagehide", closePeer);
  window.zlplus = state;       // for the tests and for looking around in the console
}

main().catch((e) => { document.querySelector("main").prepend("This page could not start: " + (e.message || e)); });
