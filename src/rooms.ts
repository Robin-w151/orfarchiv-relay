export type JoinResult<S> = { readonly type: 'joined'; readonly replaced: S | undefined } | { readonly type: 'full' };

export class Rooms<S> {
  private readonly rooms = new Map<string, Map<string, S>>();

  constructor(private readonly maxPeersPerRoom: number) {}

  get size(): number {
    return this.rooms.size;
  }

  join(roomId: string, peerId: string, socket: S): JoinResult<S> {
    const room = this.rooms.get(roomId) ?? new Map<string, S>();
    const replaced = room.get(peerId);
    if (replaced === undefined && room.size >= this.maxPeersPerRoom) {
      return { type: 'full' };
    }

    room.set(peerId, socket);
    this.rooms.set(roomId, room);
    return { type: 'joined', replaced };
  }

  leave(roomId: string, peerId: string, socket: S): boolean {
    const room = this.rooms.get(roomId);
    if (room?.get(peerId) !== socket) {
      return false;
    }

    room.delete(peerId);
    if (room.size === 0) {
      this.rooms.delete(roomId);
    }
    return true;
  }

  route(roomId: string, to: string): S | undefined {
    return this.rooms.get(roomId)?.get(to);
  }

  members(roomId: string): ReadonlyArray<readonly [string, S]> {
    return [...(this.rooms.get(roomId) ?? [])];
  }
}
