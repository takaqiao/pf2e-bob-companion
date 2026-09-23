import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveScope, isManagedSkyRule, shouldManageWeather, endStorm} from '../scripts/context.mjs';

const scenes = [{id: 'island', scope: 'auto', exposure: 'outdoors'}, {id: 'other', scope: 'auto'}, {id: 'custom', scope: 'include', exposure: 'indoors'}];
const base = {scenes, mainSceneId: 'island', activeSceneId: 'island'};
const linked = (id, extras = {}) => ({id, sceneId: 'island', actorLink: true, disposition: -1, ...extras});

test('no-token actor remains outside scope until explicitly bound', () => {
  assert.equal(resolveScope(base).enabled, false);
  assert.equal(resolveScope({...base, actorFlags: {sceneId: 'custom'}}).enabled, true);
});
test('linked actors use only linked tokens in the active scene', () => {
  assert.equal(resolveScope({...base, tokens: [linked('one')]}).enabled, true);
  assert.equal(resolveScope({...base, activeSceneId: 'other', tokens: [linked('one')]}).enabled, false);
  assert.equal(resolveScope({...base, tokens: [linked('one', {actorLink: false})]}).enabled, false);
});
test('synthetic actors use their own token scene even when the GM views another scene', () => {
  const result = resolveScope({...base, isToken: true, tokenId: 'one', activeSceneId: 'other', tokens: [linked('one', {actorLink: false})]});
  assert.equal(result.enabled, true);
  assert.equal(result.sceneId, 'island');
});
test('explicit exclusion defeats automatic island recognition and actor binding', () => {
  const result = resolveScope({...base, scenes: [{id: 'island', scope: 'exclude'}], actorFlags: {sceneId: 'island'}});
  assert.equal(result.enabled, false);
});
test('different linked token dispositions or exposures stop automatic processing', () => {
  assert.equal(resolveScope({...base, tokens: [linked('one'), linked('two', {disposition: 1})]}).enabled, false);
  assert.equal(resolveScope({...base, tokens: [linked('one'), linked('two', {exposure: 'indoors'})]}).enabled, false);
});
test('token exposure wins over region, actor and scene settings', () => {
  const result = resolveScope({...base, actorFlags: {exposure: 'indoors'}, tokens: [linked('one', {exposure: 'rain-shelter', regions: [{exposure: 'wind-shelter'}]})]});
  assert.equal(result.exposure, 'rain-shelter');
});
test('conflicting region exposure remains unknown without swallowing manual weather', () => {
  const result = resolveScope({...base, tokens: [linked('one', {regions: [{exposure: 'outdoors'}, {exposure: 'indoors'}]})]});
  assert.equal(result.enabled, true);
  assert.equal(result.exposure, 'unknown');
  assert.ok(result.warnings.length);
});
test('unknown scene exposure allows night rules but does not claim weather coverage', () => {
  const result = resolveScope({...base, scenes: [{id: 'island'}], tokens: [linked('one')]});
  assert.equal(result.enabled, true);
  assert.equal(result.exposure, 'unknown');
});
test('explicit token unknown blocks outdoor inheritance until the GM confirms exposure', () => {
  const result = resolveScope({...base, actorFlags: {exposure: 'indoors'}, tokens: [linked('one', {exposure: 'unknown'})]});
  assert.equal(result.exposure, 'unknown');
});
test('explicit region unknown blocks actor and scene exposure defaults', () => {
  const result = resolveScope({...base, actorFlags: {exposure: 'indoors'}, tokens: [linked('one', {regions: [{exposure: 'unknown'}]})]});
  assert.equal(result.exposure, 'unknown');
});
test('all matching linked tokens are retained for hostile classification and explicit role overrides', () => {
  const result = resolveScope({...base, actorFlags: {role: 'enemy', perception: 'nonvisual'}, tokens: [linked('one'), linked('two')]});
  assert.equal(result.roleOverride, 'enemy');
  assert.equal(result.perception, 'nonvisual');
  assert.deepEqual(result.dispositions, [-1, -1]);
});
test('ending the storm clears recognized weather rules even if exposure is unknown', () => {
  assert.equal(shouldManageWeather({enabled: true, weather: true, exposure: 'unknown', stormEnded: true}), true);
  assert.equal(shouldManageWeather({enabled: false, weather: true, exposure: 'outdoors', stormEnded: true}), false);
  assert.equal(shouldManageWeather({enabled: true, weather: false, exposure: 'outdoors', stormEnded: true}), false);
  assert.equal(shouldManageWeather({enabled: true, weather: true, exposure: 'unknown', stormEnded: false}), false);
});
test('weather takeover preserves unrelated custom rules appended to a recognized official effect', () => {
  assert.equal(isManagedSkyRule({key: 'FlatModifier', selector: ['perception']}), true);
  assert.equal(isManagedSkyRule({key: 'FlatModifier', selector: 'ranged-strike-attack-roll'}), true);
  assert.equal(isManagedSkyRule({key: 'FlatModifier', selector: ['saving-throw']}), false);
  assert.equal(isManagedSkyRule({key: 'FlatModifier', selector: ['perception', 'saving-throw']}), false);
  assert.equal(isManagedSkyRule({key: 'Note', selector: 'attack-roll', predicate: [{gte: ['target:distance', 50]}]}), true);
  assert.equal(isManagedSkyRule({key: 'Note', selector: ['attack-roll'], title: 'Custom reminder', predicate: []}), false);
  assert.equal(isManagedSkyRule({key: 'ItemAlteration', selector: 'perception'}), false);
});
test('native PF2e Note selector Set is recognized after rule preparation', () => {
  assert.equal(isManagedSkyRule({key: 'Note', selector: new Set(['attack-roll']), predicate: [{gte: ['target:distance', 50]}]}), true);
});
test('explicit automatic token identity and perception override actor manual choices', () => {
  const result = resolveScope({...base, actorFlags: {role: 'enemy', perception: 'visual'},
    tokens: [linked('one', {role: 'auto', perception: 'auto'})]});
  assert.equal(result.roleOverride, 'auto');
  assert.equal(result.perception, 'auto');
});
test('ended storm removes recurring dangers but preserves the single final sunrise and unresolved aftermath', () => {
  const result = endStorm({valid: true, chapter: 9, night: true, perception: -4, ranged: -4, fog: true, raining: true,
    cold: 'severe', notes: ['每10分钟雷击', '风会熄灭火把', '本章最后一次14:00日出即日落，没有持续白昼。']});
  assert.equal(result.night, true);
  assert.equal(result.cold, 'severe');
  assert.equal(result.perception, 0);
  assert.equal(result.ranged, 0);
  assert.equal(result.fog, false);
  assert.equal(result.raining, false);
  assert.equal(result.notes.length, 2);
  assert.equal(result.notes[0], 'BOB.Environment.StormEndedNote');
  assert.equal(result.notes[1], 'BOB.Environment.FinalSun');
});
