import {ID, OFFICIAL} from './model.mjs';
import {t, markLocalized, localizeHTML, formatTime, formatDuration} from './i18n.mjs';
import {isPrimaryGM, requirePrimaryGM, now, escapeHtml as esc, partyMembers, readState, updateState, withAction, whisperGM, loadEffect} from './assistant-core.mjs';
import {NIGHTMARE_CHAPTERS, initializeNightmares, queueRest, restRequirement, confirmRest, cancelRest,
  reserveResult, finishResult, pendingFrightened, expireNightmares, reserveFrightened, finishFrightened,
  correctCharacter, latestUnlockedChapter} from './nightmare-model.mjs';

const DOMAIN = 'nightmares';
const rolledSaves = new Set();
const FLAGS = document => document?.flags?.[ID] ?? {};
const enabled = () => game.settings.get(ID, 'config')?.enabled !== false && readState(DOMAIN).enabled !== false;
const randomId = () => globalThis.foundry?.utils?.randomID?.() ?? crypto.randomUUID().replaceAll('-', '');
const outcomes = () => Object.fromEntries(['criticalSuccess', 'success', 'failure', 'criticalFailure'].map(key => [key, t(`Nightmare.Outcome${key[0].toUpperCase()}${key.slice(1)}`)]));
const actorFor = id => {
  const actor = game.actors.get(id);
  if (actor?.type !== 'character') throw new Error(t('Nightmare.ActorMissing'));
  return actor;
};
const sessionFor = id => {
  const session = readState(DOMAIN).sessions?.[id];
  if (!session) throw new Error(t('Nightmare.RestMissing'));
  return session;
};
const fail = error => { console.error(`${ID} | nightmare`, error); globalThis.ui?.notifications?.error(error.message ?? String(error)); };
const officialChapter = () => {
  try { return latestUnlockedChapter(game.settings.get(OFFICIAL, 'campaign')); }
  catch { return null; }
};
const phobiaDescription = chapter => `Nightmare.Phobia${chapter}Description`;

/** Reuse rules from the installed official item; only current mechanics are shown to its owner. */
export function buildPhobiaData(source, session) {
  const chapter = NIGHTMARE_CHAPTERS[session.chapter];
  if (!chapter) throw new Error(t('Nightmare.InvalidChapter'));
  const data = structuredClone(source);
  delete data._id;
  data.type = 'effect';
  // Keep the native slug and rules: native AdjustModifier elements depend on the slug.
  data.system ??= {};
  data.system.rules ??= [];
  data.system.description = {value: t(phobiaDescription(session.chapter)), gm: ''};
  data.system.duration = {value: 24, unit: 'hours', expiry: 'turn-start', sustained: false};
  data.system.start = {value: session.at, initiative: null};
  data.system.traits = {...data.system.traits, value: [...new Set([...(data.system.traits?.value ?? []), 'curse'])]};
  if (session.chapter === 1 && !data.system.rules.some(r => r.key === 'RollOption' && r.option === 'lake-laroba-in-sight')) {
    data.system.rules.push({key: 'RollOption', option: 'lake-laroba-in-sight', label: t('Nightmare.DeepWaterVisible'), toggleable: true, value: false});
  }
  data.flags = {...data.flags, [ID]: {...data.flags?.[ID], nightmare: {kind: 'phobia', sessionId: session.id, chapter: session.chapter}}};
  return markLocalized(data, {name: `Nightmare.Phobia${session.chapter}Name`, description: phobiaDescription(session.chapter), rules: session.chapter === 1 ? [{index: data.system.rules.findIndex(r => r.key === 'RollOption' && r.option === 'lake-laroba-in-sight'), label: 'Nightmare.DeepWaterVisible'}] : []});
}

export function buildUneaseData(session) {
  const data = {name: t('Nightmare.UneaseName'), type: 'effect', img: 'icons/magic/control/fear-fright-monster-grin-red-orange.webp',
    system: {slug: 'bob-nightmare-unease', description: {value: t('Nightmare.UneaseDescription'), gm: ''},
      rules: [], duration: {value: 24, unit: 'hours', expiry: 'turn-start', sustained: false}, start: {value: session.at, initiative: null}, traits: {value: ['curse'], rarity: 'common'}},
    flags: {[ID]: {nightmare: {kind: 'unease', sessionId: session.id}}}};
  return markLocalized(data, {name: 'Nightmare.UneaseName', description: 'Nightmare.UneaseDescription'});
}

export async function recordNativeRest(event) {
  return withAction(DOMAIN, async () => {
    if (!enabled()) return;
    const prior = readState(DOMAIN).sessions?.[event.id];
    const state = await updateState(DOMAIN, draft => { queueRest(draft, event); });
    if (!prior && state.sessions[event.id]) {
      await whisperGM(`<p>${localizeHTML('Nightmare.RestNotification')}</p><button type="button" data-bob-nightmares>${localizeHTML('Nightmare.OpenAssistant')}</button>`);
    }
    return state.sessions[event.id];
  });
}

export async function confirmNightmareRest({id, actorIds, chapter, flatTotal}) {
  return withAction(DOMAIN, async () => {
    let record = sessionFor(id);
    if (record.status !== 'pending') return record;
    if (!actorIds?.length) throw new Error(t('Nightmare.ConfirmSleeper'));
    actorIds.forEach(actorFor);
    chapter = officialChapter() ?? Number(chapter);
    const requirement = restRequirement(readState(DOMAIN), chapter);
    if (requirement === 'initialize') throw new Error(t('Nightmare.InitializeFirst'));
    if (requirement === 'flat-check') {
      flatTotal = record.flatTotal ?? flatTotal;
      if (flatTotal === undefined) {
        const roll = await new Roll('1d20').evaluate();
        flatTotal = roll.total;
        await updateState(DOMAIN, state => { state.sessions[id].flatTotal = flatTotal; });
        await roll.toMessage({flavor: t('Nightmare.RestCheckFlavor')}, {rollMode: 'gmroll'});
      }
    }
    const state = await updateState(DOMAIN, draft => { confirmRest(draft, {id, actorIds, chapter, flatTotal}); });
    return state.sessions[id];
  });
}

async function ensureEffectDependencies(data) {
  for (const rule of data.system?.rules ?? []) {
    if (rule.key === 'EphemeralEffect' && typeof rule.uuid === 'string' && !await fromUuid(rule.uuid)) {
      throw new Error(t('Nightmare.MissingEffectDependency'));
    }
  }
}

function remainingDuration(data, until) {
  // PF2e's preCreate sets start to the current world time. Preserve the rest's absolute deadline.
  const time = now();
  data.system.duration = {...data.system.duration, value: Math.max(0, (until - time) / 60), unit: 'minutes'};
  data.system.start = {value: time, initiative: null};
  return data;
}

export async function settleNightmareResult({id, actorId, outcome}) {
  return withAction(DOMAIN, async () => {
    const actor = actorFor(actorId);
    let state = await updateState(DOMAIN, draft => { reserveResult(draft, {id, actorId, outcome}); });
    const session = state.sessions[id], result = session.results[actorId];
    if (result.status === 'complete') return result;
    if (result.until > now()) {
      if (result.applyPhobia && !Array.from(actor.items).some(item => FLAGS(item).nightmare?.kind === 'phobia' && FLAGS(item).nightmare.sessionId === id)) {
        const source = await loadEffect(`Item.${NIGHTMARE_CHAPTERS[session.chapter].effect}`);
        const data = remainingDuration(buildPhobiaData(source, session), result.until);
        await ensureEffectDependencies(data);
        requirePrimaryGM();
        await actor.createEmbeddedDocuments('Item', [data]);
      }
      if (['failure', 'criticalFailure'].includes(result.effectiveOutcome)) {
        const existing = Array.from(actor.items).find(item => FLAGS(item).nightmare?.kind === 'unease');
        const data = remainingDuration(buildUneaseData(session), result.until);
        requirePrimaryGM();
        if (!existing) await actor.createEmbeddedDocuments('Item', [data]);
        else if (FLAGS(existing).nightmare.sessionId !== id) await existing.update(data);
      }
    }
    await updateState(DOMAIN, draft => { finishResult(draft, {id, actorId}); });
    await expireEffects(now());
    return readState(DOMAIN).sessions[id].results[actorId];
  });
}

export async function requestNightmareSave({id, actorId}) {
  return withAction(DOMAIN, async () => {
    const session = sessionFor(id), actor = actorFor(actorId);
    if (!session.nightmare || !session.actorIds.includes(actorId) || session.results?.[actorId] || session.suggestions?.[actorId]) throw new Error(t('Nightmare.NoPendingSave'));
    const existing = Array.from(game.messages ?? []).find(m => FLAGS(m).nightmareRequest?.sessionId === id && FLAGS(m).nightmareRequest.actorId === actorId);
    if (existing) return existing;
    return ChatMessage.create({speaker: ChatMessage.getSpeaker({actor}),
      content: `<p>${localizeHTML('Nightmare.SaveRequest', {actor: actor.name, dc: session.dc})}</p><button type="button" data-bob-nightmare-roll data-session="${esc(id)}" data-actor="${esc(actorId)}">${localizeHTML('Nightmare.WillSave')}</button>`,
      flags: {[ID]: {nightmareRequest: {sessionId: id, actorId, dc: session.dc}}}});
  });
}

export async function requestNightmareSaves({id}) {
  const session = sessionFor(id);
  if (!session.nightmare) return [];
  const unresolved = session.actorIds.filter(actorId => !session.results?.[actorId] && !session.suggestions?.[actorId]);
  const messages = [];
  for (const actorId of unresolved) messages.push(await requestNightmareSave({id, actorId}));
  return messages;
}

export async function rollNightmareSave({id, actorId, dc}) {
  const actor = actorFor(actorId);
  const session = sessionFor(id);
  if (!session.nightmare || !session.actorIds.includes(actorId) || session.results?.[actorId] || session.suggestions?.[actorId]) throw new Error(t('Nightmare.NoPendingSave'));
  if (!game.user.isGM && !actor.isOwner) throw new Error(t('Nightmare.SaveNotOwned'));
  if (typeof actor.saves?.will?.roll !== 'function') throw new Error(t('Nightmare.NativeWillUnavailable'));
  const key = `${id}:${actorId}`;
  if (rolledSaves.has(key)) throw new Error(t('Nightmare.SaveAlreadyRolled'));
  rolledSaves.add(key);
  try {
    const result = await actor.saves.will.roll({dc: {value: Number(dc ?? session.dc)}, label: t('Nightmare.WillSave'),
      extraRollOptions: ['lucid-nightmare', `bob-nightmare:${id}`]});
    if (!result) rolledSaves.delete(key);
    return result;
  } catch (error) { rolledSaves.delete(key); throw error; }
}

export async function consumeNightmareFrightened({actorId, actionId}) {
  return withAction(DOMAIN, async () => {
    const actor = actorFor(actorId), prior = readState(DOMAIN).characters?.[actorId]?.frightenedAction;
    actionId ??= prior?.status === 'applying' ? prior.id : randomId();
    let condition = prior?.id === actionId ? actor.items.get(prior.conditionId) : actor.getCondition('frightened');
    let state = await updateState(DOMAIN, draft => { reserveFrightened(draft, {actorId, actionId, conditionId: condition?.id, value: condition?.value, at: now()}); });
    const action = state.characters[actorId].frightenedAction;
    if (action.status === 'complete') return action;
    condition = actor.items.get(action.conditionId);
    if (!condition || condition.slug !== 'frightened') throw new Error(t('Nightmare.FrightenedChanged'));
    if (FLAGS(condition).nightmareFrightened?.actionId !== action.id) {
      if (condition.value !== action.before) throw new Error(t('Nightmare.FrightenedValueChanged'));
      requirePrimaryGM();
      await condition.update({'system.value.value': action.target, [`flags.${ID}.nightmareFrightened`]: {actionId: action.id, target: action.target}});
    }
    const markers = Array.from(actor.items).filter(item => FLAGS(item).nightmare?.kind === 'unease' && FLAGS(item).nightmare.sessionId === action.sessionId);
    if (markers.length) { requirePrimaryGM(); await actor.deleteEmbeddedDocuments('Item', markers.map(i => i.id)); }
    state = await updateState(DOMAIN, draft => { finishFrightened(draft, {actorId, actionId, at: now()}); });
    return state.characters[actorId].frightenedAction;
  });
}

function needsExpiry(state, at) {
  return Object.values(state.characters ?? {}).some(pc => pc.pending && !pc.pending.consumed && !pc.pending.expired && at >= pc.pending.until) ||
    Object.values(state.sessions ?? {}).some(s => Object.values(s.results ?? {}).some(r => r.status === 'complete' && !r.expired && at >= r.until));
}

/** Delete elapsed owned effects once so rewinding the world clock cannot reactivate them. */
export async function expireNightmareEffects(at = now()) {
  return withAction(DOMAIN, () => expireEffects(at));
}

async function expireEffects(at) {
    const state = readState(DOMAIN);
    if (!enabled() || !needsExpiry(state, at)) return;
    const elapsed = new Map();
    for (const session of Object.values(state.sessions ?? {})) {
      for (const [actorId, result] of Object.entries(session.results ?? {})) {
        if (result.status !== 'complete' || result.expired || at < result.until) continue;
        if (!elapsed.has(actorId)) elapsed.set(actorId, new Set());
        elapsed.get(actorId).add(session.id);
      }
    }
    for (const [actorId, sessions] of elapsed) {
      const actor = game.actors.get(actorId);
      const ids = Array.from(actor?.items ?? []).filter(item => sessions.has(FLAGS(item).nightmare?.sessionId)).map(item => item.id);
      if (ids.length) { requirePrimaryGM(); await actor.deleteEmbeddedDocuments('Item', ids); }
    }
    await updateState(DOMAIN, draft => { expireNightmares(draft, at); });
}

function getForm(dialog) { return new FormData(dialog.element.querySelector('form')); }
const option = (value, text, selected = false) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(text)}</option>`;
const formRow = (label, content) => `<div class="form-group"><label>${label}</label>${content}</div>`;
const notice = html => `<p class="bob-hint">${html}</p>`;
const readableTime = value => Number.isFinite(value) ? formatTime(value) : t('Nightmare.UnknownTime');

async function setupNightmares() {
  requirePrimaryGM();
  const chapter = officialChapter();
  const result = await foundry.applications.api.DialogV2.wait({window: {title: t('Nightmare.SetupTitle')}, position: {width: 540}, classes: ['bob-companion'],
    content: notice(t('Nightmare.SetupHint')) +
      (chapter ? `<p>${t('Nightmare.CurrentChapter', {chapter})}</p>` : formRow(t('Nightmare.ChapterUnavailable'), `<select name="chapter">${Object.keys(NIGHTMARE_CHAPTERS).map(ch => option(ch, t('Nightmare.Chapter', {chapter: ch}))).join('')}</select>`)) +
      `<label><input type="radio" name="baseline" value="handled" checked> ${t('Nightmare.PastNightsHandled')}</label><br><label><input type="radio" name="baseline" value="new"> ${t('Nightmare.FirstNightPending')}</label>`,
    buttons: [{action: 'save', label: t('Nightmare.SaveSetup'), default: true, callback: (_e, _b, d) => ({chapter: chapter ?? Number(getForm(d).get('chapter')), alreadyHandled: getForm(d).get('baseline') === 'handled'})}, {action: 'cancel', label: t('Nightmare.Cancel')}], rejectClose: false});
  if (!result || result === 'cancel') return;
  await updateState(DOMAIN, draft => { initializeNightmares(draft, {...result, at: now()}); });
}

async function editRest(id) {
  const record = sessionFor(id), chapter = officialChapter();
  if (record.status !== 'pending') return showResults(id);
  const available = new Map([...partyMembers(), ...record.actorIds.map(id => game.actors.get(id)).filter(Boolean)].map(a => [a.id, a]));
  const requirement = chapter ? restRequirement(readState(DOMAIN), chapter) : null;
  const result = await foundry.applications.api.DialogV2.wait({window: {title: t('Nightmare.ConfirmSleepTitle')}, position: {width: 580}, classes: ['bob-companion'],
    content: notice(t('Nightmare.ConfirmSleepHint')) +
      `<p>${t('Nightmare.RecordedAt', {time: readableTime(record.at)})}${chapter ? ` · ${t('Nightmare.CurrentChapter', {chapter})}` : ''}</p>` +
      (chapter ? '' : formRow(t('Nightmare.ChapterUnavailable'), `<select name="chapter">${Object.keys(NIGHTMARE_CHAPTERS).map(ch => option(ch, t('Nightmare.Chapter', {chapter: ch}))).join('')}</select>`)) +
      (requirement ? notice(t(requirement === 'flat-check' ? 'Nightmare.FlatCheckHint' : 'Nightmare.FirstNightHint')) : '') +
      [...available.values()].map(actor => `<label style="display:block"><input type="checkbox" name="sleepers" value="${esc(actor.id)}" ${record.actorIds.includes(actor.id) ? 'checked' : ''}> ${esc(actor.name)}</label>`).join(''),
    buttons: [{action: 'confirm', label: t('Nightmare.ConfirmSleep'), default: true, callback: (_e, _b, d) => ({actorIds: getForm(d).getAll('sleepers'), chapter: chapter ?? Number(getForm(d).get('chapter'))})},
      {action: 'ignore', label: t('Nightmare.NotApplicable')}, {action: 'cancel', label: t('Nightmare.Later')}], rejectClose: false});
  if (result === 'ignore') { await updateState(DOMAIN, state => { cancelRest(state, id); }); return; }
  if (!result || result === 'cancel') return;
  const confirmed = await confirmNightmareRest({id, ...result});
  if (confirmed.nightmare) await showResults(id);
  else ui.notifications.info(t('Nightmare.NoNightmare'));
}

async function showResults(id) {
  const record = sessionFor(id);
  const unresolved = record.actorIds.filter(actorId => !record.results?.[actorId] && !record.suggestions?.[actorId]);
  const rows = record.actorIds.map(actorId => {
    const actor = game.actors.get(actorId), result = record.results?.[actorId], suggested = record.suggestions?.[actorId]?.outcome;
    return `<div class="bob-card"><h3>${esc(actor?.name ?? actorId)}</h3>${result?.status === 'complete'
      ? `<p>${t('Nightmare.Settled', {outcome: outcomes()[result.effectiveOutcome]})}${result.applyPhobia ? ` · ${t('Nightmare.PhobiaRecorded')}` : ''}${result.lucidResearch ? ` · ${t('Nightmare.LucidResearchRecorded')}` : ''}</p>`
      : `<p>${result?.status === 'applying' ? t('Nightmare.RetryResult') : suggested ? t('Nightmare.SuggestedOutcome', {outcome: outcomes()[suggested]}) : t('Nightmare.AwaitingSave')}</p>
        ${!result && !suggested ? `<button type="button" data-action="roll" data-actor="${esc(actorId)}">${t('Nightmare.GmNativeRoll')}</button>` : ''}
        <select name="outcome-${esc(actorId)}">${Object.entries(outcomes()).map(([key, label]) => option(key, label, key === (result?.outcome ?? suggested ?? 'success'))).join('')}</select>
        <button type="button" data-action="settle" data-actor="${esc(actorId)}">${t(result ? 'Nightmare.RetrySettlement' : 'Nightmare.ConfirmOutcome')}</button>`}</div>`;
  }).join('');
  class ResultsDialog extends foundry.applications.api.DialogV2 {
    _onRender(context, options) {
      super._onRender(context, options);
      this.element.querySelector('[data-action="request-all"]')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        if (button.disabled) return;
        button.disabled = true;
        try { await requestNightmareSaves({id}); }
        catch (error) { fail(error); }
        finally { button.disabled = false; }
      });
      this.element.querySelectorAll('[data-action][data-actor]').forEach(button => button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          const actorId = button.dataset.actor;
          if (button.dataset.action === 'roll') await rollNightmareSave({id, actorId});
          else {
            await settleNightmareResult({id, actorId, outcome: getForm(this).get(`outcome-${actorId}`)});
            await this.close(); await showResults(id);
          }
        } catch (error) { fail(error); }
        finally { button.disabled = false; }
      }));
    }
  }
  return ResultsDialog.wait({window: {title: t('Nightmare.ResultsTitle')}, position: {width: 650}, classes: ['bob-companion'],
    content: `<p>${t('Nightmare.ResultsSummary', {chapter: record.chapter, dc: record.dc, time: readableTime(record.at)})}</p>${unresolved.length ? `<p><button type="button" data-action="request-all">${t('Nightmare.RequestAllSaves', {count: unresolved.length})}</button></p>` : ''}${rows}<details><summary>${t('Nightmare.RuleDetails')}</summary>${notice(t('Nightmare.ResearchHint'))}</details>`,
    buttons: [{action: 'close', label: t('Nightmare.Close')}], rejectClose: false});
}

async function correctionDialog() {
  requirePrimaryGM();
  const chapter = officialChapter() ?? 1;
  const result = await foundry.applications.api.DialogV2.wait({window: {title: t('Nightmare.CorrectionTitle')}, classes: ['bob-companion'], position: {width: 550},
    content: notice(t('Nightmare.CorrectionHint')) +
      formRow(t('Nightmare.Actor'), `<select name="actor">${partyMembers().map(a => option(a.id, a.name)).join('')}</select>`) +
      formRow(t('Nightmare.ChapterLabel'), `<select name="chapter">${Object.keys(NIGHTMARE_CHAPTERS).filter(ch => Number(ch) <= chapter).map(ch => option(ch, t('Nightmare.Chapter', {chapter: ch}), Number(ch) === chapter)).join('')}</select>`) +
      `<label><input name="phobia" type="checkbox" checked> ${t('Nightmare.PhobiaHandled')}</label><br><label><input name="clear" type="checkbox"> ${t('Nightmare.ClearPendingFear')}</label><br>` +
      `<label><input name="first" type="checkbox"> ${t('Nightmare.MarkPastNights')}</label>`,
    buttons: [{action: 'save', label: t('Nightmare.SaveCorrection'), callback: (_e, _b, d) => Object.fromEntries(getForm(d))}, {action: 'cancel', label: t('Nightmare.Cancel')}], rejectClose: false});
  if (!result || result === 'cancel') return;
  actorFor(result.actor);
  await updateState(DOMAIN, draft => {
    correctCharacter(draft, {actorId: result.actor, chapter: Number(result.chapter), phobiaHandled: result.phobia === 'on', clearPending: result.clear === 'on', at: now()});
    if (result.first === 'on') { draft.firstNightHandled = true; for (let ch = 1; ch <= chapter; ch++) (draft.chaptersHandled ??= {})[ch] = true; }
  });
  if (result.clear === 'on') {
    const actor = actorFor(result.actor), ids = Array.from(actor.items).filter(i => FLAGS(i).nightmare?.kind === 'unease').map(i => i.id);
    if (ids.length) { requirePrimaryGM(); await actor.deleteEmbeddedDocuments('Item', ids); }
  }
}

export async function openNightmares() {
  if (!game.user.isGM) throw new Error(t('Nightmare.GmOnly'));
  const state = readState(DOMAIN), chapter = officialChapter(), primary = isPrimaryGM();
  const sessions = Object.values(state.sessions ?? {}).sort((a, b) => b.at - a.at);
  const pending = sessions.filter(s => ['pending', 'awaiting-results'].includes(s.status));
  const recent = sessions.filter(s => s.status === 'complete').slice(0, 3);
  const actors = partyMembers();
  const currentStatus = actors.map(actor => {
    const pc = state.characters?.[actor.id], curse = pendingFrightened(state, actor.id, now()), recovering = pc?.frightenedAction?.status === 'applying';
    if (!curse && !recovering) return '';
    return `<p><strong>${esc(actor.name)}</strong> · ${curse ? t('Nightmare.PendingFear', {duration: formatDuration(curse.until - now())}) : t('Nightmare.FearRecovery')}${primary ? ` <button type="button" data-action="fear" data-actor="${esc(actor.id)}">${t(recovering ? 'Nightmare.RetryFear' : 'Nightmare.ApplyFirstFear')}</button>` : ''}</p>`;
  }).join('') || `<p>${t('Nightmare.NoActiveEffects')}</p>`;
  const body = `<p>${t(primary ? 'Nightmare.PrimaryStatus' : 'Nightmare.ReadOnlyStatus')}${state.enabled === false ? ` · ${t('Nightmare.AutomationPaused')}` : ''}</p>` +
    (!state.initialized ? notice(t('Nightmare.SetupNeeded')) : '') +
    `<h3>${t('Nightmare.PendingRests')}</h3>` + (pending.length ? pending.map(s => `<p>${esc(s.actorIds.map(id => game.actors.get(id)?.name ?? id).join(', '))} · ${esc(readableTime(s.at))} · ${t(s.status === 'pending' ? 'Nightmare.PendingSleep' : 'Nightmare.PendingResults')} ${primary ? `<button type="button" data-action="rest" data-id="${esc(s.id)}">${t('Nightmare.Handle')}</button>` : ''}</p>`).join('') : `<p>${t('Nightmare.NoPendingRests')}</p>`) +
    (recent.length ? `<h3>${t('Nightmare.RecentResults')}</h3>${recent.map(s => `<p>${esc(s.actorIds.map(id => game.actors.get(id)?.name ?? id).join(', '))} · ${esc(readableTime(s.at))} · ${t(s.nightmare ? 'Nightmare.ResultsComplete' : 'Nightmare.NoNightmareShort')}</p>`).join('')}` : '') +
    `<h3>${t('Nightmare.CurrentStatus')}</h3>${currentStatus}` +
    `<details><summary>${t('Nightmare.Advanced')}</summary>${notice(t('Nightmare.NativeRestHint'))}` +
    `<p>${chapter ? t('Nightmare.CurrentChapter', {chapter}) : t('Nightmare.ChapterUnavailable')}${state.initialized ? ` · ${t(state.firstNightHandled ? 'Nightmare.PastNightsHandled' : 'Nightmare.FirstNightPending')}` : ''}</p>` +
    (primary ? `<p>${!state.initialized ? `<button type="button" data-action="setup">${t('Nightmare.Setup')}</button>` : `<button type="button" data-action="manual">${t('Nightmare.ManualRest')}</button><button type="button" data-action="correct">${t('Nightmare.CorrectRecords')}</button>`}<button type="button" data-action="toggle">${t(state.enabled === false ? 'Nightmare.ResumeAutomation' : 'Nightmare.PauseAutomation')}</button></p>` : '') +
    `</details>`;
  class NightmaresDialog extends foundry.applications.api.DialogV2 {
    _onRender(context, options) {
      super._onRender(context, options);
      this.element.querySelectorAll('[data-action="setup"], [data-action="toggle"], [data-action="correct"], [data-action="manual"], [data-action="rest"], [data-action="fear"]').forEach(button => button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          requirePrimaryGM();
          switch (button.dataset.action) {
            case 'setup': await setupNightmares(); break;
            case 'toggle': await updateState(DOMAIN, s => { s.enabled = s.enabled === false; }); break;
            case 'correct': await correctionDialog(); break;
            case 'manual': {
              const id = `manual-${randomId()}`;
              await updateState(DOMAIN, s => { queueRest(s, {id, actorIds: actors.map(a => a.id), at: now()}); });
              await editRest(id); break;
            }
            case 'rest': await editRest(button.dataset.id); break;
            case 'fear': {
              const recovering = readState(DOMAIN).characters?.[button.dataset.actor]?.frightenedAction?.status === 'applying';
               if (recovering || await foundry.applications.api.DialogV2.confirm({window: {title: t('Nightmare.ConfirmFirstFearTitle')}, content: `<p>${t('Nightmare.ConfirmFirstFearHint')}</p>`})) await consumeNightmareFrightened({actorId: button.dataset.actor});
              break;
            }
            default: return;
          }
          await this.close(); await openNightmares();
        } catch (error) { fail(error); }
        finally { button.disabled = false; }
      }));
    }
  }
  return NightmaresDialog.wait({window: {title: t('Nightmare.HomeTitle')}, position: {width: 700}, classes: ['bob-companion'], content: body,
    buttons: [{action: 'close', label: t('Nightmare.Close')}], rejectClose: false});
}

let registered = false;
const nativeBatches = new WeakMap();
const arrivals = new Map();
let arrivalTimer;

function queueNativeMessage(message, options) {
  const info = FLAGS(message).nightmareRest;
  if (!info && !options?.restForTheNight) return;
  const id = info?.id ?? `rest-${message.author?.id ?? 'unknown'}-${message.timestamp}`;
  const actorId = message.speaker?.actor;
  if (!actorId || game.actors.get(actorId)?.type !== 'character') return;
  const event = arrivals.get(id) ?? {id, actorIds: [], at: info?.at ?? now(), messageIds: []};
  event.actorIds.push(actorId); event.messageIds.push(message.id); arrivals.set(id, event);
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(() => {
    const batch = [...arrivals.values()]; arrivals.clear();
    if (!isPrimaryGM()) return;
    for (const event of batch) void recordNativeRest(event).catch(fail);
  }, 350);
}

async function captureSave(message) {
  if (!isPrimaryGM() || !enabled()) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== 'saving-throw' || !Object.hasOwn(outcomes(), context.outcome)) return;
  const marker = Array.from(context.options ?? []).find(o => typeof o === 'string' && o.startsWith('bob-nightmare:'));
  if (!marker) return;
  const id = marker.slice('bob-nightmare:'.length), actorId = message.speaker?.actor;
  const record = readState(DOMAIN).sessions?.[id];
  const canRecord = current => {
    if (!current?.nightmare || !current.actorIds.includes(actorId) || current.results?.[actorId]) return false;
    const previous = current.suggestions?.[actorId];
    return !previous || (context.isReroll === true && previous.messageId !== message.id);
  };
  if (!canRecord(record)) return;
  await updateState(DOMAIN, state => {
    const current = state.sessions?.[id];
    if (canRecord(current)) (current.suggestions ??= {})[actorId] = {outcome: context.outcome, messageId: message.id};
  });
}

export function registerNightmares() {
  if (registered) return;
  registered = true;
  // The local rest hook has no transaction ID. Its completed native chat batch is authoritative
  // and travels to the GM even when a player invoked Party rest.
  Hooks.on('preCreateChatMessage', (message, _data, options) => {
    if (!options?.restForTheNight || !enabled()) return;
    let batch = nativeBatches.get(options);
    if (!batch) { batch = {id: `rest-${randomId()}`, at: now()}; nativeBatches.set(options, batch); }
    message.updateSource({[`flags.${ID}.nightmareRest`]: batch});
  });
  Hooks.on('createChatMessage', (message, options) => {
    queueNativeMessage(message, options);
    void captureSave(message).catch(fail);
  });
  Hooks.on('renderChatMessageHTML', (message, element) => {
    element.querySelectorAll('[data-bob-nightmares]').forEach(button => {
      if (!game.user.isGM) { button.remove(); return; }
      button.addEventListener('click', () => void openNightmares().catch(fail));
    });
    element.querySelectorAll('[data-bob-nightmare-roll]').forEach(button => {
      const request = FLAGS(message).nightmareRequest;
      const actor = game.actors.get(request?.actorId);
      if (!request || (!game.user.isGM && !actor?.isOwner)) { button.disabled = true; return; }
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await rollNightmareSave({id: request.sessionId, actorId: request.actorId, dc: request.dc}); }
        catch (error) { fail(error); }
        finally { button.disabled = false; }
      });
    });
  });
  Hooks.on('updateWorldTime', worldTime => {
    if (!isPrimaryGM()) return;
    const state = readState(DOMAIN);
    if (!enabled() || !needsExpiry(state, worldTime)) return;
    void expireNightmareEffects(worldTime).catch(fail);
  });
  Hooks.once('ready', () => {
    const module = game.modules.get(ID);
    Object.assign(module.api ??= {}, {openNightmares, confirmNightmareRest, settleNightmareResult, requestNightmareSave, consumeNightmareFrightened});
    if (isPrimaryGM()) void expireNightmareEffects().catch(fail);
  });
}
