import {ID, OFFICIAL} from './model.mjs';
import {isPrimaryGM, requirePrimaryGM, now, escapeHtml as esc, partyMembers, readState, updateState, withAction, whisperGM, loadEffect} from './assistant-core.mjs';
import {NIGHTMARE_CHAPTERS, initializeNightmares, queueRest, restRequirement, confirmRest, cancelRest,
  reserveResult, finishResult, pendingFrightened, expireNightmares, reserveFrightened, finishFrightened,
  correctCharacter, latestUnlockedChapter} from './nightmare-model.mjs';

const DOMAIN = 'nightmares';
const FLAGS = document => document?.flags?.[ID] ?? {};
const enabled = () => game.settings.get(ID, 'config')?.enabled !== false && readState(DOMAIN).enabled !== false;
const randomId = () => globalThis.foundry?.utils?.randomID?.() ?? crypto.randomUUID().replaceAll('-', '');
const outcomes = {criticalSuccess: '大成功', success: '成功', failure: '失败', criticalFailure: '大失败'};
const actorFor = id => {
  const actor = game.actors.get(id);
  if (actor?.type !== 'character') throw new Error('睡眠角色已不存在或不是人物角色。');
  return actor;
};
const sessionFor = id => {
  const session = readState(DOMAIN).sessions?.[id];
  if (!session) throw new Error('找不到休息记录。');
  return session;
};
const fail = error => { console.error(`${ID} | nightmare`, error); globalThis.ui?.notifications?.error(error.message ?? String(error)); };
const officialChapter = () => {
  try { return latestUnlockedChapter(game.settings.get(OFFICIAL, 'campaign')); }
  catch { return null; }
};
const descriptions = {
  1: '可见拉罗巴湖水时，运动检定承受 –2 状态减值。请使用效果中的可见深水开关。',
  2: '每次受到火焰伤害时获得惊惧 1。原生效果在伤害时提供提醒；GM 确认后施加状态。',
  3: '遭到夹击时获得惊惧 1。原生效果在攻击时提供提醒；GM 确认后施加状态。',
  4: '不在明亮光照中时，意志豁免承受 –1 环境减值；黑暗中改为 –2。请按当前光照设置效果开关。',
  5: '目睹 30 尺内生物受到持续流血伤害或武器打击的大成功时，获得恶心 1；自己是目标时改为恶心 2。由 GM 确认实际触发。',
  6: '无法受益于协助，也无法与盟友夹击。盟友以有益效果指定你为目标时，须通过 DC 26 意志豁免才能接受；失败后的反应由 GM 裁定。',
  7: '身处室外或没有屋顶的区域时措手不及。请按实际环境设置效果开关。',
  8: '与蛛形生物战斗时措手不及；遭其打击的大成功或受到蛛网影响时，另获得缓慢 1。请按当前遭遇设置效果开关，额外状态由 GM 确认。',
  9: '与怪物般的敌人开始战斗时，进行 @Check[will|dc:31|name:意志豁免|options:inflicts:slowed,inflicts:stunned]。失败时在此次战斗中缓慢 1；大失败时先震慑 3，再于此次战斗中缓慢 1。'
};

/** Reuse rules from the installed official item; only current mechanics are shown to its owner. */
export function buildPhobiaData(source, session) {
  const chapter = NIGHTMARE_CHAPTERS[session.chapter];
  if (!chapter) throw new Error('章节无效，无法载入恐惧症效果。');
  const data = structuredClone(source);
  delete data._id;
  data.type = 'effect';
  // Keep the native name and slug: native AdjustModifier elements depend on its slug.
  data.system ??= {};
  data.system.rules ??= [];
  data.system.description = {value: `<p>${descriptions[session.chapter]}</p><p>这是诅咒效果，持续 24 小时。</p>`, gm: ''};
  data.system.duration = {value: 24, unit: 'hours', expiry: 'turn-start', sustained: false};
  data.system.start = {value: session.at, initiative: null};
  data.system.traits = {...data.system.traits, value: [...new Set([...(data.system.traits?.value ?? []), 'curse'])]};
  if (session.chapter === 1 && !data.system.rules.some(r => r.key === 'RollOption' && r.option === 'lake-laroba-in-sight')) {
    data.system.rules.push({key: 'RollOption', option: 'lake-laroba-in-sight', label: '可见深水', toggleable: true, value: false});
  }
  data.flags = {...data.flags, [ID]: {...data.flags?.[ID], nightmare: {kind: 'phobia', sessionId: session.id, chapter: session.chapter}}};
  return data;
}

export function buildUneaseData(session) {
  return {name: '梦后不安', type: 'effect', img: 'icons/magic/control/fear-fright-monster-grin-red-orange.webp',
    system: {slug: 'bob-nightmare-unease', description: {value: '<p>在 24 小时内第一次获得惊惧时，该次惊惧状态值增加 1。这是诅咒效果。由 GM 确认首次获得并结算。</p>', gm: ''},
      rules: [], duration: {value: 24, unit: 'hours', expiry: 'turn-start', sustained: false}, start: {value: session.at, initiative: null}, traits: {value: ['curse'], rarity: 'common'}},
    flags: {[ID]: {nightmare: {kind: 'unease', sessionId: session.id}}}};
}

export async function recordNativeRest(event) {
  return withAction(DOMAIN, async () => {
    if (!enabled()) return;
    const prior = readState(DOMAIN).sessions?.[event.id];
    const state = await updateState(DOMAIN, draft => { queueRest(draft, event); });
    if (!prior && state.sessions[event.id]) {
      await whisperGM('<p>原生休息已完成。请在休息助手确认本次实际睡眠名单与噩梦结算。</p><button type="button" data-bob-nightmares>打开休息助手</button>');
    }
    return state.sessions[event.id];
  });
}

export async function confirmNightmareRest({id, actorIds, chapter, flatTotal}) {
  return withAction(DOMAIN, async () => {
    let record = sessionFor(id);
    if (record.status !== 'pending') return record;
    if (!actorIds?.length) throw new Error('请至少确认一名睡眠角色。');
    actorIds.forEach(actorFor);
    chapter = officialChapter() ?? Number(chapter);
    const requirement = restRequirement(readState(DOMAIN), chapter);
    if (requirement === 'initialize') throw new Error('请先初始化休息助手。');
    if (requirement === 'flat-check') {
      flatTotal = record.flatTotal ?? flatTotal;
      if (flatTotal === undefined) {
        const roll = await new Roll('1d20').evaluate();
        flatTotal = roll.total;
        await updateState(DOMAIN, state => { state.sessions[id].flatTotal = flatTotal; });
        await roll.toMessage({flavor: '休息判定 · DC 16'}, {rollMode: 'gmroll'});
      }
    }
    const state = await updateState(DOMAIN, draft => { confirmRest(draft, {id, actorIds, chapter, flatTotal}); });
    return state.sessions[id];
  });
}

async function ensureEffectDependencies(data) {
  for (const rule of data.system?.rules ?? []) {
    if (rule.key === 'EphemeralEffect' && typeof rule.uuid === 'string' && !await fromUuid(rule.uuid)) {
      throw new Error('官方恐惧症的关联提醒效果缺失；请完整导入冒险资产后重试。');
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
    if (!session.nightmare || !session.actorIds.includes(actorId)) throw new Error('此角色没有待进行的意志豁免。');
    const existing = Array.from(game.messages ?? []).find(m => FLAGS(m).nightmareRequest?.sessionId === id && FLAGS(m).nightmareRequest.actorId === actorId);
    if (existing) return existing;
    return ChatMessage.create({speaker: ChatMessage.getSpeaker({actor}),
      content: `<p>${esc(actor.name)}：请进行当前意志豁免（DC ${session.dc}）。</p><button type="button" data-bob-nightmare-roll data-session="${esc(id)}" data-actor="${esc(actorId)}">意志豁免</button>`,
      flags: {[ID]: {nightmareRequest: {sessionId: id, actorId, dc: session.dc}}}});
  });
}

export async function rollNightmareSave({id, actorId, dc}) {
  const actor = actorFor(actorId);
  if (!game.user.isGM && !actor.isOwner) throw new Error('只能为自己有权限的角色进行检定。');
  if (typeof actor.saves?.will?.roll !== 'function') throw new Error('原生意志检定不可用；请手动检定并由 GM 记录结果。');
  return actor.saves.will.roll({dc: {value: Number(dc ?? sessionFor(id).dc)}, label: '意志豁免',
    extraRollOptions: ['lucid-nightmare', `bob-nightmare:${id}`]});
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
    if (!condition || condition.slug !== 'frightened') throw new Error('原惊惧状态已改变或移除；请恢复该状态后重试，避免加错状态。');
    if (FLAGS(condition).nightmareFrightened?.actionId !== action.id) {
      if (condition.value !== action.before) throw new Error('惊惧值已改变；请先核对并恢复结算前数值，再重试。');
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
const readableTime = value => Number.isFinite(value) ? `${Math.round(value)} 秒` : '未知';

async function setupNightmares() {
  requirePrimaryGM();
  const chapter = officialChapter();
  const result = await foundry.applications.api.DialogV2.wait({window: {title: '初始化休息记录'}, position: {width: 540}, classes: ['bob-companion'],
    content: notice('已有战役请选择“当前及之前首夜已处理”，避免突然补结算过去的首夜。每人本章已受恐惧症的记录可稍后逐人校准。') +
      (chapter ? `<p>官方最新已解锁章节：${chapter}</p>` : formRow('最新已解锁章节（官方状态不可用）', `<select name="chapter">${Object.keys(NIGHTMARE_CHAPTERS).map(ch => option(ch, `第 ${ch} 章`)).join('')}</select>`)) +
      '<label><input type="radio" name="baseline" value="handled" checked> 当前及之前首夜已处理</label><br><label><input type="radio" name="baseline" value="new"> 尚未度过第一晚</label>',
    buttons: [{action: 'save', label: '保存初始化', default: true, callback: (_e, _b, d) => ({chapter: chapter ?? Number(getForm(d).get('chapter')), alreadyHandled: getForm(d).get('baseline') === 'handled'})}, {action: 'cancel', label: '取消'}], rejectClose: false});
  if (!result || result === 'cancel') return;
  await updateState(DOMAIN, draft => { initializeNightmares(draft, {...result, at: now()}); });
}

async function editRest(id) {
  const record = sessionFor(id), chapter = officialChapter();
  if (record.status !== 'pending') return showResults(id);
  const available = new Map([...partyMembers(), ...record.actorIds.map(id => game.actors.get(id)).filter(Boolean)].map(a => [a.id, a]));
  const requirement = chapter ? restRequirement(readState(DOMAIN), chapter) : null;
  const result = await foundry.applications.api.DialogV2.wait({window: {title: '确认本次睡眠'}, position: {width: 580}, classes: ['bob-companion'],
    content: notice('原生休息资源恢复已经完成。仅勾选确实在孽裔厅堂睡眠的角色；不推进世界时间。') +
      `<p>记录时间：${readableTime(record.at)}。${chapter ? `官方最新已解锁章节：${chapter}。` : ''}</p>` +
      (chapter ? '' : formRow('最新已解锁章节（官方状态不可用）', `<select name="chapter">${Object.keys(NIGHTMARE_CHAPTERS).map(ch => option(ch, `第 ${ch} 章`)).join('')}</select>`)) +
      (requirement ? notice(requirement === 'flat-check' ? '确认后进行一次 DC 16 纯骰；失败才进行意志豁免。' : '第一晚或新章节首夜：确认后必定进行噩梦豁免。') : '') +
      [...available.values()].map(actor => `<label style="display:block"><input type="checkbox" name="sleepers" value="${esc(actor.id)}" ${record.actorIds.includes(actor.id) ? 'checked' : ''}> ${esc(actor.name)}</label>`).join(''),
    buttons: [{action: 'confirm', label: '确认睡眠并判定', default: true, callback: (_e, _b, d) => ({actorIds: getForm(d).getAll('sleepers'), chapter: chapter ?? Number(getForm(d).get('chapter'))})},
      {action: 'ignore', label: '本次不适用'}, {action: 'cancel', label: '稍后'}], rejectClose: false});
  if (result === 'ignore') { await updateState(DOMAIN, state => { cancelRest(state, id); }); return; }
  if (!result || result === 'cancel') return;
  const confirmed = await confirmNightmareRest({id, ...result});
  if (confirmed.nightmare) await showResults(id);
  else ui.notifications.info('DC 16 纯骰成功；本次没有噩梦。');
}

async function showResults(id) {
  const record = sessionFor(id);
  const rows = record.actorIds.map(actorId => {
    const actor = game.actors.get(actorId), result = record.results?.[actorId], suggested = record.suggestions?.[actorId]?.outcome;
    return `<div class="bob-card"><h3>${esc(actor?.name ?? actorId)}</h3>${result?.status === 'complete'
      ? `<p>已结算：${outcomes[result.effectiveOutcome]}${result.applyPhobia ? '；已登记本章恐惧症' : ''}${result.lucidResearch ? '；清醒梦研究机会待 GM 按原研究记录处理' : ''}。</p>`
      : `<p>${result?.status === 'applying' ? '上次结算未完成；重试将核对已有原生效果。' : suggested ? `已识别原生结果：${outcomes[suggested]}，请 GM 确认。` : '等待意志豁免或 GM 手动录入。'}</p>
        <button type="button" data-action="request" data-actor="${esc(actorId)}">发送检定请求</button><button type="button" data-action="roll" data-actor="${esc(actorId)}">GM 原生检定</button>
        <select name="outcome-${esc(actorId)}">${Object.entries(outcomes).map(([key, label]) => option(key, label, key === (result?.outcome ?? suggested ?? 'success'))).join('')}</select>
        <button type="button" data-action="settle" data-actor="${esc(actorId)}">${result ? '恢复结算' : '确认该结果'}</button>`}</div>`;
  }).join('');
  class ResultsDialog extends foundry.applications.api.DialogV2 {
    _onRender(context, options) {
      super._onRender(context, options);
      this.element.querySelectorAll('[data-action][data-actor]').forEach(button => button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          const actorId = button.dataset.actor;
          if (button.dataset.action === 'request') await requestNightmareSave({id, actorId});
          else if (button.dataset.action === 'roll') await rollNightmareSave({id, actorId});
          else {
            await settleNightmareResult({id, actorId, outcome: getForm(this).get(`outcome-${actorId}`)});
            await this.close(); await showResults(id);
          }
        } catch (error) { fail(error); }
        finally { button.disabled = false; }
      }));
    }
  }
  return ResultsDialog.wait({window: {title: '意志豁免结算'}, position: {width: 650}, classes: ['bob-companion'],
    content: `<p>已确认睡眠；第 ${record.chapter} 章 · DC ${record.dc} · ${readableTime(record.at)}</p>${notice('大成功只登记清醒梦研究机会；研究继续使用既有研究场景与来源额度。')}${rows}`,
    buttons: [{action: 'close', label: '关闭'}], rejectClose: false});
}

async function correctionDialog() {
  requirePrimaryGM();
  const chapter = officialChapter() ?? 1;
  const result = await foundry.applications.api.DialogV2.wait({window: {title: '校准已有战役记录'}, classes: ['bob-companion'], position: {width: 550},
    content: notice('仅校准助手账本。已存在的原生效果请在角色卡上核对；此处不会自动补加或删除恐惧症。') +
      formRow('角色', `<select name="actor">${partyMembers().map(a => option(a.id, a.name)).join('')}</select>`) +
      formRow('章节', `<select name="chapter">${Object.keys(NIGHTMARE_CHAPTERS).filter(ch => Number(ch) <= chapter).map(ch => option(ch, `第 ${ch} 章`, Number(ch) === chapter)).join('')}</select>`) +
      '<label><input name="phobia" type="checkbox" checked> 该角色已受过所选章节恐惧症</label><br><label><input name="clear" type="checkbox"> 清除待消费惊惧加值（诅咒已移除或已手动处理）</label><br>' +
      '<label><input name="first" type="checkbox"> 同时标记当前及之前章节首夜已处理</label>',
    buttons: [{action: 'save', label: '保存校准', callback: (_e, _b, d) => Object.fromEntries(getForm(d))}, {action: 'cancel', label: '取消'}], rejectClose: false});
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
  if (!game.user.isGM) throw new Error('休息助手仅供 GM 使用。');
  const state = readState(DOMAIN), chapter = officialChapter(), primary = isPrimaryGM();
  const pending = Object.values(state.sessions ?? {}).filter(s => ['pending', 'awaiting-results'].includes(s.status));
  const actors = partyMembers();
  const body = `<p>${primary ? '当前主 GM 可执行结算。' : '只读：请由当前主 GM 执行。'} ${state.enabled === false ? '自动休息接入已暂停。' : ''}</p>` +
    `<p>官方最新已解锁章节：${chapter ?? '不可用；确认睡眠时手动指定'}。${state.initialized ? `首夜：${state.firstNightHandled ? '已处理' : '尚未处理'}` : '尚未初始化；不会自动消耗第一晚。'}</p>` +
    notice('只接入已完成的原生休息；睡眠名单由 GM 确认。不会重复恢复资源或推进时间。') +
    (primary ? `<p>${!state.initialized ? '<button type="button" data-action="setup">初始化</button>' : '<button type="button" data-action="manual">登记已完成的睡眠</button><button type="button" data-action="correct">校准记录</button>'}<button type="button" data-action="toggle">${state.enabled === false ? '恢复自动接入' : '暂停自动接入'}</button></p>` : '') +
    '<h3>休息待办</h3>' + (pending.length ? pending.map(s => `<p>${esc(s.actorIds.map(id => game.actors.get(id)?.name ?? id).join('、'))} · ${readableTime(s.at)} · ${s.status === 'pending' ? '待确认睡眠' : '待结算意志'} ${primary ? `<button type="button" data-action="rest" data-id="${esc(s.id)}">处理</button>` : ''}</p>`).join('') : '<p>没有未处理的休息。</p>') +
    '<h3>角色记录</h3>' + actors.map(actor => {
      const pc = state.characters?.[actor.id], curse = pendingFrightened(state, actor.id, now()), recovering = pc?.frightenedAction?.status === 'applying';
      return `<p><strong>${esc(actor.name)}</strong> · 本章恐惧症：${pc?.chapters?.[chapter]?.phobiaAt !== undefined ? '已受过' : '未登记'} · ${curse ? `首次惊惧 +1 待消费（余 ${Math.ceil((curse.until - now()) / 3600)} 小时）` : '没有待消费惊惧'}${primary && (curse || recovering) ? ` <button type="button" data-action="fear" data-actor="${esc(actor.id)}">${recovering ? '恢复惊惧结算' : '首次惊惧 +1'}</button>` : ''}</p>`;
    }).join('');
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
              if (recovering || await foundry.applications.api.DialogV2.confirm({window: {title: '确认首次获得惊惧'}, content: '<p>先按实际来源施加惊惧。这确实是此诅咒生效后第一次获得惊惧时，将当前值增加 1 并消费本次加值。</p>'})) await consumeNightmareFrightened({actorId: button.dataset.actor});
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
  return NightmaresDialog.wait({window: {title: 'BoB｜休息与噩梦'}, position: {width: 700}, classes: ['bob-companion'], content: body,
    buttons: [{action: 'close', label: '关闭'}], rejectClose: false});
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
  if (context?.type !== 'saving-throw' || !Object.hasOwn(outcomes, context.outcome)) return;
  const marker = Array.from(context.options ?? []).find(o => typeof o === 'string' && o.startsWith('bob-nightmare:'));
  if (!marker) return;
  const id = marker.slice('bob-nightmare:'.length), actorId = message.speaker?.actor;
  const record = readState(DOMAIN).sessions?.[id];
  if (!record?.nightmare || !record.actorIds.includes(actorId) || record.results?.[actorId]) return;
  await updateState(DOMAIN, state => {
    const current = state.sessions?.[id];
    if (current && !current.results?.[actorId]) (current.suggestions ??= {})[actorId] = {outcome: context.outcome, messageId: message.id};
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
