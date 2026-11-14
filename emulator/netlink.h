/* Network link cable for GBA multiplayer (SIO "multi") mode.
 *
 * One NetLink sits on one emulated GBA and stands in for the cable. The other end is another NetLink on another
 * machine; the two exchange small messages over any ordered, reliable channel (a WebRTC data channel here).
 * Nothing else is shared: each player runs only their own game.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was
 * not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef NETLINK_H
#define NETLINK_H

#include <mgba-util/common.h>
#include <mgba-util/threading.h>
#include <mgba/core/core.h>
#include <mgba/core/timing.h>
#include <mgba/gba/interface.h>

#define NETLINK_MASTER 0 /* player 1: owns the clock, starts every transfer */
#define NETLINK_SLAVE 1  /* player 2 */

/* messages are 3 bytes: type, word low, word high */
#define NETLINK_MSG_XFER 1  /* master -> slave: the word player 1 sent */
#define NETLINK_MSG_REPLY 2 /* slave -> master: the word player 2 had ready when that transfer reached it */
#define NETLINK_MSG_MODE 3  /* either way: 1 = my game has its link port in multiplayer mode, 0 = not */

#define NETLINK_RING 8192
#define NETLINK_PACKETS 4096
#define NETLINK_PACKET_MAX 32

struct NetLink {
	struct GBASIODriver d;
	struct mTimingEvent event;
	struct mCore* core;
	int role;
	int lag; /* master: how many whole packets behind player 2's replies are used */
	bool attached;
	bool closing;

	Mutex mutex;
	Condition cond;

	uint32_t out[NETLINK_RING]; /* type << 16 | word */
	unsigned outHead, outTail;

	bool myMulti, peerMulti;

	/* slave */
	uint16_t in[NETLINK_RING];
	unsigned inHead, inTail;
	uint32_t lastTransfer;

	/* master */
	uint16_t reply[NETLINK_PACKETS][NETLINK_PACKET_MAX];
	uint8_t have[NETLINK_PACKETS];
	uint8_t length[NETLINK_PACKETS];
	uint16_t sentPacket[65536];
	uint8_t sentPos[65536];
	unsigned sent, received;
	int packet, pos;
	uint16_t pending, last;
	bool stalled; /* the last wait ran out: do not wait again until a reply comes in */

	/* counters */
	uint32_t transfers, waits, timeouts, waitMs;
};

void NetLinkInit(struct NetLink*, int role, int lag);
void NetLinkDeinit(struct NetLink*);
/* call with the core not running (before its thread starts, or with the thread interrupted) */
void NetLinkAttach(struct NetLink*, struct mCore* core);
void NetLinkDetach(struct NetLink*);
/* lets a blocked game thread go (call before interrupting or ending the thread) */
void NetLinkClose(struct NetLink*);

/* from the network: whole messages only */
void NetLinkReceive(struct NetLink*, const uint8_t* data, size_t size);
/* to the network: next message as type << 16 | word, or -1 if there is none */
int32_t NetLinkNext(struct NetLink*);

#endif
