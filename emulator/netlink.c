/* Network link cable for GBA multiplayer (SIO "multi") mode. See netlink.h.
 *
 * How it keeps time without making player 1 wait for the network on every word:
 * the game (Zoids Legacy) sends a 16-bit word about every 1.3 ms, in packets of 11 words whose first word from
 * player 1 is FEFE. Player 1's emulator never waits for the answer to the word it is sending. For packet N it
 * hands the game player 2's answers to packet N - lag, word for word at the same place in the packet, so the game
 * sees a steady stream that is whole packets late. Until the first answers exist it sees FFFF (no cable).
 * Player 2's emulator takes each incoming word as a finished transfer, a little apart from the previous one, and
 * answers with the word its game had ready.
 * If an answer is not there yet, player 1's emulator stops its game clock until it is (or a time-out says the
 * other side is gone), so lag never corrupts data, it only slows the game.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was
 * not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "netlink.h"

#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/io.h>
#include <mgba/internal/gba/sio.h>

#define POLL_CYCLES 1232   /* one scanline */
#define SLAVE_GAP 6000     /* least cycles between two transfers handed to player 2's game */
#define WAIT_STEP_MS 20
#define WAIT_MAX_MS 2000
#define PACKET_START 0xFEFE

static void _push(struct NetLink* link, int type, uint16_t word) {
	link->out[link->outTail++ & (NETLINK_RING - 1)] = (uint32_t) type << 16 | word;
}

static bool _handlesMode(struct GBASIODriver* driver, enum GBASIOMode mode) {
	UNUSED(driver);
	UNUSED(mode);
	return true;
}

static int _connectedDevices(struct GBASIODriver* driver) {
	UNUSED(driver);
	return 1;
}

static int _deviceId(struct GBASIODriver* driver) {
	return ((struct NetLink*) driver)->role;
}

static uint16_t _writeRegister(struct GBASIODriver* driver, uint16_t value) {
	UNUSED(driver);
	return value;
}

static void _schedule(struct NetLink* link, int32_t when) {
	struct GBA* gba = link->core->board;
	mTimingDeschedule(&gba->timing, &link->event);
	mTimingSchedule(&gba->timing, &link->event, when);
}

static void _reset(struct GBASIODriver* driver) {
	struct NetLink* link = (struct NetLink*) driver;
	if (link->attached) {
		_schedule(link, POLL_CYCLES);
	}
}

static bool _start(struct GBASIODriver* driver) {
	struct NetLink* link = (struct NetLink*) driver;
	struct GBASIO* sio = driver->p;
	if (sio->mode != GBA_SIO_MULTI) {
		return true;
	}
	if (link->role != NETLINK_MASTER) {
		return false;
	}
	MutexLock(&link->mutex);
	link->pending = sio->p->memory.io[GBA_REG(SIOMLT_SEND)];
	++link->transfers;
	if (link->pending == PACKET_START || link->packet < 0) {
		if (link->packet >= 0) {
			link->length[link->packet & (NETLINK_PACKETS - 1)] = link->pos + 1;
		}
		++link->packet;
		link->pos = 0;
		link->have[link->packet & (NETLINK_PACKETS - 1)] = 0;
		link->length[link->packet & (NETLINK_PACKETS - 1)] = 0;
	} else if (link->pos < NETLINK_PACKET_MAX - 1) {
		++link->pos;
	}
	link->sentPacket[link->sent & 0xFFFF] = link->packet & (NETLINK_PACKETS - 1);
	link->sentPos[link->sent & 0xFFFF] = link->pos;
	++link->sent;
	_push(link, NETLINK_MSG_XFER, link->pending);

	int from = link->packet - link->lag;
	if (from < 0) {
		link->last = 0xFFFF;
	} else {
		from &= NETLINK_PACKETS - 1;
		if (link->length[from] && link->pos >= link->length[from]) {
			link->last = 0; /* that packet was shorter */
		} else {
			int waited = 0;
			if (link->have[from] <= link->pos && !link->stalled && !link->closing) {
				++link->waits;
			}
			while (link->have[from] <= link->pos && !link->stalled && !link->closing) {
				ConditionWaitTimed(&link->cond, &link->mutex, WAIT_STEP_MS);
				waited += WAIT_STEP_MS;
				if (waited >= WAIT_MAX_MS && link->have[from] <= link->pos) {
					link->stalled = true;
					++link->timeouts;
				}
			}
			link->waitMs += waited;
			link->last = link->have[from] > link->pos ? link->reply[from][link->pos] : 0xFFFF;
		}
	}
	MutexUnlock(&link->mutex);
	return true;
}

static void _finishMultiplayer(struct GBASIODriver* driver, uint16_t data[4]) {
	struct NetLink* link = (struct NetLink*) driver;
	data[0] = link->pending;
	data[1] = link->last;
	data[2] = 0xFFFF;
	data[3] = 0xFFFF;
}

static void _poll(struct mTiming* timing, void* context, uint32_t cyclesLate) {
	struct NetLink* link = context;
	struct GBA* gba = link->core->board;
	struct GBASIO* sio = &gba->sio;
	bool multi = sio->mode == GBA_SIO_MULTI;

	MutexLock(&link->mutex);
	if (multi != link->myMulti) {
		link->myMulti = multi;
		_push(link, NETLINK_MSG_MODE, multi);
	}
	if (multi) {
		bool ready = link->peerMulti;
		sio->siocnt = ready ? GBASIOMultiplayerFillReady(sio->siocnt) : GBASIOMultiplayerClearReady(sio->siocnt);
		sio->rcnt = ready ? GBASIORegisterRCNTFillSd(sio->rcnt) : GBASIORegisterRCNTClearSd(sio->rcnt);
	}
	if (link->role == NETLINK_SLAVE && link->inHead != link->inTail) {
		/* masterCycles time: this build of mGBA does not advance mTimingGlobalTime. Wraps, so compare unsigned. */
		uint32_t now = (uint32_t) mTimingCurrentTime(timing);
		if (now - link->lastTransfer >= SLAVE_GAP) {
			uint16_t word = link->in[link->inHead++ & (NETLINK_RING - 1)];
			uint16_t mine = 0xFFFF;
			link->lastTransfer = now;
			++link->transfers;
			if (multi) {
				mine = gba->memory.io[GBA_REG(SIOMLT_SEND)];
				uint16_t data[4] = { word, mine, 0xFFFF, 0xFFFF };
				GBASIOMultiplayerFinishTransfer(sio, data, 0);
			}
			_push(link, NETLINK_MSG_REPLY, mine);
		}
	}
	MutexUnlock(&link->mutex);
	mTimingSchedule(timing, &link->event, POLL_CYCLES - (int32_t) (cyclesLate % POLL_CYCLES));
}

void NetLinkInit(struct NetLink* link, int role, int lag) {
	memset(link, 0, sizeof(*link));
	link->role = role;
	link->lag = lag < 1 ? 1 : lag > NETLINK_PACKETS / 4 ? NETLINK_PACKETS / 4 : lag;
	link->packet = -1;
	link->last = 0xFFFF;
	MutexInit(&link->mutex);
	ConditionInit(&link->cond);
	link->d.handlesMode = _handlesMode;
	link->d.connectedDevices = _connectedDevices;
	link->d.deviceId = _deviceId;
	link->d.writeSIOCNT = _writeRegister;
	link->d.writeRCNT = _writeRegister;
	link->d.reset = _reset;
	link->d.start = _start;
	link->d.finishMultiplayer = _finishMultiplayer;
	link->event.name = "Network link";
	link->event.callback = _poll;
	link->event.context = link;
	link->event.priority = 0x80;
}

void NetLinkDeinit(struct NetLink* link) {
	MutexDeinit(&link->mutex);
	ConditionDeinit(&link->cond);
}

void NetLinkAttach(struct NetLink* link, struct mCore* core) {
	link->core = core;
	link->attached = true;
	link->closing = false;
	core->setPeripheral(core, mPERIPH_GBA_LINK_PORT, &link->d);
	_schedule(link, POLL_CYCLES);
}

void NetLinkDetach(struct NetLink* link) {
	if (!link->attached) {
		return;
	}
	struct GBA* gba = link->core->board;
	mTimingDeschedule(&gba->timing, &link->event);
	link->core->setPeripheral(link->core, mPERIPH_GBA_LINK_PORT, NULL);
	link->attached = false;
}

void NetLinkClose(struct NetLink* link) {
	MutexLock(&link->mutex);
	link->closing = true;
	ConditionWake(&link->cond);
	MutexUnlock(&link->mutex);
}

void NetLinkReceive(struct NetLink* link, const uint8_t* data, size_t size) {
	size_t i;
	MutexLock(&link->mutex);
	for (i = 0; i + 3 <= size; i += 3) {
		uint16_t word = data[i + 1] | data[i + 2] << 8;
		switch (data[i]) {
		case NETLINK_MSG_XFER:
			if (link->role == NETLINK_SLAVE) {
				link->in[link->inTail++ & (NETLINK_RING - 1)] = word;
			}
			break;
		case NETLINK_MSG_REPLY:
			if (link->role == NETLINK_MASTER && link->received != link->sent) {
				unsigned packet = link->sentPacket[link->received & 0xFFFF];
				unsigned pos = link->sentPos[link->received & 0xFFFF];
				++link->received;
				link->reply[packet][pos] = word;
				link->have[packet] = pos + 1;
				link->stalled = false;
			}
			break;
		case NETLINK_MSG_MODE:
			link->peerMulti = word != 0;
			break;
		}
	}
	ConditionWake(&link->cond);
	MutexUnlock(&link->mutex);
}

int32_t NetLinkNext(struct NetLink* link) {
	int32_t message = -1;
	MutexLock(&link->mutex);
	if (link->outHead != link->outTail) {
		message = (int32_t) link->out[link->outHead++ & (NETLINK_RING - 1)];
	}
	MutexUnlock(&link->mutex);
	return message;
}
