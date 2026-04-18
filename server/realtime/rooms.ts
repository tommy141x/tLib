// rooms.ts — server-authoritative room membership + fan-out.
//
// A "room" is an opaque string id. Consumer Lua calls setRooms(playerId, [...])
// to declare which rooms a player's session(s) belong to. Frames published to
// a room are delivered to every other authed session whose membership includes
// that room.

import type { Session, SessionId } from "./sessions";

export interface RoomManagerOptions {
	maxRoomsPerSession: number;
	onMembershipChanged?: (session: Session, added: string[], removed: string[]) => void;
}

export class RoomManager {
	// roomId -> Set<sessionId>
	private rooms = new Map<string, Set<SessionId>>();

	constructor(private readonly opts: RoomManagerOptions) {}

	/** Replace a session's room membership. Emits a diff via onMembershipChanged. */
	setRooms(session: Session, nextIds: Iterable<string>): void {
		const next = new Set<string>();
		for (const id of nextIds) {
			if (typeof id !== "string" || id.length === 0) continue;
			next.add(id);
			if (next.size > this.opts.maxRoomsPerSession) {
				// stop silently — caller gets a capped view instead of an error storm
				break;
			}
		}

		const prev = session.rooms;
		const added: string[] = [];
		const removed: string[] = [];

		for (const id of next) {
			if (!prev.has(id)) added.push(id);
		}
		for (const id of prev) {
			if (!next.has(id)) removed.push(id);
		}

		if (added.length === 0 && removed.length === 0) return;

		for (const id of removed) {
			const m = this.rooms.get(id);
			if (m) {
				m.delete(session.id);
				if (m.size === 0) this.rooms.delete(id);
			}
		}
		for (const id of added) {
			let m = this.rooms.get(id);
			if (!m) {
				m = new Set();
				this.rooms.set(id, m);
			}
			m.add(session.id);
		}

		session.rooms = next;
		this.opts.onMembershipChanged?.(session, added, removed);
	}

	/** Remove a session from all rooms (on disconnect). */
	drop(session: Session): void {
		for (const id of session.rooms) {
			const m = this.rooms.get(id);
			if (m) {
				m.delete(session.id);
				if (m.size === 0) this.rooms.delete(id);
			}
		}
		session.rooms = new Set();
	}

	/** Session ids subscribed to a room. */
	members(roomId: string): Set<SessionId> | undefined {
		return this.rooms.get(roomId);
	}

	/**
	 * Visit each member session of a room except optional excludedId.
	 * The caller resolves sessionIds via SessionManager.get — we keep this class
	 * free of that dependency so fan-out logic stays simple to test.
	 */
	forEachMember(roomId: string, excludeId: SessionId | null, cb: (sessionId: SessionId) => void): void {
		const m = this.rooms.get(roomId);
		if (!m) return;
		for (const id of m) {
			if (id === excludeId) continue;
			cb(id);
		}
	}

	stats(): { rooms: number; totalMemberships: number } {
		let total = 0;
		for (const m of this.rooms.values()) total += m.size;
		return { rooms: this.rooms.size, totalMemberships: total };
	}
}
