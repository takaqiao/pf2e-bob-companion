import {ID, OFFICIAL, MAIN_SCENE, environmentAt, classifyRole, nativeRules, knownSkyEffect} from './model.mjs';
import {resolveScope, isManagedSkyRule, shouldManageWeather, endStorm} from './context.mjs';

export const DEFAULT_CONFIG = Object.freeze({enabled: true, chapter: 0, phase: 'auto', rain: 'auto', rainBreak: [780, 870], weather: true, stormEnded: false});
const TARGET = 'CONFIG.Actor.documentClass.prototype.prepareRuleElements';
const touched = new Map();
const preparing = new WeakSet();
let installed = false;
let registered = false;
let refreshTimer;
let lastEnvironmentKey;
let lastError = null;
let errorNotified = false;

function config() {
  try { return {...DEFAULT_CONFIG, ...game.settings.get(ID, 'config')}; }
  catch { return {...DEFAULT_CONFIG}; }
}

/** Read the native PF2e clock and official CampaignData without changing either. */
export function getEnvironment() {
  const settings = config();
  let chapter = Number(settings.chapter);
  const chapterSource = chapter > 0 ? 'manual' : 'campaign';
  if (!chapter) {
    try { chapter = game.settings.get(OFFICIAL, 'campaign')?.activeArea?.chapter; }
    catch { chapter = undefined; }
  }
  const clock = globalThis.game?.pf2e?.worldClock?.worldTime;
  const seconds = clock?.isValid !== false && Number.isFinite(clock?.hour) && Number.isFinite(clock?.minute)
    ? clock.hour * 3600 + clock.minute * 60 + (Number.isFinite(clock.second) ? clock.second : 0) : NaN;
  let environment = environmentAt({chapter, seconds, phase: settings.phase, rain: settings.rain, rainBreak: settings.rainBreak});
  if (settings.stormEnded) environment = endStorm(environment);
  return {...environment, stormEnded: Boolean(settings.stormEnded), chapter, chapterSource, seconds, time: Number.isFinite(seconds)
    ? `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` : '未知'};
}

const flags = document => document?.flags?.[ID] ?? {};
const sceneData = scene => ({id: scene.id, ...flags(scene)});

function tokenData(token) {
  // Never read token.actor here: this function runs during that actor's preparation.
  return {id: token.id, sceneId: token.parent?.id, actorLink: token.actorLink,
    disposition: token.disposition, ...flags(token), regions: Array.from(token.regions ?? [], region => flags(region))};
}

function actorStatus(actor) {
  const environment = getEnvironment();
  const settings = config();
  const empty = {environment, enabled: false, sceneId: null, reason: '', role: 'unknown', exposure: 'unknown',
    perception: 'auto', rules: [], managedWeather: false, officialEffects: []};
  if (!actor) return {...empty, reason: '请选择 token 或角色查看适用状态。'};
  const officialEffects = Array.from(actor.items ?? []).flatMap(item => {
    const chapter = knownSkyEffect(item);
    return chapter ? [{id: item.id, name: item.name, chapter}] : [];
  });
  const result = {...empty, officialEffects};
  if (!settings.enabled) return {...result, reason: officialEffects.length ? '伴随模组已停用；现有 Skies Above 物品恢复自身规则。' : '伴随模组已停用。'};
  if (!environment.valid) return {...result, reason: '章节或 PF2e 世界钟不可用；请设置章节并检查世界钟。'};
  if (!['character', 'npc'].includes(actor.type)) return {...result, reason: '仅对人物和 NPC 处理检定修正。'};

  const activeScene = game.scenes?.active;
  const token = actor.isToken ? actor.token : null;
  const tokens = token ? [token] : Array.from(activeScene?.tokens ?? []).filter(document => document.actorLink && document.actorId === actor.id);
  const scope = resolveScope({isToken: actor.isToken, tokenId: token?.id, tokens: tokens.map(tokenData),
    scenes: Array.from(game.scenes ?? [], sceneData), activeSceneId: activeScene?.id,
    actorFlags: flags(actor), mainSceneId: MAIN_SCENE});
  Object.assign(result, {sceneId: scope.sceneId, exposure: scope.exposure, perception: scope.perception, reason: scope.reason});
  if (!scope.enabled) return result;
  const role = classifyRole({type: actor.type, owned: actor.hasPlayerOwner, alliance: actor.system.details?.alliance,
    dispositions: scope.dispositions, traits: actor.system.traits?.value ?? [], override: scope.roleOverride});
  result.role = role;
  if (role === 'ignore') return {...result, reason: '此角色已明确排除。'};
  result.enabled = true;
  result.managedWeather = shouldManageWeather({enabled: scope.enabled, weather: settings.weather,
    exposure: scope.exposure, stormEnded: settings.stormEnded});
  if (settings.stormEnded && result.managedWeather && scope.exposure === 'unknown') {
    result.reason = '已明确风暴结束；在此适用场景中停用旧天气规则，暴露仍待确认。';
  }
  result.rules = nativeRules({environment, role, exposure: result.managedWeather ? scope.exposure : 'unknown', perception: scope.perception});
  if (role === 'unknown') result.reason = [result.reason, '角色身份未确认，未应用 PC/敌人夜幕修正。'].filter(Boolean).join(' ');
  if (officialEffects.length && !result.managedWeather) result.reason = [result.reason, '现有 Skies Above 效果保留原有规则。'].filter(Boolean).join(' ');
  return result;
}

export function status(actor) {
  actor ??= globalThis.canvas?.tokens?.controlled?.[0]?.actor ?? globalThis.game?.user?.character;
  const result = actorStatus(actor);
  if (lastError) result.reason = [result.reason, lastError].filter(Boolean).join(' ');
  if (globalThis.game?.ready && !installed) return {...result, enabled: false, rules: [], managedWeather: false,
    reason: '规则包装尚未启用；请检查 PF2e 与 libWrapper。'};
  return result;
}

function prepareRules(wrapped, ...args) {
  const original = wrapped(...args);
  if (preparing.has(this)) return original;
  preparing.add(this);
  try {
    const state = actorStatus(this);
    if (!state.enabled) return original;
    let additional = [];
    if (state.rules.length) {
      const source = {name: 'BoB：昼夜与章节环境', type: 'effect', img: 'systems/pf2e/icons/default-icons/effect.svg',
        flags: {[ID]: {transient: true}}, system: {slug: 'bob-companion-environment', duration: {unit: 'unlimited', value: -1, expiry: null},
          tokenIcon: {show: false}, rules: state.rules}};
      const effect = new CONFIG.PF2E.Item.documentClasses.effect(source, {parent: this});
      additional = effect.prepareRuleElements();
      if (additional.length !== state.rules.length || additional.some(rule => rule.invalid)) throw new Error('临时规则未通过 PF2e 验证');
    }
    // Filter the prepared rule list, never the existing item's source or system.rules.
    const retained = state.managedWeather ? original.filter(rule =>
      !(knownSkyEffect(rule.item) && isManagedSkyRule(rule))) : original;
    // token.delta is lazy and may construct another synthetic actor while this one
    // is still being prepared. Never dereference it to establish identity here.
    if (this.uuid && (game.actors.get(this.id) === this || this.isToken)) {
      touched.set(this.uuid, new WeakRef(this));
    }
    return [...retained, ...additional].filter(rule => !rule.ignored).sort((a, b) => a.priority - b.priority);
  } catch (error) {
    lastError = 'BoB 临时规则准备失败；已保留角色原有规则。';
    console.error(`${ID} | ${lastError}`, error);
    if (game.user?.isGM && !errorNotified) {
      errorNotified = true;
      ui.notifications.error(lastError);
    }
    return original;
  } finally { preparing.delete(this); }
}

/** Reset already relevant/constructed actors only. This never writes a document. */
export function refresh() {
  if (!globalThis.game?.ready || !installed) return;
  lastEnvironmentKey = environmentKey();
  lastError = null;
  const actors = new Set(Array.from(touched.values(), ref => ref.deref()).filter(Boolean));
  const active = game.scenes?.active;
  for (const actor of game.actors ?? []) {
    if (flags(actor).sceneId || Array.from(active?.tokens ?? []).some(token => token.actorLink && token.actorId === actor.id)) actors.add(actor);
  }
  for (const scene of game.scenes ?? []) {
    if (scene.id !== MAIN_SCENE && flags(scene).scope !== 'include') continue;
    for (const token of scene.tokens ?? []) {
      if (!token.actorLink && token.hasConstructedActor) {
        const actor = token.actor;
        if (actor) actors.add(actor);
      }
    }
  }
  touched.clear();
  for (const actor of actors) {
    if (preparing.has(actor)) continue;
    try { actor.reset(); actor.render?.(false); }
    catch (error) { console.error(`${ID} | 无法刷新 ${actor.uuid}`, error); }
  }
  Hooks.callAll(`${ID}.refresh`, getEnvironment());
}

function queueRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 50);
}

function environmentKey() {
  const environment = getEnvironment();
  return JSON.stringify([config(), environment.valid, environment.chapter, environment.night, environment.fog,
    environment.raining, environment.perception, environment.ranged]);
}

function hasChange(changes, names) {
  return names.some(name => Object.keys(changes).some(key => key === name || key.startsWith(`${name}.`))
    || name.split('.').reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, changes) !== undefined);
}

export function registerRuntime() {
  if (registered) return;
  registered = true;
  const module = game.modules.get(ID);
  if (module) module.api = {...module.api, status, refresh, getEnvironment};
  game.settings.register(ID, 'config', {name: 'BoB 环境设置', scope: 'world', config: false, type: Object,
    default: {...DEFAULT_CONFIG, rainBreak: [...DEFAULT_CONFIG.rainBreak]}, onChange: queueRefresh});
  Hooks.once('ready', () => {
    if (game.system.id !== 'pf2e' || !globalThis.libWrapper || !CONFIG.PF2E?.Item?.documentClasses?.effect) {
      console.error(`${ID} | 需要 PF2e 和 libWrapper。`);
      if (game.user.isGM) ui.notifications.warn('BoB 伴随模组未启用：需要 PF2e 与 libWrapper。');
      return;
    }
    try { libWrapper.register(ID, TARGET, prepareRules, 'WRAPPER'); }
    catch (error) {
      lastError = 'BoB 规则接口注册失败，请检查版本兼容性。';
      console.error(`${ID} | ${lastError}`, error);
      if (game.user.isGM) ui.notifications.error(lastError);
      return;
    }
    installed = true;
    refresh();
    if (game.user.isGM && !getEnvironment().valid) ui.notifications.warn('BoB 伴随模组：章节或 PF2e 世界钟不可用，请打开设置检查。');
  });
  Hooks.on('updateWorldTime', () => { if (environmentKey() !== lastEnvironmentKey) queueRefresh(); });
  Hooks.on('updateSetting', setting => {
    if ([`${OFFICIAL}.campaign`, 'pf2e.worldClock'].includes(setting.key)) queueRefresh();
  });
  Hooks.on('updateScene', (_scene, changes) => { if (hasChange(changes, ['active', 'flags'])) queueRefresh(); });
  for (const hook of ['canvasReady', 'createScene', 'deleteScene', 'createToken', 'deleteToken', 'createRegion', 'deleteRegion']) Hooks.on(hook, queueRefresh);
  Hooks.on('updateToken', (_token, changes) => { if (hasChange(changes, ['flags', 'actorId', 'actorLink', 'disposition', 'x', 'y', 'elevation', 'regions'])) queueRefresh(); });
  Hooks.on('updateRegion', (_region, changes) => { if (hasChange(changes, ['flags', 'shapes', 'elevation', 'disabled'])) queueRefresh(); });
  Hooks.on('updateActor', (_actor, changes) => { if (hasChange(changes, [`flags.${ID}`, 'ownership', 'system.details.alliance', 'system.traits.value'])) queueRefresh(); });
}
