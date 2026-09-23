/** Pure nightmare ledger. Native documents are changed only by nightmares.mjs. */
import {t} from './i18n.mjs';
export const NIGHTMARE_DAY = 86400;
export const NIGHTMARE_CHAPTERS = Object.freeze({
  1: {dc: 20, effect: 'WENXlprEY6ORnkWb', get name() {return t('Nightmare.Phobia1Name');}, slug: 'thalassophobia'},
  2: {dc: 22, effect: 'htPpGj2N2431bfJf', get name() {return t('Nightmare.Phobia2Name');}, slug: 'pyrophobia'},
  3: {dc: 23, effect: 'skaR0p8AEpv7FvBs', get name() {return t('Nightmare.Phobia3Name');}, slug: 'enochlophobia'},
  4: {dc: 24, effect: 'TZrFb7uKRubH0yQx', get name() {return t('Nightmare.Phobia4Name');}, slug: 'nyctophobia'},
  5: {dc: 26, effect: 'sYZI41JKGiMH8aO0', get name() {return t('Nightmare.Phobia5Name');}, slug: 'hemophobia'},
  6: {dc: 27, effect: '147kd0p9FH3w2zzJ', get name() {return t('Nightmare.Phobia6Name');}, slug: 'proditiophobia'},
  7: {dc: 28, effect: 'dwZa70BULRhlaE6V', get name() {return t('Nightmare.Phobia7Name');}, slug: 'agoraphobia'},
  8: {dc: 30, effect: 'pXJNt2NxwKZHPFPj', get name() {return t('Nightmare.Phobia8Name');}, slug: 'aracnophobia'},
  9: {dc: 31, effect: 'YbupG2YOc3QmxJSZ', get name() {return t('Nightmare.Phobia9Name');}, slug: 'teraphobia'}
});
const outcomes = new Set(['criticalSuccess', 'success', 'failure', 'criticalFailure']);
const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value))];
const chapterData = chapter => {
  if (!NIGHTMARE_CHAPTERS[chapter]) throw new Error(t('Nightmare.InvalidChapter'));
  return NIGHTMARE_CHAPTERS[chapter];
};
const character = (state, id) => ((state.characters ??= {})[id] ??= {chapters: {}});
const session = (state, id) => {
  const value = state.sessions?.[id];
  if (!value) throw new Error(t('Nightmare.RestMissing'));
  return value;
};

export function latestUnlockedChapter(campaign) {
  if (!campaign) return null;
  const direct = Number(campaign.activeArea?.chapter);
  if (NIGHTMARE_CHAPTERS[direct]) return direct;
  const accessible = Object.values(campaign.areas ?? {}).filter(area => area.accessible);
  const chapters = accessible.map(area => Number(area.chapter)).filter(ch => NIGHTMARE_CHAPTERS[ch]);
  if (chapters.length) return Math.max(...chapters);
  // CampaignData normally supplies activeArea. The source fallback follows its accessibility chain.
  const areas = campaign.areas;
  if (!areas?.shore) return null;
  const phantoms = Object.values(areas.shore.phantoms ?? {});
  if (!phantoms.length || !phantoms.every(p => p.rescued && p.home?.cleared)) return 1;
  const ids = ['shore', 'grounds', 'cellars', 'reception', 'dungeon', 'private', 'temple', 'vault', 'towers'];
  let chapter = 2;
  while (chapter < 9 && areas[ids[chapter - 1]]?.memento?.returned) chapter++;
  return chapter;
}

export function initializeNightmares(state, {chapter, alreadyHandled, at}) {
  chapterData(chapter);
  if (state.initialized) throw new Error(t('Nightmare.AlreadyInitialized'));
  Object.assign(state, {initialized: true, enabled: true, firstNightHandled: Boolean(alreadyHandled), initializedAt: at,
    chaptersHandled: alreadyHandled ? Object.fromEntries(Array.from({length: chapter}, (_, i) => [i + 1, true])) : {}});
}

export function queueRest(state, {id, actorIds = [], at, messageIds = []}) {
  if (!id || !Number.isFinite(at)) throw new Error(t('Nightmare.InvalidRestEvent'));
  const sessions = state.sessions ??= {};
  const record = sessions[id];
  if (record && record.status !== 'pending') return record;
  if (record) {
    record.actorIds = unique([...record.actorIds, ...actorIds]);
    record.messageIds = unique([...record.messageIds, ...messageIds]);
    return record;
  }
  return sessions[id] = {id, actorIds: unique(actorIds), messageIds: unique(messageIds), at, status: 'pending'};
}

export function restRequirement(state, chapter) {
  chapterData(chapter);
  if (!state.initialized) return 'initialize';
  if (!state.firstNightHandled) return 'first-night';
  if (!state.chaptersHandled?.[chapter]) return 'new-chapter';
  return 'flat-check';
}

export function confirmRest(state, {id, actorIds, chapter, flatTotal}) {
  const record = session(state, id);
  if (record.status !== 'pending') return record;
  const requirement = restRequirement(state, chapter);
  if (requirement === 'initialize') throw new Error(t('Nightmare.InitializeFirst'));
  const sleepers = unique(actorIds ?? []);
  if (!sleepers.length) throw new Error(t('Nightmare.ConfirmSleeper'));
  if (requirement === 'flat-check' && (!Number.isInteger(flatTotal) || flatTotal < 1 || flatTotal > 20)) throw new Error(t('Nightmare.FlatCheckRequired'));
  const nightmare = requirement !== 'flat-check' || flatTotal < 16;
  Object.assign(record, {actorIds: sleepers, chapter, requirement, nightmare, dc: chapterData(chapter).dc,
    status: nightmare ? 'awaiting-results' : 'complete', results: {}});
  if (requirement === 'flat-check') record.flatTotal = flatTotal;
  state.firstNightHandled = true;
  (state.chaptersHandled ??= {})[chapter] = true;
  return record;
}

export function cancelRest(state, id) {
  const record = session(state, id);
  if (record.status === 'pending') record.status = 'canceled';
}

export function reserveResult(state, {id, actorId, outcome}) {
  const record = session(state, id);
  if (!record.actorIds.includes(actorId) || !record.nightmare) throw new Error(t('Nightmare.NotSleeper'));
  if (record.results[actorId]) return record.results[actorId];
  if (!outcomes.has(outcome)) throw new Error(t('Nightmare.InvalidOutcome'));
  if (Object.values(state.sessions ?? {}).some(s => s.id !== id && s.results?.[actorId]?.status === 'applying')) throw new Error(t('Nightmare.RecoverPriorResult'));
  const prior = state.characters?.[actorId]?.chapters?.[record.chapter]?.phobiaAt;
  const applyPhobia = outcome === 'criticalFailure' && prior === undefined;
  const effectiveOutcome = outcome === 'criticalFailure' && !applyPhobia ? 'failure' : outcome;
  return record.results[actorId] = {outcome, effectiveOutcome, applyPhobia, at: record.at,
    until: record.at + NIGHTMARE_DAY, status: 'applying', lucidResearch: outcome === 'criticalSuccess'};
}

export function finishResult(state, {id, actorId}) {
  const record = session(state, id), result = record.results?.[actorId];
  if (!result || result.status === 'complete') return;
  const pc = character(state, actorId);
  if (result.applyPhobia) pc.chapters[record.chapter] = {phobiaAt: result.at, sessionId: id};
  if (['failure', 'criticalFailure'].includes(result.effectiveOutcome)) pc.pending = {sessionId: id, at: result.at, until: result.until};
  result.status = 'complete';
  if (record.actorIds.every(actor => record.results[actor]?.status === 'complete')) record.status = 'complete';
}

export function pendingFrightened(state, actorId, at) {
  const pending = state.characters?.[actorId]?.pending;
  return pending && !pending.consumed && !pending.expired && at >= pending.at && at < pending.until ? pending : null;
}

export function expireNightmares(state, at) {
  for (const pc of Object.values(state.characters ?? {})) {
    if (pc.pending && !pc.pending.expired && !pc.pending.consumed && at >= pc.pending.until) pc.pending.expired = true;
  }
  for (const record of Object.values(state.sessions ?? {})) {
    for (const result of Object.values(record.results ?? {})) {
      if (result.status === 'complete' && !result.expired && at >= result.until) result.expired = true;
    }
  }
}

export function reserveFrightened(state, {actorId, actionId, conditionId, value, at}) {
  const pc = character(state, actorId);
  if (pc.frightenedAction?.id === actionId) return pc.frightenedAction;
  if (pc.frightenedAction?.status === 'applying') throw new Error(t('Nightmare.RecoverFrightened'));
  if (!pendingFrightened(state, actorId, at)) throw new Error(t('Nightmare.NoPendingFrightened'));
  if (!conditionId || !Number.isInteger(value) || value < 1) throw new Error(t('Nightmare.ApplyFrightenedFirst'));
  return pc.frightenedAction = {id: actionId, conditionId, before: value, target: value + 1, at, sessionId: pc.pending.sessionId, status: 'applying'};
}

export function finishFrightened(state, {actorId, actionId, at}) {
  const pc = state.characters?.[actorId], action = pc?.frightenedAction;
  if (!action || action.id !== actionId || action.status === 'complete') return;
  action.status = 'complete';
  if (pc.pending?.sessionId === action.sessionId) Object.assign(pc.pending, {consumed: true, consumedAt: at});
}

export function correctCharacter(state, {actorId, chapter, phobiaHandled, clearPending, at}) {
  chapterData(chapter);
  if (Object.values(state.sessions ?? {}).some(s => s.results?.[actorId]?.status === 'applying') || state.characters?.[actorId]?.frightenedAction?.status === 'applying') {
    throw new Error(t('Nightmare.RecoverBeforeCorrection'));
  }
  const pc = character(state, actorId);
  if (phobiaHandled) pc.chapters[chapter] ??= {phobiaAt: at, corrected: true};
  else delete pc.chapters[chapter];
  if (clearPending && pc.pending) Object.assign(pc.pending, {consumed: true, consumedAt: at, corrected: true});
}
