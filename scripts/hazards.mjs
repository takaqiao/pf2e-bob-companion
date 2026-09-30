import { ID } from './model.mjs';
import { t, localizeHTML } from './i18n.mjs';
import { upsertGMCard, registerCardActions } from './chat-cards.mjs';
import {
  isPrimaryGM,
  requirePrimaryGM,
  now,
  escapeHtml as esc,
  readState,
  updateState,
  withAction,
  whisperGM,
  partyMembers
} from './assistant-core.mjs';
import {
  setMembership,
  advanceHazards,
  resolveFoul,
  requestFoul,
  resolveLightning,
  removeTrackedToken
} from './hazard-model.mjs';
const DOMAIN = 'hazards',
  labels = () => ({
    dungeon: t('Hazard.Dungeon'),
    foul: t('Hazard.FoulAir'),
    tower: t('Hazard.Tower')
  });
const report = (error) => ui.notifications.error(error.message);
const stormEnded = () => !!game.settings.get(ID, 'config')?.stormEnded;
const enabled = () => game.settings.get(ID, 'config')?.enabled !== false;
async function change(mutator, {publish = true} = {}) {
  let previous, changed;
  const result = await updateState(DOMAIN, (s) => {
    previous = structuredClone(s.requests ?? {});
    mutator(s);
    // The same actor/request key can recur at the same world time. A persisted generation
    // prevents old rolls and old chat buttons from settling a later exposure.
    for (const [key, request] of Object.entries(s.requests ?? {})) if (!request.id) {
      if (request.kind === 'lightning' && previous[key]?.id) {
        request.id = previous[key].id;
        continue;
      }
      s.requestSerial = (s.requestSerial ?? 0) + 1;
      request.id = `${key}:${s.requestSerial}`;
    }
    changed = JSON.stringify(previous) !== JSON.stringify(s.requests ?? {});
  });
  if (changed && publish) await refreshHazardCards(previous);
  return result;
}
function membership(token, state, recalculate = false) {
  const actor = game.actors.get(token.actorId);
  if (actor?.type !== 'character' || !actor.hasPlayerOwner) return null;
  const members = new Set(partyMembers().map((a) => a.uuid));
  if (!members.has(actor.uuid)) return null;
  const regions = recalculate
    ? Array.from(token.parent.regions ?? []).filter(
        (r) => state.bindings?.[r.uuid] && token.testInsideRegion(r)
      )
    : Array.from(token.regions ?? []);
  const types = regions.map((r) => state.bindings?.[r.uuid]).filter(Boolean);
  if (!recalculate && !token.regions)
    for (const id of token._source?._regions ?? []) {
      const type = state.bindings?.[`Scene.${token.parent.id}.Region.${id}`];
      if (type) types.push(type);
    }
  return {
    tokenUuid: token.uuid,
    actorUuid: actor.uuid,
    sceneId: token.parent.id,
    name: actor.name,
    types
  };
}
export async function trackHazardToken(token, { recalculate = false } = {}) {
  if (!isPrimaryGM() || !enabled()) return;
  const state = readState(DOMAIN);
  if (!Object.keys(state.bindings ?? {}).length && !state.tokens?.[token.uuid]) return;
  const data =
    token.parent?.id === game.scenes.active?.id ? membership(token, state, recalculate) : null;
  if (!data) {
    if (state.tokens?.[token.uuid]) await change((s) => removeTrackedToken(s, token.uuid, now()));
    return;
  }
  if (!data.types.length && !state.tokens?.[token.uuid]) return;
  await change((s) => {
    advanceHazards(s, now(), { stormEnded: stormEnded() });
    setMembership(s, data, now());
  });
}
export async function refreshHazards({ recalculate = false } = {}) {
  requirePrimaryGM();
  if (!enabled()) return;
  const state = readState(DOMAIN);
  if (
    !Object.keys(state.bindings ?? {}).length &&
    !Object.keys(state.tokens ?? {}).length &&
    !Object.keys(state.actors ?? {}).length &&
    !state.lightning
  )
    return;
  for (const [uuid, record] of Object.entries(state.tokens ?? {}))
    if (record.sceneId !== game.scenes.active?.id || !(await fromUuid(uuid)))
      await change((s) => removeTrackedToken(s, uuid, now()));
  const scene = game.scenes.active;
  if (
    scene &&
    (Object.keys(state.bindings ?? {}).some((key) => key.startsWith(`${scene.uuid}.`)) ||
      Object.keys(state.tokens ?? {}).length)
  )
    for (const token of scene.tokens) await trackHazardToken(token, { recalculate });
  await change((s) => advanceHazards(s, now(), { stormEnded: stormEnded() }));
}
export async function bindHazardRegion(regionUuid, type) {
  requirePrimaryGM();
  const region = await fromUuid(regionUuid);
  if (region?.documentName !== 'Region' || (type && !Object.hasOwn(labels(), type)))
    throw new Error(t('Hazard.InvalidRegion'));
  await updateState(DOMAIN, (s) => {
    s.bindings ??= {};
    if (type) s.bindings[regionUuid] = type;
    else delete s.bindings[regionUuid];
  });
  // Removing the final binding must also clear previously tracked exposure.
  for (const token of region.parent.tokens) await trackHazardToken(token);
}
async function resolveAir(actorUuid, success) {
  return withAction(`foul:${actorUuid}`, () =>
    change((s) => {
      if (!s.requests?.[`foul:${actorUuid}`]) throw new Error(t('Hazard.AlreadyHandled'));
      resolveFoul(s, actorUuid, success, now());
    })
  );
}
export async function rollAir(input) {
  requirePrimaryGM();
  if (!enabled()) throw new Error(t('Hazard.Chat.Paused'));
  const actorUuid = typeof input === 'string' ? input : input.actorUuid;
  if (!readState(DOMAIN).requests?.[`foul:${actorUuid}`]?.id) await change(() => {});
  const request = readState(DOMAIN).requests?.[`foul:${actorUuid}`];
  if (!request || input.id && input.id !== request.id || request.suggestion)
    throw new Error(t('Hazard.Chat.Stale'));
  const actor = await fromUuid(actorUuid);
  if (!actor?.saves?.fortitude) throw new Error(t('Hazard.NoFortitude'));
  if (airRolls.has(request.id)) throw new Error(t('Hazard.Chat.RollPending'));
  airRolls.add(request.id);
  try {return await actor.saves.fortitude.roll({ dc: { value: 25 }, messageMode: 'gm',
    extraRollOptions: [`bob-hazard:${request.id}`] });}
  finally {airRolls.delete(request.id);}
}
export async function rollLightning({id} = {}) {
  return withAction('lightning:roll', async () => {
    if (!enabled()) throw new Error(t('Hazard.Chat.Paused'));
    const pending = readState(DOMAIN).requests?.lightning;
    if (!pending || id && id !== pending.id) throw new Error(t('Hazard.NoLightning'));
    const roll = await new Roll('1d20').evaluate();
    await roll.toMessage(
      {
        flavor: localizeHTML('Hazard.FlatCheck'),
        whisper: game.users.filter((u) => u.isGM).map((u) => u.id)
      },
      { rollMode: 'gmroll' }
    );
    await change((s) => {
      if (!s.requests?.lightning) return;
      if (s.requests.lightning.count > 1) s.requests.lightning.count--;
      else resolveLightning(s);
    });
    if (roll.total >= 17) await whisperGM(localizeHTML('Hazard.LightningHit'));
    return roll.total;
  });
}
const airRolls = new Set();
const arrivingAirResults = new Map();
const outcomes = new Set(['criticalSuccess', 'success', 'failure', 'criticalFailure']);
const successOutcome = outcome => outcome === 'success' || outcome === 'criticalSuccess';
const cardButton = (action, key, {actorUuid, messageId} = {}) =>
  `<button type="button" data-bob-card-action="${action}"${actorUuid ? ` data-actor="${esc(actorUuid)}"` : ''}${messageId ? ` data-message-id="${esc(messageId)}"` : ''}>${localizeHTML(key)}</button>`;

async function hazardCard(request, completed = false) {
  let content;
  if (request.kind === 'foul') {
    const actor = fromUuidSync(request.actorUuid), suggestion = request.suggestion;
    const captured = suggestion ? `<p>${localizeHTML('Hazard.Chat.Captured', {}, {
      outcome:`Nightmare.Outcome${suggestion.outcome[0].toUpperCase()}${suggestion.outcome.slice(1)}`
    })}</p>` : `<p>${localizeHTML('Hazard.Fortitude')}</p>`;
    const action = completed ? `<p>${localizeHTML('Hazard.Chat.Handled')}</p>` : suggestion ?
      (successOutcome(suggestion.outcome) ? cardButton('air-apply', 'Hazard.Chat.Apply', {actorUuid: request.actorUuid, messageId: suggestion.messageId}) :
        `<p>${localizeHTML('Hazard.Chat.FailureHelp')}</p>` + cardButton('air-handled', 'Hazard.Chat.ConfirmConsequences', {actorUuid: request.actorUuid, messageId: suggestion.messageId})) :
      cardButton('air-roll', 'Hazard.Roll', {actorUuid: request.actorUuid}) + cardButton('air-unexposed', 'Hazard.Chat.Unexposed', {actorUuid: request.actorUuid});
    content = `<h3>${localizeHTML('Hazard.Chat.Air', {actor: actor?.name ?? t('Common.Actor')})}</h3>${captured}<div class="bob-toolbar">${action}</div>`;
  } else {
    const action = completed ? `<p>${localizeHTML('Hazard.Chat.Handled')}</p>` :
      `<p>${localizeHTML('Hazard.LightningCount', {count: request.count})}</p>` + cardButton('lightning-roll', 'Hazard.RollLightning');
    content = `<h3>${localizeHTML('Hazard.Lightning')}</h3><div class="bob-toolbar">${action}</div>`;
  }
  return upsertGMCard({domain: DOMAIN, id: request.id,
    content: `<section class="bob-companion bob-chat-card">${content}</section>`});
}

export async function refreshHazardCards(previous) {
  requirePrimaryGM();
  const recoverCards = previous === undefined;
  previous ??= {};
  const state = readState(DOMAIN), current = state.requests ?? {};
  for (const [key, request] of Object.entries(current))
    if (request.id && JSON.stringify(previous[key]) !== JSON.stringify(request)) await hazardCard(request);
  for (const [key, request] of Object.entries(previous))
    if (request.id && current[key]?.id !== request.id) await hazardCard(request, true);
  if (recoverCards) {
    // Repair only surviving receipt cards; do not recreate completed chat history at startup.
    const ids = new Set(Array.from(game.messages ?? []).map(message => message.flags?.[ID]?.chatCard)
      .filter(card => card?.domain === DOMAIN && state.airResults?.[card.id]).map(card => card.id));
    for (const id of ids) {
      const receipt = state.airResults[id];
      await hazardCard({id,kind:'foul',actorUuid:receipt.actorUuid,
        suggestion:{messageId:receipt.messageId,outcome:receipt.outcome}}, true);
    }
  }
}

export async function captureHazardRoll(message) {
  if (!isPrimaryGM() || !enabled()) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== 'saving-throw' || !outcomes.has(context.outcome)) return;
  const marker = Array.from(context.options ?? []).find(option => typeof option === 'string' && option.startsWith('bob-hazard:'));
  if (!marker) return;
  const id = marker.slice('bob-hazard:'.length), actorUuid = message.actor?.uuid ?? game.actors.get(message.speaker?.actor)?.uuid;
  const acceptable = request => request?.id === id && request.kind === 'foul' && request.actorUuid === actorUuid &&
    (!request.suggestion || context.isReroll === true && request.suggestion.messageId !== message.id);
  if (!acceptable(readState(DOMAIN).requests?.[`foul:${actorUuid}`])) return;
  if (!arrivingAirResults.has(id) || context.isReroll === true)
    arrivingAirResults.set(id, {outcome: context.outcome, messageId: message.id});
  await withAction(`foul:${actorUuid}`, () => change(draft => {
    const request = draft.requests?.[`foul:${actorUuid}`];
    if (acceptable(request)) request.suggestion = {outcome: context.outcome, messageId: message.id};
  }));
}

export async function applyAirResult({id, actorUuid, messageId, handled = false}) {
  return withAction(`foul:${actorUuid}`, async () => {
    if (!enabled()) throw new Error(t('Hazard.Chat.Paused'));
    const current = readState(DOMAIN), receipt = current.airResults?.[id];
    if (receipt && receipt.actorUuid === actorUuid && receipt.messageId === messageId) {
      return hazardCard({id,kind:'foul',actorUuid,suggestion:{messageId,outcome:receipt.outcome}}, true);
    }
    const request = current.requests?.[`foul:${actorUuid}`];
    if (request?.id !== id || request.suggestion?.messageId !== messageId) {
      await refreshHazardCards();
      throw new Error(t('Hazard.Chat.Stale'));
    }
    if (arrivingAirResults.get(id)?.messageId && arrivingAirResults.get(id).messageId !== messageId)
      throw new Error(t('Hazard.Chat.Stale'));
    const success = successOutcome(request.suggestion.outcome);
    if (!success && !handled) throw new Error(t('Hazard.Chat.Consequences'));
    if (!(await fromUuid(actorUuid))) throw new Error(t('Common.Actor'));
    const result = await change(draft => {
      const latest = draft.requests?.[`foul:${actorUuid}`];
      if (latest?.id !== id || latest.suggestion?.messageId !== messageId) throw new Error(t('Hazard.Chat.Stale'));
      (draft.airResults ??= {})[id] = {actorUuid, messageId, outcome: latest.suggestion.outcome, at: now()};
      resolveFoul(draft, actorUuid, success, now());
    }, {publish:false});
    const arriving = arrivingAirResults.get(id);
    if (arriving && arriving.messageId !== messageId) {
      // Unlike native Item writes, this transaction only changed the hazard ledger.
      // Restore its immunity fields without replacing concurrent token/exposure changes.
      await change(draft => {
        const receipt = draft.airResults?.[id], replacement = draft.requests?.[`foul:${actorUuid}`];
        if (receipt?.messageId !== messageId || replacement && replacement.id !== id) return;
        Object.assign(draft.actors[actorUuid], {immune: current.actors[actorUuid].immune,
          outsideSince: current.actors[actorUuid].outsideSince});
        draft.requests[`foul:${actorUuid}`] = {...request, suggestion: arriving};
        delete draft.airResults[id];
      }, {publish:false});
      await refreshHazardCards(current.requests);
      throw new Error(t('Hazard.Chat.Stale'));
    }
    arrivingAirResults.delete(id);
    await refreshHazardCards(current.requests);
    return result;
  });
}

async function handleHazardCard({action, id, actorId, button}) {
  if (action === 'air-roll') return rollAir({id, actorUuid: actorId});
  if (action === 'air-apply' || action === 'air-handled') return applyAirResult({id, actorUuid: actorId,
    messageId: button.dataset.messageId, handled: action === 'air-handled'});
  if (action === 'air-unexposed') return withAction(`foul:${actorId}`, () => change(draft => {
    if (!enabled()) throw new Error(t('Hazard.Chat.Paused'));
    if (draft.requests?.[`foul:${actorId}`]?.id !== id) throw new Error(t('Hazard.Chat.Stale'));
    resolveFoul(draft, actorId, false, now());
  }));
  if (action === 'lightning-roll') return rollLightning({id});
}
const options = (entries, current) =>
  entries
    .map(
      ([v, n]) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(n)}</option>`
    )
    .join('');
function airRequestHTML(request) {
  const actorId = request.actorUuid.split('.').at(-1);
  const name = game.actors.get(actorId)?.name ?? t('Common.Actor');
  return `
    <li>
      <strong>${esc(name)}</strong>
      <p class="hint">${t('Hazard.Fortitude')}</p>
      <div class="bob-toolbar">
        <button type="button" class="bob-primary" data-air="roll" data-actor="${esc(request.actorUuid)}">
          ${t('Hazard.Roll')}
        </button>
        <button type="button" data-air="success" data-actor="${esc(request.actorUuid)}">
          ${t('Hazard.Success')}
        </button>
        <button type="button" data-air="failure" data-actor="${esc(request.actorUuid)}">
          ${t('Hazard.Handled')}
        </button>
      </div>
    </li>`;
}

function body() {
  const state = readState(DOMAIN);
  const scene = canvas.scene;
  const regions = Array.from(scene?.regions ?? [], (region) => [region.uuid, region.name]);
  const air = Object.values(state.requests ?? {}).filter((request) => request.kind === 'foul');
  const lightning = state.requests?.lightning;
  const bindings = Object.entries(state.bindings ?? {})
    .map(
      ([uuid, type]) => `
    <li>${esc(fromUuidSync(uuid)?.name ?? t('Hazard.MissingRegion'))}: ${esc(labels()[type])}</li>
  `
    )
    .join('');
  const immune =
    Object.entries(state.actors ?? {})
      .filter(([, actor]) => actor.immune)
      .map(([uuid]) => esc(fromUuidSync(uuid)?.name ?? t('Common.Actor')))
      .join(', ') || t('Common.None');

  return `
    <p class="hint">${t('Hazard.Intro')}</p>
    <section class="bob-section" aria-labelledby="bob-air-heading">
      <h3 id="bob-air-heading">${t('Hazard.FoulAir')}</h3>
      ${
        air.length
          ? `<ul class="bob-record-list">${air.map(airRequestHTML).join('')}</ul>`
          : `<p class="bob-empty">${t('Hazard.NoAir')}</p>`
      }
    </section>
    <section class="bob-section" aria-labelledby="bob-lightning-heading">
      <h3 id="bob-lightning-heading">${t('Hazard.Lightning')}</h3>
      ${
        lightning
          ? `
        <p>${t('Hazard.LightningCount', { count: lightning.count })}</p>
        <div class="bob-toolbar">
          <button type="button" class="bob-primary" data-hazard="roll-lightning">
            ${t('Hazard.RollLightning')}
          </button>
          <button type="button" data-hazard="clear-lightning">${t('Hazard.ClearLightning')}</button>
        </div>`
          : `<p class="bob-empty">${t('Hazard.NoLightning')}</p>`
      }
    </section>
    <details>
      <summary>${t('Hazard.Setup')}</summary>
      <p>${t('Hazard.Scene', { name: esc(scene?.name ?? t('Common.NoScene')) })}</p>
      ${
        regions.length
          ? `
        <label class="bob-field">
          <span>${t('Hazard.Region')}</span>
          <select name="region">${options(regions, '')}</select>
        </label>
        <label class="bob-field">
          <span>${t('Hazard.Use')}</span>
          <select name="hazardType">${options([['', t('Hazard.Unbind')], ...Object.entries(labels())], '')}</select>
        </label>
        <div class="bob-toolbar">
          <button type="button" data-hazard="bind">${t('Common.Save')}</button>
        </div>`
          : `<p>${t('Hazard.DrawRegion')}</p>`
      }
      ${bindings ? `<ul>${bindings}</ul>` : ''}
      <p>${t('Hazard.Immunity')}: ${immune}</p>
      <p class="hint">${t('Hazard.TimerHint')}</p>
    </details>
    <p class="bob-warning" data-error role="alert"></p>`;
}

let opening, activeWindow;
export function openHazards() {
  if (opening) {
    activeWindow?.bringToFront();
    return opening;
  }
  opening = showHazards().finally(() => {
    opening = null;
    activeWindow = null;
  });
  return opening;
}
async function showHazards() {
  if (!game.user?.isGM) throw new Error(t('Common.GMOnly'));
  if (isPrimaryGM()) await refreshHazards();
  class Panel extends foundry.applications.api.DialogV2 {
    async _onRender(context, options) {
      await super._onRender(context, options);
      this.element.addEventListener('click', async (event) => {
        const b = event.target.closest('[data-air],[data-hazard]');
        if (!b || this.busy) return;
        this.busy = true;
        b.disabled = true;
        try {
          if (b.dataset.air === 'roll') await rollAir(b.dataset.actor);
          else if (b.dataset.air) await resolveAir(b.dataset.actor, b.dataset.air === 'success');
          else if (b.dataset.hazard === 'roll-lightning') await rollLightning();
          else if (b.dataset.hazard === 'clear-lightning') {
            if (
              await foundry.applications.api.DialogV2.confirm({
                window: { title: t('Hazard.ClearLightning') },
                content: `<p>${t('Hazard.ClearConfirm')}</p>`
              })
            )
              await updateState(DOMAIN, (s) => resolveLightning(s));
          } else if (b.dataset.hazard === 'bind')
            await bindHazardRegion(
              this.element.querySelector('[name="region"]').value,
              this.element.querySelector('[name="hazardType"]').value
            );
          await this.close();
          void openHazards();
        } catch (error) {
          this.element.querySelector('[data-error]').textContent = error.message;
        } finally {
          this.busy = false;
          b.disabled = false;
        }
      });
    }
  }
  return Panel.wait({
    window: { title: `BoB | ${t('Hub.Hazards')}`, resizable: true },
    render: (_event, dialog) => {
      activeWindow = dialog;
    },
    position: { width: 600 },
    classes: ['bob-companion'],
    content: body(),
    buttons: [{ action: 'close', label: t('Common.Close') }]
  });
}
export function registerHazards() {
  registerCardActions(DOMAIN, handleHazardCard);
  Hooks.on('createChatMessage', message => {void captureHazardRoll(message).catch(report);});
  Hooks.once('ready', () => {
    const mod = game.modules.get(ID);
    Object.assign((mod.api ??= {}), { openHazards, bindHazardRegion, refreshHazards, rollAir, applyAirResult });
    if (isPrimaryGM() && enabled()) void refreshHazards().then(() => change(() => {})).then(() => refreshHazardCards()).catch(report);
  });
  Hooks.on('updateToken', (token, changes) => {
    if (
      ['x', 'y', 'elevation', '_regions', 'actorId', 'actorLink'].some((k) =>
        Object.hasOwn(changes, k)
      )
    )
      void trackHazardToken(token).catch(report);
  });
  Hooks.on('createToken', (token) => {
    void trackHazardToken(token).catch(report);
  });
  Hooks.on('deleteToken', (token) => {
    if (isPrimaryGM() && enabled() && readState(DOMAIN).tokens?.[token.uuid])
      void change((s) => removeTrackedToken(s, token.uuid, now())).catch(report);
  });
  Hooks.on('updateScene', (_scene, changes) => {
    if (Object.hasOwn(changes, 'active') && isPrimaryGM() && enabled())
      void refreshHazards().catch(report);
  });
  Hooks.on('canvasReady', () => {
    // Initial canvasReady precedes game readiness; the ready hook reconciles that canvas.
    if (game.ready && isPrimaryGM()) void refreshHazards().catch(report);
  });
  Hooks.on('updateRegion', (region) => {
    if (isPrimaryGM() && readState(DOMAIN).bindings?.[region.uuid])
      void refreshHazards({ recalculate: true }).catch(report);
  });
  Hooks.on('deleteRegion', (region) => {
    if (isPrimaryGM() && enabled() && readState(DOMAIN).bindings?.[region.uuid])
      void updateState(DOMAIN, (s) => {
        delete s.bindings[region.uuid];
      })
        .then(() => refreshHazards({ recalculate: true }))
        .catch(report);
  });
  Hooks.on('updateWorldTime', () => {
    if (isPrimaryGM() && enabled() && Object.keys(readState(DOMAIN)).length)
      void change((s) => advanceHazards(s, now(), { stormEnded: stormEnded() })).catch(report);
  });
  Hooks.on('updateSetting', (setting) => {
    if (setting.key === `${ID}.config` && isPrimaryGM() && Object.keys(readState(DOMAIN)).length)
      void change((s) => advanceHazards(s, now(), { stormEnded: stormEnded(), enabled: enabled() }))
        .then(() => (enabled() ? refreshHazards() : null))
        .catch(report);
  });
  Hooks.on('combatTurnChange', (combat) => {
    if (!isPrimaryGM() || !enabled()) return;
    const token = combat.combatant?.token;
    if (!token) return;
    const actorUuid = `Actor.${token.actorId}`;
    void change((s) =>
      requestFoul(s, actorUuid, now(), `${combat.id}:${combat.round}:${combat.turn}`)
    ).catch(report);
  });
}
