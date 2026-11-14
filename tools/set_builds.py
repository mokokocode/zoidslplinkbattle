#!/usr/bin/env python3
"""Point the site at new Zoids Legacy Plus files.

    python3 tools/set_builds.py V2.8 clean.gba plus-english.gba plus-spanish.gba

Writes site/roms.json (the fingerprints the page accepts) and the two IPS patches the page applies to a clean ROM.
Run it every time the Plus files change, then commit and push. No ROM is written into the repo.
"""
import hashlib, json, os, sys

def ips(src, dst):
    out = bytearray(b"PATCH"); i, n = 0, len(dst)
    while i < n:
        if i < len(src) and src[i] == dst[i]:
            i += 1; continue
        j = i
        while j < n and j - i < 0xFFFF and (j >= len(src) or src[j] != dst[j] or dst[j:j + 6] != src[j:j + 6]):
            j += 1
        if i == 0x454F46:                      # an offset that reads "EOF": start one byte earlier
            i -= 1
        out += i.to_bytes(3, "big") + (j - i).to_bytes(2, "big") + dst[i:j]
        i = j
    return bytes(out + b"EOF")

def apply(src, patch):
    out = bytearray(src); i = 5
    while patch[i:i + 3] != b"EOF" or i + 3 != len(patch):
        off = int.from_bytes(patch[i:i + 3], "big"); size = int.from_bytes(patch[i + 3:i + 5], "big"); i += 5
        if len(out) < off + size: out += bytes(off + size - len(out))
        out[off:off + size] = patch[i:i + size]; i += size
    return bytes(out)

def main():
    if len(sys.argv) != 5: sys.exit(__doc__)
    version, clean, en, es = sys.argv[1], *[open(p, "rb").read() for p in sys.argv[2:]]
    site = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")
    sha = lambda b: hashlib.sha1(b).hexdigest()
    tag = version.lower()
    builds = {}
    for f in os.listdir(os.path.join(site, "patches")):
        if f.endswith(".ips"): os.remove(os.path.join(site, "patches", f))
    for key, label, rom in (("en", "English", en), ("es", "Español", es)):
        if max(len(rom), len(clean)) > 1 << 24: sys.exit("ROM too large for an IPS patch")
        patch = ips(clean, rom)
        assert apply(clean, patch) == rom, "patch check failed"
        name = "patches/%s-%s.ips" % (tag, key)
        open(os.path.join(site, name), "wb").write(patch)
        builds[key] = {"label": label, "sha1": sha(rom), "size": len(rom), "patch": name}
    data = {"version": version, "gameCode": clean[0xAC:0xB0].decode("ascii"), "clean": {"sha1": sha(clean), "size": len(clean)}, "builds": builds}
    json.dump(data, open(os.path.join(site, "roms.json"), "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print("site/roms.json and site/patches updated for", version)

if __name__ == "__main__":
    main()
