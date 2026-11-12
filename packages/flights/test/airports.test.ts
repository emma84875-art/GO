import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { searchAirports, findAirport } from '../src/airports.ts';

describe('airport autocomplete (development fixture)', () => {
  test('exact code ranks first', () => {
    assert.equal(searchAirports('LOS')[0].iata, 'LOS');
  });

  test('matches by city prefix, case-insensitively', () => {
    assert.equal(searchAirports('lag')[0].iata, 'LOS');
    assert.equal(searchAirports('LONDON')[0].iata, 'LHR');
  });

  test('empty or blank query returns nothing', () => {
    assert.deepEqual(searchAirports(''), []);
    assert.deepEqual(searchAirports('   '), []);
  });

  test('respects the limit', () => {
    assert.ok(searchAirports('a', 2).length <= 2);
  });

  test('every entry is tagged as a development fixture with a valid zone', () => {
    for (const code of ['LOS', 'ABV', 'PHC', 'KAN', 'ACC', 'LHR', 'DXB', 'JFK', 'CDG', 'IST']) {
      const airport = findAirport(code);
      assert.ok(airport, code);
      assert.equal(airport.source, 'development-fixture');
      assert.match(airport.iata, /^[A-Z]{3}$/);
      assert.ok(airport.timeZone.includes('/'));
    }
  });
});
