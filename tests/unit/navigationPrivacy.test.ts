import { describe, expect, it } from 'vitest';
import { ownNavigationLinks, spotOnlyNavigationLinks } from '../../src/coordination/navigation';

const OWN = { lat: 12.9716, lng: 77.6412 };
const OTHER = { lat: 12.9352, lng: 77.6245 };
const SPOT = { lat: 12.95, lng: 77.63 };

describe('ownNavigationLinks', () => {
  it('returns OSM directions from the own location on the own row', () => {
    const links = ownNavigationLinks(OWN, SPOT, true);
    expect(links).not.toBeNull();
    expect(links!.osmUrl).toContain('openstreetmap.org/directions');
    expect(links!.osmUrl).toContain('12.9716');
    expect(links!.osmUrl).toContain('77.6412');
    expect(links!.osmUrl).toContain('12.95');
    expect(links!.geoUri).toMatch(/^geo:12\.95,77\.63/);
  });
  it('returns null for other participants rows', () => {
    expect(ownNavigationLinks(OTHER, SPOT, false)).toBeNull();
  });
  it('returns null when the own location is unknown', () => {
    expect(ownNavigationLinks(null, SPOT, true)).toBeNull();
  });
  it('never embeds another participant origin in the own links', () => {
    const links = ownNavigationLinks(OWN, SPOT, true)!;
    expect(links.osmUrl).not.toContain('12.9352');
    expect(links.osmUrl).not.toContain('77.6245');
    expect(links.geoUri).not.toContain('12.9716');
  });
  it('contains no Google URL', () => {
    const links = ownNavigationLinks(OWN, SPOT, true)!;
    expect(links.osmUrl).not.toMatch(/google/i);
    expect(links.geoUri).not.toMatch(/google/i);
  });
});

describe('spotOnlyNavigationLinks', () => {
  it('contains only the spot coordinates, no origin', () => {
    const links = spotOnlyNavigationLinks(SPOT);
    expect(links.osmUrl).toContain('openstreetmap.org/directions');
    expect(links.osmUrl).toContain('12.95');
    expect(links.osmUrl).not.toContain('12.9716');
    expect(links.osmUrl).not.toContain('77.6412');
    expect(links.geoUri).toMatch(/^geo:12\.95,77\.63/);
  });
});
