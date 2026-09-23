import {t} from './i18n.mjs';
import {ID, OFFICIAL, MAIN_SCENE, environmentAt, classifyRole, nativeRules, knownSkyEffect} from './model.mjs';
import {resolveScope, isManagedSkyRule, shouldManageWeather, endStorm} from './context.mjs';

export const DEFAULT_CONFIG = Object.freeze({enabled: true, chapter: 0, phase: 'auto', rain: 'auto', rainBreak: [780, 870], weather: true, stormEnded: false});
const TARGET = 'CONFIG.Actor.documentClass.prototype.prepareRuleElements';
const touched = new Map();
const preparing = new WeakSet();
const preparedSignatures = new WeakMap();
const pendingActors = new Set();
let installed = false;
let registered = false;
let refreshTimer;
let fullRefreshPending = false;
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
    ? `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` : t('Common.Unknown')};
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
  if (!actor) return {...empty, reason: t('Environment.SelectActor')};
  const officialEffects = Array.from(actor.items ?? []).flatMap(item => {
    const chapter = knownSkyEffect(item);
    return chapter ? [{id: item.id, name: item.name, chapter}] : [];
  });
  const result = {...empty, officialEffects};
  if (!settings.enabled) return {...result, reason: officialEffects.length ? t('Environment.DisabledNative') : t('Environment.Disabled')};
  if (!environment.valid) return {...result, reason: t('Environment.InvalidClock')};
  if (!['character', 'npc'].includes(actor.type)) return {...result, reason: t('Environment.ActorType')};

  const activeScene = game.scenes?.active;
  const token = actor.isToken ? actor.token : null;
  if (actor.isToken && (!token || token.actorLink || token.actorId !== actor.id)) {
    return {...result, reason: t('Environment.DetachedActor')};
  }
  const tokens = token ? [token] : Array.from(activeScene?.tokens ?? []).filter(document => document.actorLink && document.actorId === actor.id);
  const sceneId = token?.parent?.id ?? tokens[0]?.parent?.id ?? flags(actor).sceneId;
  const scene = game.scenes?.get(sceneId);
  const scope = resolveScope({isToken: actor.isToken, tokenId: token?.id, tokens: tokens.map(tokenData),
    scenes: scene ? [sceneData(scene)] : [], activeSceneId: activeScene?.id,
    actorFlags: flags(actor), mainSceneId: MAIN_SCENE});
  Object.assign(result, {sceneId: scope.sceneId, exposure: scope.exposure, perception: scope.perception, reason: scope.reason});
  if (!scope.enabled) return result;
  const role = classifyRole({type: actor.type, owned: actor.hasPlayerOwner, alliance: actor.system.details?.alliance,
    dispositions: scope.dispositions, traits: actor.system.traits?.value ?? [], override: scope.roleOverride});
  result.role = role;
  if (role === 'ignore') return {...result, reason: t('Environment.ExcludedActor')};
  result.enabled = true;
  result.managedWeather = shouldManageWeather({enabled: scope.enabled, weather: settings.weather,
    exposure: scope.exposure, stormEnded: settings.stormEnded});
  if (settings.stormEnded && result.managedWeather && scope.exposure === 'unknown') {
    result.reason = t('Environment.StormEndedUnknown');
  }
  result.rules = nativeRules({environment, role, exposure: result.managedWeather ? scope.exposure : 'unknown', perception: scope.perception});
  if (role === 'unknown') result.reason = [result.reason, t('Environment.UnknownRole')].filter(Boolean).join(' ');
  if (officialEffects.length && !result.managedWeather) result.reason = [result.reason, t('Environment.NativeWeather')].filter(Boolean).join(' ');
  return result;
}

export function status(actor) {
  actor ??= globalThis.canvas?.tokens?.controlled?.[0]?.actor ?? globalThis.game?.user?.character;
  const result = actorStatus(actor);
  if (lastError) result.reason = [result.reason, lastError].filter(Boolean).join(' ');
  if (globalThis.game?.ready && !installed) return {...result, enabled: false, rules: [], managedWeather: false,
    reason: t('Environment.NotReady')};
  return result;
}

// Only changes to the rules we add/suppress require another native preparation.
function ruleSignature(state) {
  return JSON.stringify([state.enabled, state.managedWeather, state.rules]);
}

function prepareRules(wrapped, ...args) {
  const original = wrapped(...args);
  if (preparing.has(this)) return original;
  preparing.add(this);
  try {
    const state = actorStatus(this);
    if (!state.enabled) {
      preparedSignatures.set(this, ruleSignature(state));
      return original;
    }
    let additional = [];
    if (state.rules.length) {
      const source = {name: t('Environment.EffectName'), type: 'effect', img: 'systems/pf2e/icons/default-icons/effect.svg',
        flags: {[ID]: {transient: true}}, system: {slug: 'bob-companion-environment', duration: {unit: 'unlimited', value: -1, expiry: null},
          tokenIcon: {show: false}, rules: state.rules}};
      const effect = new CONFIG.PF2E.Item.documentClasses.effect(source, {parent: this});
      additional = effect.prepareRuleElements();
      if (additional.length !== state.rules.length || additional.some(rule => rule.invalid)) throw new Error(t('Environment.InvalidRules'));
    }
    // Filter the prepared rule list, never the existing item's source or system.rules.
    const retained = state.managedWeather ? original.filter(rule =>
      !(knownSkyEffect(rule.item) && isManagedSkyRule(rule))) : original;
    // token.delta is lazy and may construct another synthetic actor while this one
    // is still being prepared. Never dereference it to establish identity here.
    if (this.uuid && (game.actors.get(this.id) === this || this.isToken)) {
      touched.set(this.uuid, new WeakRef(this));
    }
    const rules = [...retained, ...additional].filter(rule => !rule.ignored).sort((a, b) => a.priority - b.priority);
    preparedSignatures.set(this, ruleSignature(state));
    return rules;
  } catch (error) {
    lastError = t('Environment.PrepareFailed');
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
  clearTimeout(refreshTimer);
  fullRefreshPending = false;
  pendingActors.clear();
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

function flushRefresh() {
  if (fullRefreshPending) return refresh();
  const actors = [...pendingActors];
  pendingActors.clear();
  if (!globalThis.game?.ready || !installed || !config().enabled) return;
  let changed = false;
  for (const actor of actors) {
    if (preparing.has(actor)) continue;
    try {
      const state = actorStatus(actor);
      if (!state.enabled && !preparedSignatures.has(actor)) continue;
      if (preparedSignatures.get(actor) === ruleSignature(state)) continue;
      actor.reset();
      actor.render?.(false);
      changed = true;
    } catch (error) { console.error(`${ID} | 无法刷新 ${actor.uuid}`, error); }
  }
  if (changed) Hooks.callAll(`${ID}.refresh`, getEnvironment());
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(flushRefresh, 50);
}

function queueRefresh() {
  fullRefreshPending = true;
  scheduleRefresh();
}

function queueTokenRefresh(token) {
  if (!globalThis.game?.ready || !installed || !config().enabled) return;
  // Never construct a synthetic actor merely because its token moved.
  const actor = token.actorLink ? game.actors.get(token.actorId) : token.hasConstructedActor ? token.actor : null;
  if (!actor) return;
  pendingActors.add(actor);
  scheduleRefresh();
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

function hasModuleFlagsChange(changes) {
  const namespace = key => key.split('.')[0].replace(/^-=/, '');
  for (const [key, value] of Object.entries(changes)) {
    if (key === '-=flags') return true;
    if (key.startsWith('flags.')) {
      if (namespace(key.slice(6)) === ID) return true;
    } else if (key === 'flags') {
      // A whole flags replacement/deletion may remove our former namespace.
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return true;
      if (Object.keys(value).some(key => namespace(key) === ID)) return true;
    }
  }
  return false;
}

export function registerRuntime() {
  if (registered) return;
  registered = true;
  const module = game.modules.get(ID);
  if (module) module.api = {...module.api, status, refresh, getEnvironment};
  game.settings.register(ID, 'config', {name: t('Environment.Settings'), scope: 'world', config: false, type: Object,
    default: {...DEFAULT_CONFIG, rainBreak: [...DEFAULT_CONFIG.rainBreak]}, onChange: queueRefresh});
  Hooks.once('ready', () => {
    if (game.system.id !== 'pf2e' || !globalThis.libWrapper || !CONFIG.PF2E?.Item?.documentClasses?.effect) {
      console.error(`${ID} | 需要 PF2e 和 libWrapper。`);
      if (game.user.isGM) ui.notifications.warn(t('Environment.Dependencies'));
      return;
    }
    try { libWrapper.register(ID, TARGET, prepareRules, 'WRAPPER'); }
    catch (error) {
      lastError = t('Environment.WrapperFailed');
      console.error(`${ID} | ${lastError}`, error);
      if (game.user.isGM) ui.notifications.error(lastError);
      return;
    }
    installed = true;
    refresh();
    if (game.user.isGM && !getEnvironment().valid) ui.notifications.warn(t('Environment.CheckSettings'));
  });
  Hooks.on('updateWorldTime', () => { if (environmentKey() !== lastEnvironmentKey) queueRefresh(); });
  Hooks.on('updateSetting', setting => {
    if ([`${OFFICIAL}.campaign`, 'pf2e.worldClock'].includes(setting.key)) queueRefresh();
  });
  Hooks.on('updateScene', (_scene, changes) => { if (hasChange(changes, ['active']) || hasModuleFlagsChange(changes)) queueRefresh(); });
  for (const hook of ['canvasReady', 'createScene', 'deleteScene', 'createToken', 'deleteToken', 'createRegion', 'deleteRegion']) Hooks.on(hook, queueRefresh);
  Hooks.on('updateToken', (token, changes) => {
    if (hasChange(changes, ['actorId', 'actorLink', 'disposition']) || hasModuleFlagsChange(changes)) queueRefresh();
    else if (hasChange(changes, ['x', 'y', 'elevation', 'regions', '_regions'])) queueTokenRefresh(token);
  });
  Hooks.on('updateRegion', (_region, changes) => { if (hasChange(changes, ['shapes', 'elevation', 'disabled']) || hasModuleFlagsChange(changes)) queueRefresh(); });
  Hooks.on('updateActor', (_actor, changes) => { if (hasChange(changes, [`flags.${ID}`, 'ownership', 'system.details.alliance', 'system.traits.value'])) queueRefresh(); });
}
