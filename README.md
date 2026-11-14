# Zoids Legacy Plus Link Battle

A web page where two players fight a link battle, each with their own Zoids Legacy Plus save.

Each player runs their own game in their own browser. The two emulators are joined by a network version of the
link cable, so only link cable data travels between the players. ROMs and saves never leave the browser.

## Status

Tested:

- The network link itself (`emulator/netlink.c`), on desktop mGBA with two emulators joined only by delayed
  messages: link battles start at 0, 30 and 100 ms of one-way delay, and several turns were played at 30 ms.
  No battle has been played to its end.
- The page, in a headless browser with a stock emulator build: file checks, patching a clean ROM, rooms, join,
  Ready, Start, both games opening the Multiplayer screen, keyboard, key remapping, on-screen buttons, leaving.

Not tested yet:

- The network link inside the browser. The emulator with the link added is built by GitHub (below) and has not
  been run. Expect to fix things on the first build.
- The public room service, real networks, phones.

## Put it online

1. Create a GitHub repository and push this folder to its `main` branch.
2. In the repository: Settings > Pages > Build and deployment > Source: **GitHub Actions**.
3. The "Build and deploy" workflow runs on every push. It builds the emulator and publishes `site/`.
   The first build takes several minutes. The address is shown on the workflow run and in Settings > Pages.

## When the Plus files change

Both players must run exactly the same Plus build, so the page only accepts the files listed in `site/roms.json`.
After every new Plus release:

    python3 tools/set_builds.py V2.8 clean.gba plus-english.gba plus-spanish.gba

Then commit and push. This rewrites `site/roms.json` and the two patches in `site/patches/`.

## How it works

- `site/` is the page. `app.js` holds all of its logic.
- Rooms use the free public PeerJS service. A host takes one of 12 fixed room names, and the room list is made
  by asking each of the 12. There is no server of your own. To use your own PeerServer, add
  `?peerhost=HOST&peerport=PORT&peersecure=1` to the address.
- The battle data goes directly between the two browsers (WebRTC). Some networks block that.
- `emulator/netlink.c` is the link cable. `emulator/mgba-wasm.patch` adds it to
  [thenick775/mgba](https://github.com/thenick775/mgba) (branch `feature/wasm`), pinned to one commit in the workflow.
- Player 1 (the host) runs a few link packets behind player 2's replies. The number comes from the measured
  round trip when the host presses Start. More delay makes the game's own link steps slower, not wrong.
- The save is loaded as a copy. Nothing is written back to the player's file.

## Build the emulator yourself

With Docker, from a checkout of the pinned commit with `netlink.c`, `netlink.h` and the patch applied:

    docker build -t zl-mgba-wasm src/platform/wasm/docker
    docker run --rm -v "$PWD:/home/mgba/src" zl-mgba-wasm

Copy `mgba.js` and `mgba.wasm` from `build-wasm` into `site/emu/`. The page must be served with the
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers, or through
the included service worker (which is what GitHub Pages uses).

`emulator/test/nltest.c` is the desktop test: two emulators in two threads and a simulated network between them.

## Licences

- mGBA and the files in `emulator/` are under the Mozilla Public License 2.0.
- `site/vendor/peerjs.min.js` (PeerJS) and `site/coi-serviceworker.js` are MIT licensed. Their licences are in `site/vendor/`.
- No ROM is included. The patches contain only the differences from a clean ROM.
