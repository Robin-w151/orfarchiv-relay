import { describe, expect, it } from 'vitest';
import { Rooms } from './rooms';

type Entry = readonly [room: string, peerId: string, socket: string];

describe('Rooms', () => {
  function roomsWith(maxPeers: number, peers: ReadonlyArray<Entry>) {
    const rooms = new Rooms<string>(maxPeers);
    for (const [room, peerId, socket] of peers) {
      rooms.join(room, peerId, socket);
    }
    return rooms;
  }

  it.each([
    { name: 'a new room', peers: [], join: ['r', 'a', 'A'], expected: { type: 'joined', replaced: undefined } },
    {
      name: 'an existing room',
      peers: [['r', 'a', 'A']],
      join: ['r', 'b', 'B'],
      expected: { type: 'joined', replaced: undefined },
    },
    {
      name: 'a known peer ID',
      peers: [['r', 'a', 'A']],
      join: ['r', 'a', 'A2'],
      expected: { type: 'joined', replaced: 'A' },
    },
    {
      name: 'a full room',
      peers: [
        ['r', 'a', 'A'],
        ['r', 'b', 'B'],
      ],
      join: ['r', 'c', 'C'],
      expected: { type: 'full' },
    },
    {
      name: 'a known peer ID in a full room',
      peers: [
        ['r', 'a', 'A'],
        ['r', 'b', 'B'],
      ],
      join: ['r', 'b', 'B2'],
      expected: { type: 'joined', replaced: 'B' },
    },
    {
      name: 'another room while one is full',
      peers: [
        ['r', 'a', 'A'],
        ['r', 'b', 'B'],
      ],
      join: ['s', 'c', 'C'],
      expected: { type: 'joined', replaced: undefined },
    },
  ] as const)('joins $name', ({ peers, join: [room, peerId, socket], expected }) => {
    const rooms = roomsWith(2, peers);
    expect(rooms.join(room, peerId, socket)).toEqual(expected);
  });

  it.each([
    { name: 'the last peer', leave: ['r', 'a', 'A'], removed: true, members: [], size: 1 },
    { name: 'an unknown peer', leave: ['r', 'x', 'X'], removed: false, members: [['a', 'A']], size: 2 },
    { name: 'an unknown room', leave: ['t', 'a', 'A'], removed: false, members: [['a', 'A']], size: 2 },
    { name: 'a replaced socket', leave: ['r', 'a', 'A0'], removed: false, members: [['a', 'A']], size: 2 },
  ] as const)('leaves $name', ({ leave: [room, peerId, socket], removed, members, size }) => {
    const rooms = roomsWith(2, [
      ['r', 'a', 'A'],
      ['s', 'b', 'B'],
    ]);
    expect(rooms.leave(room, peerId, socket)).toBe(removed);
    expect(rooms.members('r')).toEqual(members);
    expect(rooms.size).toBe(size);
  });

  it('keeps a room while peers remain and deletes it when empty', () => {
    const rooms = roomsWith(2, [
      ['r', 'a', 'A'],
      ['r', 'b', 'B'],
    ]);
    rooms.leave('r', 'a', 'A');
    expect(rooms.members('r')).toEqual([['b', 'B']]);
    expect(rooms.size).toBe(1);
    rooms.leave('r', 'b', 'B');
    expect(rooms.members('r')).toEqual([]);
    expect(rooms.size).toBe(0);
  });

  it.each([
    { name: 'a peer in the room', room: 'r', to: 'b', expected: 'B' },
    { name: 'the sender itself', room: 'r', to: 'a', expected: 'A' },
    { name: 'a peer in another room', room: 'r', to: 'c', expected: undefined },
    { name: 'an unknown peer', room: 'r', to: 'x', expected: undefined },
    { name: 'an unknown room', room: 't', to: 'a', expected: undefined },
  ])('routes to $name', ({ room, to, expected }) => {
    const rooms = roomsWith(16, [
      ['r', 'a', 'A'],
      ['r', 'b', 'B'],
      ['s', 'c', 'C'],
    ]);
    expect(rooms.route(room, to)).toBe(expected);
  });
});
