import { describe, expect, it } from 'vitest';

import { computeGroupHulls, groupAt, isGroup } from '../groups';
import { GROUP_EXIT_MARGIN_PX, GROUP_MIN_RADIUS_PX } from '../constants';
import { makeNode } from './fixtures';

const ZOOM = 1;

describe('group hulls', () => {
  it('encloses every member', () => {
    const members = [
      makeNode('n1', { x: 100, y: 0, groupId: 'g1' }),
      makeNode('n2', { x: 0, y: 140, groupId: 'g1' }),
    ];
    const nodes = [makeNode('g1', { label: 'Power', kind: 'group', x: 0, y: 0 }), ...members];
    const [hull] = computeGroupHulls(nodes, null, ZOOM);

    expect(hull).toBeDefined();
    expect(hull!.memberCount).toBe(2);
    expect(hull!.points?.length).toBeGreaterThanOrEqual(3);
    // The invariant, stated as itself rather than as a number read off one
    // particular centring: every member falls inside the ring.
    for (const member of members) {
      const reach = Math.hypot(member.x - hull!.x, member.y - hull!.y);
      expect(reach).toBeLessThan(hull!.radius);
    }
  });

  it('gives an empty group an area to drop the first node into', () => {
    const nodes = [makeNode('g1', { label: 'Power', kind: 'group', x: 0, y: 0 })];
    const [hull] = computeGroupHulls(nodes, null, ZOOM);
    expect(hull!.radius).toBeGreaterThanOrEqual(GROUP_MIN_RADIUS_PX);
    expect(hull!.memberCount).toBe(0);
  });

  it('centres on its members, not on a group node that has drifted away', () => {
    // The group node is in the force simulation too. Centring the ring on it
    // meant the radius had to reach all the way back to the members, so a
    // drifted group drew a huge circle that swallowed unrelated groups.
    const nodes = [
      makeNode('g1', { label: 'Power', kind: 'group', x: 500, y: 500 }),
      makeNode('n1', { x: 0, y: 0, groupId: 'g1' }),
    ];
    const [hull] = computeGroupHulls(nodes, null, ZOOM);

    expect(hull!.x).toBe(0);
    expect(hull!.y).toBe(0);
    // Tight around the one member rather than reaching 707 back to the node.
    expect(hull!.radius).toBeLessThan(100);
  });

  it('keeps two groups apart when their nodes have drifted', () => {
    // The reported symptom: rings that share no members overlapping heavily.
    const nodes = [
      makeNode('g1', { label: 'Left', kind: 'group', x: 900, y: 0 }),
      makeNode('a1', { x: -300, y: 0, groupId: 'g1' }),
      makeNode('a2', { x: -260, y: 40, groupId: 'g1' }),
      makeNode('g2', { label: 'Right', kind: 'group', x: -900, y: 0 }),
      makeNode('b1', { x: 300, y: 0, groupId: 'g2' }),
      makeNode('b2', { x: 260, y: 40, groupId: 'g2' }),
    ];
    const [left, right] = computeGroupHulls(nodes, null, ZOOM);

    const gap = Math.hypot(left!.x - right!.x, left!.y - right!.y);
    expect(gap).toBeGreaterThan(left!.radius + right!.radius);
  });

  it('falls back to the group node while the group is still empty', () => {
    const nodes = [makeNode('g1', { label: 'Power', kind: 'group', x: 500, y: 500 })];
    const [hull] = computeGroupHulls(nodes, null, ZOOM);
    expect(hull!.x).toBe(500);
    expect(hull!.y).toBe(500);
  });

  it('ignores a member pointing at a group that does not exist', () => {
    const nodes = [
      makeNode('g1', { label: 'Power', kind: 'group', x: 0, y: 0 }),
      makeNode('n1', { x: 900, y: 900, groupId: 'gone' }),
    ];
    const [hull] = computeGroupHulls(nodes, null, ZOOM);
    // The stray member must not stretch an unrelated group's ring across the canvas.
    expect(hull!.radius).toBeLessThan(200);
  });

  it('produces no hull when there are no groups', () => {
    expect(computeGroupHulls([makeNode('n1', {})], null, ZOOM)).toEqual([]);
  });
});

describe('groupAt', () => {
  const hulls = [
    { groupId: 'big', label: 'Big', x: 0, y: 0, radius: 400, memberCount: 3 },
    { groupId: 'small', label: 'Small', x: 0, y: 0, radius: 100, memberCount: 1 },
  ];

  it('finds the group containing a point', () => {
    expect(groupAt(hulls, { x: 350, y: 0 })).toBe('big');
  });

  it('prefers the smallest containing group, so a drop does what it looks like', () => {
    expect(groupAt(hulls, { x: 10, y: 10 })).toBe('small');
  });

  it('returns null outside every circle, which means leave the group', () => {
    expect(groupAt(hulls, { x: 900, y: 900 })).toBeNull();
  });

  describe('leaving a group takes effort', () => {
    const solo = [{ groupId: 'g', label: 'G', x: 0, y: 0, radius: 100, memberCount: 2 }];

    it('keeps a member that has only just crossed the ring', () => {
      // Tidying the layout must not silently dissolve a group the author made.
      const justOutside = { x: 100 + GROUP_EXIT_MARGIN_PX / 2, y: 0 };

      expect(groupAt(solo, justOutside)).toBeNull();
      expect(groupAt(solo, justOutside, 'g')).toBe('g');
    });

    it('lets it go once it is pulled clearly clear', () => {
      const wellOutside = { x: 100 + GROUP_EXIT_MARGIN_PX + 1, y: 0 };
      expect(groupAt(solo, wellOutside, 'g')).toBeNull();
    });

    it('does not make a non-member sticky', () => {
      const justOutside = { x: 100 + GROUP_EXIT_MARGIN_PX / 2, y: 0 };
      expect(groupAt(solo, justOutside, 'other')).toBeNull();
    });

    it('still joins another group the moment the node is inside it', () => {
      // Moving between groups is deliberate; only leaving to nowhere is sticky.
      expect(groupAt(hulls, { x: 10, y: 10 }, 'big')).toBe('small');
    });
  });
});

describe('isGroup', () => {
  it('distinguishes a group from a concept', () => {
    expect(isGroup(makeNode('g', { kind: 'group' }))).toBe(true);
    expect(isGroup(makeNode('c', { kind: 'concept' }))).toBe(false);
  });
});
