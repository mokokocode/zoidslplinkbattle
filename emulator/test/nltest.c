// Native test of netlink.c: two GBA cores, each in its own thread at the same paced speed, joined only by a
// "network" thread that carries their messages with a delay and jitter. Same command file format as before.
#define _GNU_SOURCE
#include "netlink.h"
#include <mgba/core/config.h>
#include <mgba/core/log.h>
#include <mgba/internal/gba/gba.h>
#include <mgba-util/vfs.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
struct mCore* mCoreFind(const char* path);
bool mCoreLoadFile(struct mCore* core, const char* path);
static struct mCore* cores[2]; static struct NetLink links[2]; static uint32_t vbuf[2][256 * 256];
static volatile int quit; static volatile long frames[2];
static double SPEED = 4.0; static double DELAY_MS, JITTER_MS;      // game-time milliseconds, one way
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
static void nolog(struct mLogger* l, int cat, enum mLogLevel lv, const char* fmt, va_list ap) {}
static struct mLogger lg = { .log = nolog, .filter = NULL };
static void* run_core(void* arg) {
	int p = (int) (intptr_t) arg; double t0 = now_ms(); double frame = 1000.0 / 59.7275 / SPEED;
	while (!quit) {
		cores[p]->runFrame(cores[p]); frames[p]++;
		double due = t0 + frames[p] * frame, n = now_ms();
		if (due > n) usleep((useconds_t) ((due - n) * 1000)); else if (n - due > 200) t0 += n - due;   // do not sprint to catch up
	}
	return NULL;
}
typedef struct { double at; uint8_t m[3]; } Pkt;
static void* run_net(void* arg) {
	static Pkt q[2][65536]; unsigned h[2] = { 0, 0 }, t[2] = { 0, 0 }; double last[2] = { 0, 0 };
	while (!quit) {
		double n = now_ms();
		for (int p = 0; p < 2; p++) {
			int32_t m;
			while ((m = NetLinkNext(&links[p])) >= 0) {
				double at = n + (DELAY_MS + (JITTER_MS > 0 ? (rand() % 1000) / 1000.0 * JITTER_MS : 0)) / SPEED;
				if (at < last[p]) at = last[p];               // ordered channel
				last[p] = at;
				Pkt* k = &q[p][t[p]++ & 65535]; k->at = at; k->m[0] = m >> 16; k->m[1] = m & 0xFF; k->m[2] = (m >> 8) & 0xFF;
			}
			while (h[p] != t[p] && q[p][h[p] & 65535].at <= n) { NetLinkReceive(&links[!p], q[p][h[p] & 65535].m, 3); h[p]++; }
		}
		usleep(4000 / SPEED > 300 ? (useconds_t) (4000 / SPEED) : 300);    // like a 4 ms browser timer
	}
	return NULL;
}
static int keymask(const char* s) { int m = 0; for (; *s; s++) { switch (*s) { case 'A': m |= 1; break; case 'B': m |= 2; break; case 's': m |= 4; break; case 'S': m |= 8; break; case 'R': m |= 16; break; case 'L': m |= 32; break; case 'U': m |= 64; break; case 'D': m |= 128; break; } } return m; }
static void shot(int p, const char* path) { FILE* f = fopen(path, "wb"); fprintf(f, "P6 240 160 255\n"); for (int y = 0; y < 160; y++) for (int x = 0; x < 240; x++) { uint32_t c = vbuf[p][y * 256 + x]; unsigned char rgb[3] = { c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff }; fwrite(rgb, 1, 3, f); } fclose(f); }
int main(int argc, char** argv) {
	mLogSetDefaultLogger(&lg);
	const char* rom = argv[1]; const char* sav[2] = { argv[2], argv[3] };
	DELAY_MS = atof(argv[5]); JITTER_MS = atof(argv[6]);
	int lag = argc > 7 && atoi(argv[7]) ? atoi(argv[7]) : (int) ((2 * DELAY_MS + 2 * JITTER_MS + 10) / 14.25) + 2;
	if (argc > 8) SPEED = atof(argv[8]);
	for (int p = 0; p < 2; p++) {
		struct mCore* c = cores[p] = mCoreFind(rom); c->init(c); c->setVideoBuffer(c, vbuf[p], 256); mCoreLoadFile(c, rom);
		char nm[8]; sprintf(nm, "nt%d", p); mCoreConfigInit(&c->config, nm); mCoreLoadConfig(c);
		struct VFile* sv = VFileOpen(sav[p], O_RDWR | O_CREAT); c->loadSave(c, sv); c->reset(c);
		NetLinkInit(&links[p], p, lag); NetLinkAttach(&links[p], c);
	}
	pthread_t th[3];
	for (int p = 0; p < 2; p++) pthread_create(&th[p], NULL, run_core, (void*) (intptr_t) p);
	pthread_create(&th[2], NULL, run_net, NULL);
	FILE* in = fopen(argv[4], "r"); char line[512];
	while (fgets(line, sizeof line, in)) {
		char cmd[32] = "", a[256] = "", b[256] = ""; sscanf(line, "%31s %255s %255s", cmd, a, b);
		if (!strcmp(cmd, "run")) { long until = frames[0] + atoi(a); double t0 = now_ms(); while (frames[0] < until && now_ms() - t0 < atoi(a) * 1000.0 / 59.7 / SPEED * 20 + 20000) usleep(500); }
		else if (!strcmp(cmd, "keys")) { int p = atoi(a); cores[p]->setKeys(cores[p], keymask(b)); }
		else if (!strcmp(cmd, "shot")) shot(atoi(a), b);
		else if (!strcmp(cmd, "stats")) printf("%s lag=%d frames=%ld,%ld transfers=%u,%u waits=%u (%u ms) timeouts=%u multi=%d,%d\n", a, lag, frames[0], frames[1], links[0].transfers, links[1].transfers, links[0].waits, links[0].waitMs, links[0].timeouts, links[0].myMulti, links[1].myMulti);
		fflush(stdout);
	}
	quit = 1; NetLinkClose(&links[0]); NetLinkClose(&links[1]);
	for (int i = 0; i < 3; i++) pthread_join(th[i], NULL);
	return 0;
}
