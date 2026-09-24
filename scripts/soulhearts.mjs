import { ID } from './model.mjs';
import {
  readState,
  updateState,
  withAction,
  requirePrimaryGM,
  partyMembers,
  now,
  escapeHtml,
  loadEffect
} from './assistant-core.mjs';
import { getEnvironment } from './runtime.mjs';
import {
  SOULHEART_GRADES,
  soulheartGrade,
  phantomRank,
  planUpgrade,
  runUpgrade,
  correctUpgrade,
  planLife,
  runLife,
  planHPSync
} from './soulheart-model.mjs';
import { t, markLocalized, formatTime, preferredActor } from './i18n.mjs';

export const SOULHEART_HP_SOURCE = 'Item.mE0lIeDPfDvm7Qhy';
export const SOULHEART_LIFE_SOURCE = 'Compendium.pf2e.equipment-effects.Item.iiQSTRA8EVCvlfDQ';
const DOMAIN = 'soulhearts',
  ACTION = 'soulhearts';
const list = (collection) => Array.from(collection?.values?.() ?? collection ?? []);
const flag = (document) => document?.flags?.[ID] ?? {};
const copy = (value) => structuredClone(value);
const randomId = () => foundry.utils.randomID();
const actorById = (id) => {
  const actor = game.actors.get(id);
  if (!actor) throw new Error(t('Soulheart.ErrorActorMissing'));
  return actor;
};
const ownedItem = (actor, id) => {
  const item = actor.items.get(id);
  if (!item) throw new Error(t('Soulheart.ErrorItemMissing'));
  return item;
};
const hpRule = (effect) =>
  effect?.system?.rules?.find(
    (rule) =>
      rule.key === 'FlatModifier' &&
      (Array.isArray(rule.selector) ? rule.selector.includes('hp') : rule.selector === 'hp') &&
      rule.value === '@item.badge.value'
  );
function recognizedHP(effect) {
  const sources = [
    effect.sourceId,
    effect._stats?.compendiumSource,
    effect._stats?.duplicateSource,
    effect.flags?.core?.sourceId
  ];
  return (
    effect.type === 'effect' &&
    (flag(effect).soulheartHP ||
      effect.id === 'mE0lIeDPfDvm7Qhy' ||
      sources.includes(SOULHEART_HP_SOURCE) ||
      effect.system?.slug === 'bolster-maiserene-phantom')
  );
}
export function findHPEffect(actor) {
  const effects = list(actor?.items).filter(recognizedHP);
  if (effects.length > 1)
    throw new Error(t('Soulheart.ErrorMultipleHPEffects', { actor: actor.name ?? actor.id }));
  const effect = effects[0];
  if (!effect) return null;
  if (!hpRule(effect) || !Number.isInteger(Number(effect.system.badge?.value)))
    throw new Error(t('Soulheart.ErrorHPEffectUnreadable'));
  return { id: effect.id, value: Number(effect.system.badge.value) };
}
function hpData(template, value, id) {
  if (!hpRule(template)) throw new Error(t('Soulheart.ErrorHPTemplate'));
  const data = copy(template);
  delete data._id;
  delete data.folder;
  delete data._stats;
  data.system.description = { value: '', gm: '' };
  data.system.badge = {
    ...data.system.badge,
    type: 'counter',
    value,
    min: 0,
    max: null,
    labels: null,
    loop: false
  };
  data.flags = {
    [ID]: { soulheartHP: true, lastUpgrade: id },
    core: { sourceId: SOULHEART_HP_SOURCE }
  };
  return markLocalized(data, {
    name: 'Soulheart.HPEffectName',
    description: 'Soulheart.HPEffectDescription',
    values: { value }
  });
}
export function lifeEffectData(template, op) {
  const rule = template?.system?.rules?.find((rule) => rule.key === 'TempHP');
  if (!rule) throw new Error(t('Soulheart.ErrorLifeTemplate'));
  const data = copy(template);
  delete data._id;
  delete data.folder;
  delete data._stats;
  data.system.rules = [{ ...copy(rule), value: op.temporaryHP }];
  // Grade and day/night have already been resolved from the actual item and preview.
  delete data.system.rules[0].predicate;
  data.system.description = { value: '', gm: '' };
  data.system.duration = { value: 8, unit: 'hours', expiry: 'turn-start', sustained: false };
  data.system.start = { value: op.createdAt, initiative: null };
  data.system.badge = null;
  data.flags = { [ID]: { soulheartLife: op.id }, core: { sourceId: SOULHEART_LIFE_SOURCE } };
  return markLocalized(data, {
    name: 'Soulheart.LifeEffectName',
    description: 'Soulheart.LifeEffectDescription',
    values: { value: op.temporaryHP }
  });
}
/** The port reconciles a native write even when its acknowledgement or subsequent receipt write failed. */
export function makeSoulheartPort({
  read = () => readState(DOMAIN),
  save = (mutator) => updateState(DOMAIN, mutator),
  actor = actorById,
  load = loadEffect,
  assertGM = requirePrimaryGM,
  time = now,
  environment = getEnvironment
} = {}) {
  const getItem = (op) => ownedItem(actor(op.holderId), op.itemId);
  const changed = () => {
    throw new Error(t('Soulheart.ErrorStale'));
  };
  async function checkCorrection(op) {
    if (op.kind !== 'sync') {
      const item = getItem(op);
      if (
        Number(item.system.quantity) !== op.quantityAfter ||
        flag(item).lastSoulheartUpgrade !== op.id ||
        phantomRank(actor(op.phantomId)).rank !== op.rankAfter
      )
        changed();
    }
    for (const pc of op.beneficiaries) {
      const actual = findHPEffect(actor(pc.id)),
        effect = actual && actor(pc.id).items.get(actual.id);
      if (actual?.value !== op.totalAfter || flag(effect).lastUpgrade !== op.id) changed();
    }
  }
  return {
    read,
    save,
    async preflight(op) {
      assertGM();
      const state = read();
      if (
        Number(state.total ?? 0) !== op.ledgerBefore ||
        (state.lastCompleted ?? null) !== op.previousCompleted
      )
        changed();
      if (op.kind !== 'sync') {
        const item = getItem(op);
        if (
          Number(item.system.quantity) !== op.quantityBefore ||
          soulheartGrade(item, op.binding) !== op.grade ||
          phantomRank(actor(op.phantomId)).rank !== op.rankBefore
        )
          changed();
        if (typeof actor(op.phantomId).toggleRollOption !== 'function')
          throw new Error(t('Soulheart.ErrorRankInterface'));
      }
      for (const pc of op.beneficiaries) {
        const recipient = actor(pc.id),
          actual = findHPEffect(recipient);
        if (
          recipient.type !== 'character' ||
          (actual?.id ?? null) !== pc.effectId ||
          (actual?.value ?? 0) !== pc.before
        )
          changed();
      }
      hpData(await load(SOULHEART_HP_SOURCE), op.totalAfter, op.id);
    },
    checkCorrection,
    async preflightLife(op) {
      assertGM();
      const item = getItem(op);
      if (
        Number(item.system.quantity) !== op.quantityBefore ||
        soulheartGrade(item, op.binding) !== op.grade
      )
        changed();
      if (flag(item).soulheartDaily && time() < flag(item).soulheartDaily.resetAt)
        throw new Error(t('Soulheart.ErrorDailyUsed'));
      lifeEffectData(await load(SOULHEART_LIFE_SOURCE), op);
      // Only a new transaction enters preflight. Reserved retries keep their original phase and deadline.
      const current = environment(),
        at = time(),
        phase = current.valid ? (current.night ? 'night' : 'day') : null;
      const resetAt = at + 86400 - (((current.seconds % 86400) + 86400) % 86400);
      if (
        !Number.isFinite(at) ||
        !Number.isFinite(current.seconds) ||
        phase !== op.phase ||
        at < op.createdAt ||
        Math.abs(resetAt - op.resetAt) >= 1
      ) {
        throw new Error(t('Soulheart.ErrorLifeStale'));
      }
    },
    async applyLife(op, step) {
      assertGM();
      const item = getItem(op),
        holder = actor(op.holderId),
        daily = flag(item).soulheartDaily;
      if (step === 'daily') {
        if (daily?.id === op.id) return;
        if (daily && time() < daily.resetAt) throw new Error(t('Soulheart.ErrorDailyChanged'));
        await item.update({
          [`flags.${ID}.soulheartDaily`]: { id: op.id, usedAt: op.createdAt, resetAt: op.resetAt }
        });
        return;
      }
      if (list(holder.items).some((effect) => flag(effect).soulheartLife === op.id)) return;
      if (time() >= op.expiresAt) {
        await save((state) => {
          state.operations[op.id].notice = 'Soulheart.NoticeExpired';
        });
        return;
      }
      const data = lifeEffectData(await load(SOULHEART_LIFE_SOURCE), op);
      assertGM();
      // PF2e sets effect.start to the creation time, including a delayed retry.
      const remaining = op.expiresAt - time();
      if (remaining <= 0) {
        await save((state) => {
          state.operations[op.id].notice = 'Soulheart.NoticeExpired';
        });
        return;
      }
      data.system.duration = { ...data.system.duration, value: remaining / 60, unit: 'minutes' };
      await holder.createEmbeddedDocuments('Item', [data]);
    },
    async apply(op, step, undo = false) {
      assertGM();
      const marker = undo ? `undo:${op.id}` : op.id;
      if (step === 'quantity') {
        const item = getItem(op),
          before = undo ? op.quantityAfter : op.quantityBefore,
          after = undo ? op.quantityBefore : op.quantityAfter;
        if (flag(item).lastSoulheartUpgrade === marker && Number(item.system.quantity) === after)
          return;
        if (
          Number(item.system.quantity) !== before ||
          flag(item).lastSoulheartUpgrade === marker ||
          (undo && flag(item).lastSoulheartUpgrade !== op.id)
        )
          changed();
        await item.update({
          'system.quantity': after,
          [`flags.${ID}.lastSoulheartUpgrade`]: marker
        });
        return;
      }
      if (step === 'rank') {
        const phantom = actor(op.phantomId),
          current = phantomRank(phantom),
          before = undo ? op.rankAfter : op.rankBefore,
          after = undo ? op.rankBefore : op.rankAfter;
        if (current.itemId !== op.rankItemId) changed();
        if (current.rank === after) return;
        if (current.rank !== before) changed();
        await phantom.toggleRollOption(
          op.rankDomain,
          'support-rank',
          op.rankItemId,
          after > 0,
          String(after || 1)
        );
        if (phantomRank(phantom).rank !== after)
          throw new Error(t('Soulheart.ErrorRankNotUpdated'));
        return;
      }
      const pc = op.beneficiaries.find((pc) => `hp:${pc.id}` === step);
      if (!pc) throw new Error(t('Soulheart.ErrorHPStep'));
      const recipient = actor(pc.id),
        actual = findHPEffect(recipient),
        effect = actual && recipient.items.get(actual.id),
        target = undo ? pc.before : op.totalAfter;
      if (undo && !pc.effectId) {
        if (!effect) return;
        if (flag(effect).lastUpgrade !== op.id || actual.value !== op.totalAfter) changed();
        await recipient.deleteEmbeddedDocuments('Item', [effect.id]);
        return;
      }
      if (effect && flag(effect).lastUpgrade === marker && actual.value === target) return;
      const expectedValue = undo ? op.totalAfter : pc.before;
      if (
        (effect
          ? actual.value !== expectedValue || (pc.effectId && effect.id !== pc.effectId)
          : Boolean(pc.effectId)) ||
        (undo && flag(effect).lastUpgrade !== op.id)
      )
        changed();
      const data = hpData(await load(SOULHEART_HP_SOURCE), target, marker);
      assertGM();
      if (effect)
        await effect.update({
          name: data.name,
          'system.description': data.system.description,
          'system.badge': data.system.badge,
          [`flags.${ID}.soulheartHP`]: true,
          [`flags.${ID}.lastUpgrade`]: marker,
          [`flags.${ID}.localization`]: data.flags[ID].localization
        });
      else await recipient.createEmbeddedDocuments('Item', [data]);
    }
  };
}

export function previewSoulheart({ holderId, itemId, phantomId, beneficiaryIds, binding } = {}) {
  requirePrimaryGM();
  const holder = actorById(holderId),
    item = ownedItem(holder, itemId),
    state = readState(DOMAIN);
  binding ??= state.bindings?.[item.uuid];
  return planUpgrade({
    id: randomId(),
    holderId,
    item,
    phantom: actorById(phantomId),
    beneficiaries: beneficiaryIds.map((id) => ({ id, effect: findHPEffect(actorById(id)) })),
    state,
    time: now(),
    binding
  });
}
export async function commitSoulheart(proposal, confirmed = false) {
  return withAction(ACTION, () =>
    runUpgrade(
      makeSoulheartPort(),
      typeof proposal === 'string' ? readState(DOMAIN).operations?.[proposal] : proposal,
      confirmed
    )
  );
}
export async function correctSoulheart(id) {
  return withAction(ACTION, () => correctUpgrade(makeSoulheartPort(), id));
}
export function previewSoulheartLife({ holderId, itemId, binding, phase } = {}) {
  requirePrimaryGM();
  const item = ownedItem(actorById(holderId), itemId),
    environment = getEnvironment(),
    state = readState(DOMAIN);
  binding ??= state.bindings?.[item.uuid];
  return planLife({
    id: randomId(),
    holderId,
    item,
    binding,
    phase: phase ?? (environment.valid ? (environment.night ? 'night' : 'day') : null),
    time: now(),
    seconds: environment.seconds,
    lastUse: flag(item).soulheartDaily
  });
}
export async function activateSoulheartLife(proposal, confirmed = false) {
  return withAction(ACTION, () =>
    runLife(
      makeSoulheartPort(),
      typeof proposal === 'string' ? readState(DOMAIN).operations?.[proposal] : proposal,
      confirmed
    )
  );
}
export function previewSoulheartHPSync({ beneficiaryIds, baseline } = {}) {
  requirePrimaryGM();
  return planHPSync({
    id: randomId(),
    beneficiaries: beneficiaryIds.map((id) => ({ id, effect: findHPEffect(actorById(id)) })),
    state: readState(DOMAIN),
    time: now(),
    baseline
  });
}

const esc = escapeHtml;
const tr = (key, values) => t(`Soulheart.${key}`, values);
const gradeLabel = (grade) =>
  tr({ ordinary: 'GradeOrdinary', greater: 'GradeGreater', major: 'GradeMajor' }[grade]);
const select = (name, label, entries, selected) =>
  `<label class="bob-field"><span>${esc(label)}</span><select name="${esc(name)}">${entries.map(([value, text]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
const partyChoices = () => partyMembers().filter((actor) => actor.type === 'character');
const recipientsHTML = () => `
  <fieldset>
    <legend>${esc(tr('Beneficiaries'))}</legend>
    <div class="bob-check-list">
      ${partyChoices()
        .map(
          (actor) => `
        <label>
          <input type="checkbox" name="beneficiary" value="${esc(actor.id)}" checked>
          <span>${esc(actor.name)}</span>
        </label>
      `
        )
        .join('')}
    </div>
  </fieldset>`;
const dialog = () => foundry.applications.api.DialogV2;
export const soulheartEligibleItems = (holder, state = {}, mode = 'upgrade') =>
  list(holder?.items).filter(
    (item) =>
      Number(item.system?.quantity) > 0 &&
      (mode === 'bind'
        ? soulheartGrade(item, 'ordinary')
        : soulheartGrade(item, state.bindings?.[item.uuid]))
  );
export const soulheartEligibleHolders = (actors, state = {}, mode = 'upgrade') =>
  list(actors).filter((actor) => soulheartEligibleItems(actor, state, mode).length);
const itemsFor = soulheartEligibleItems;
const holdersFor = (state, mode) => soulheartEligibleHolders(game.actors, state, mode);
const options = (entries) =>
  entries.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
const selectedForm = (form) => new FormData(form);
export function displayedProposal(shown, signature, currentSignature) {
  if (!shown || signature !== currentSignature) throw new Error(tr('ErrorSelectionChanged'));
  return shown;
}
function summary(op) {
  if (op.kind === 'life')
    return tr('LifePreview', {
      holder: actorById(op.holderId).name,
      item: ownedItem(actorById(op.holderId), op.itemId).name,
      phase: tr(op.phase === 'day' ? 'Day' : 'Night'),
      hp: op.temporaryHP
    });
  return tr('UpgradePreview', {
    item: ownedItem(actorById(op.holderId), op.itemId).name,
    grade: gradeLabel(op.grade),
    before: op.quantityBefore,
    after: op.quantityAfter,
    phantom: actorById(op.phantomId).name,
    rankBefore: op.rankBefore,
    rankAfter: op.rankAfter,
    totalBefore: op.totalBefore,
    totalAfter: op.totalAfter
  });
}
export function beneficiaryPreviewHTML(op, nameFor = (id) => actorById(id).name) {
  if (!['upgrade', 'sync'].includes(op.kind)) return '';
  return `<ul>${op.beneficiaries.map((pc) => `<li>${esc(tr('BeneficiaryPreview', { actor: nameFor(pc.id), before: pc.before, after: op.totalAfter }))}</li>`).join('')}</ul>`;
}
/** A single native form owns both selections and the exact proposal shown in its preview. */
export async function soulheartOperationDialog(mode = 'upgrade') {
  requirePrimaryGM();
  const state = readState(DOMAIN),
    holders = holdersFor(state, mode);
  if (!holders.length) throw new Error(tr('ErrorNoHolder'));
  const preferred = preferredActor(holders),
    initial = holders.includes(preferred) ? preferred : holders[0];
  const itemEntries = itemsFor(initial, state, mode).map((item) => [
    item.id,
    `${item.name} × ${item.system.quantity}`
  ]);
  const content = `${select(
    'holder',
    tr('Holder'),
    holders.map((actor) => [actor.id, actor.name]),
    initial.id
  )}${select('item', tr('Item'), itemEntries)}${mode === 'upgrade' ? `${select('phantom', tr('Phantom'), [])}${recipientsHTML()}` : ''}<div data-soulheart-preview aria-live="polite"></div>`;
  let shown = null,
    signature = null;
  const formSignature = (form) => {
    const data = selectedForm(form);
    return JSON.stringify({
      holder: data.get('holder'),
      item: data.get('item'),
      phantom: data.get('phantom'),
      beneficiaries: data.getAll('beneficiary')
    });
  };
  const refresh = (form, changed) => {
    const holder = holders.find((actor) => actor.id === form.elements.namedItem('holder')?.value),
      itemSelect = form.elements.namedItem('item');
    if (changed === 'holder')
      itemSelect.innerHTML = options(
        itemsFor(holder, state, mode).map((item) => [
          item.id,
          `${item.name} × ${item.system.quantity}`
        ])
      );
    const item = itemsFor(holder, state, mode).find((row) => row.id === itemSelect.value),
      phantomSelect = form.elements.namedItem('phantom');
    if (phantomSelect) {
      const grade = item && soulheartGrade(item, state.bindings?.[item.uuid]);
      const eligible = grade
        ? list(game.actors).filter((actor) => {
            try {
              return phantomRank(actor).rank === SOULHEART_GRADES[grade].rank;
            } catch {
              return false;
            }
          })
        : [];
      const old = phantomSelect.value;
      phantomSelect.innerHTML = options(eligible.map((actor) => [actor.id, actor.name]));
      if (changed !== 'item' && eligible.some((actor) => actor.id === old))
        phantomSelect.value = old;
    }
    const preview = form.querySelector('[data-soulheart-preview]');
    shown = null;
    signature = null;
    try {
      const data = selectedForm(form);
      if (!holder || !item) throw new Error(tr('ErrorNoItem'));
      if (mode === 'upgrade' && !data.get('phantom')) throw new Error(tr('ErrorNoPhantom'));
      shown =
        mode === 'life'
          ? previewSoulheartLife({ holderId: holder.id, itemId: item.id })
          : previewSoulheart({
              holderId: holder.id,
              itemId: item.id,
              phantomId: data.get('phantom'),
              beneficiaryIds: data.getAll('beneficiary')
            });
      const html = `<p class="bob-proposal">${esc(summary(shown))}</p>${beneficiaryPreviewHTML(shown)}`;
      signature = formSignature(form);
      preview.innerHTML = html;
    } catch (error) {
      shown = null;
      signature = null;
      preview.textContent = error.message;
    }
    const submit = form.closest('.application')?.querySelector('button[data-action="apply"]');
    if (submit) submit.disabled = !shown;
  };
  const result = await dialog().wait({
    window: { title: `BoB｜${tr(mode === 'life' ? 'LifeTitle' : 'UpgradeTitle')}` },
    position: { width: 600 },
    classes: ['bob-companion'],
    content,
    render: (_event, instance) => {
      const form = instance.element.querySelector('form');
      form.addEventListener('change', (event) => refresh(form, event.target.name));
      refresh(form, 'holder');
    },
    buttons: [
      {
        action: 'apply',
        label: tr('Confirm'),
        default: true,
        callback: (_event, _button, instance) =>
          displayedProposal(shown, signature, formSignature(instance.element.querySelector('form')))
      }
    ],
    rejectClose: false
  });
  if (result)
    return mode === 'life' ? activateSoulheartLife(result, true) : commitSoulheart(result, true);
  return null;
}
async function choose(title, content, buttons = [{ action: 'next', label: tr('Continue') }]) {
  return dialog().wait({
    window: { title: `BoB｜${title}` },
    position: { width: 600 },
    classes: ['bob-companion'],
    content,
    rejectClose: false,
    buttons: buttons.map((button) => ({
      ...button,
      callback: (_event, _button, instance) => ({
        action: button.action,
        form: selectedForm(instance.element.querySelector('form'))
      })
    }))
  });
}
async function chooseBind() {
  const state = readState(DOMAIN),
    holders = holdersFor(state, 'bind');
  if (!holders.length) throw new Error(tr('ErrorNoEquipment'));
  const holderResult = await choose(
    tr('BindTitle'),
    select(
      'holder',
      tr('Holder'),
      holders.map((actor) => [actor.id, actor.name])
    )
  );
  if (!holderResult) return;
  const holder = actorById(holderResult.form.get('holder')),
    items = itemsFor(holder, state, 'bind');
  const result = await choose(
    tr('BindTitle'),
    select(
      'item',
      tr('Item'),
      items.map((item) => [item.id, item.name])
    ) +
      select(
        'grade',
        tr('Grade'),
        Object.keys(SOULHEART_GRADES).map((grade) => [grade, gradeLabel(grade)])
      )
  );
  if (!result) return;
  const item = ownedItem(holder, result.form.get('item')),
    grade = result.form.get('grade');
  if (
    await dialog().confirm({
      window: { title: tr('BindTitle') },
      content: `<p>${esc(tr('BindConfirm', { holder: holder.name, item: item.name, grade: gradeLabel(grade) }))}</p>`,
      rejectClose: false
    })
  )
    await withAction(ACTION, () =>
      updateState(DOMAIN, (state) => {
        state.bindings ??= {};
        state.bindings[item.uuid] = grade;
      })
    );
}
async function chooseHPSync() {
  const state = readState(DOMAIN),
    minimum = Math.max(
      Number(state.total ?? 0),
      ...partyChoices().map((actor) => findHPEffect(actor)?.value ?? 0)
    );
  const result = await choose(
    tr('SyncTitle'),
    `<label class="bob-field">${esc(tr('Baseline'))}<input name="baseline" type="number" min="${minimum}" value="${minimum}" step="1"></label>${recipientsHTML()}`
  );
  if (!result) return;
  const op = previewSoulheartHPSync({
    beneficiaryIds: result.form.getAll('beneficiary'),
    baseline: Number(result.form.get('baseline'))
  });
  if (
    await dialog().confirm({
      window: { title: tr('SyncTitle') },
      content: `<p>${esc(tr('SyncPreview', { before: op.totalBefore, after: op.totalAfter }))}</p>${beneficiaryPreviewHTML(op)}`,
      rejectClose: false
    })
  )
    await commitSoulheart(op, true);
}
const actorName = (id) => game.actors.get(id)?.name ?? tr('RemovedActor');
const operationLabel = (op) =>
  op.kind === 'life'
    ? op.notice
      ? tr('RecordLifeAttempt', { actor: actorName(op.holderId) })
      : tr('RecordLife', { actor: actorName(op.holderId), hp: op.temporaryHP })
    : tr('RecordUpgrade', {
        actor: op.holderId
          ? actorName(op.holderId)
          : op.beneficiaries.map((pc) => actorName(pc.id)).join(', '),
        hp: op.totalAfter
      });
const noticeText = (notice) => (notice?.startsWith?.('Soulheart.') ? t(notice) : notice);
export const soulheartRecordHTML = (op) => `
  <li>
    <strong>${esc(operationLabel(op))}</strong>
    <p class="hint">${esc(formatTime(op.createdAt))}</p>
    ${op.notice ? `<p>${esc(noticeText(op.notice))}</p>` : ''}
    ${op.error ? `<p class="bob-warning">${esc(op.error)}</p>` : ''}
  </li>`;
export async function openSoulhearts() {
  if (!game.user?.isGM) throw new Error(tr('ErrorGMOnly'));
  const state = readState(DOMAIN),
    operations = Object.values(state.operations ?? {}),
    pending = operations.filter((op) => ['pending', 'correcting'].includes(op.status));
  const viewId = randomId();
  const recent = operations
    .filter((op) => op.status === 'complete')
    .slice(-5)
    .reverse();
  const content = `
    <div class="bob-now">
      <strong>${esc(tr('Total', { hp: Number(state.total ?? 0) }))}</strong>
    </div>
    ${pending.length ? `<p class="bob-warning" role="status">${esc(tr('PendingCount', { count: pending.length }))}</p>` : ''}
    <section class="bob-section" aria-labelledby="bob-soulheart-history-${viewId}">
      <h3 id="bob-soulheart-history-${viewId}">${esc(tr('Recent'))}</h3>
      ${
        recent.length
          ? `<ul class="bob-record-list">${recent.map(soulheartRecordHTML).join('')}</ul>`
          : `<p class="bob-empty">${esc(tr('NoRecords'))}</p>`
      }
    </section>
    <details>
      <summary>${esc(tr('Advanced'))}</summary>
      <div class="bob-toolbar">
        <button type="button" data-soulheart-advanced="bind">${esc(tr('BindTitle'))}</button>
        <button type="button" data-soulheart-advanced="sync">${esc(tr('SyncTitle'))}</button>
        ${pending.length ? `<button type="button" data-soulheart-advanced="retry">${esc(tr('Retry'))}</button>` : ''}
        ${state.lastCompleted ? `<button type="button" data-soulheart-advanced="correct">${esc(tr('Correct'))}</button>` : ''}
      </div>
      ${
        pending.length
          ? `
        ${select(
          'pending',
          tr('Pending'),
          pending.map((op) => [op.id, `${operationLabel(op)} · ${formatTime(op.createdAt)}`])
        )}
        <ul class="bob-record-list">${pending.map(soulheartRecordHTML).join('')}</ul>`
          : ''
      }
    </details>`;
  let advanced = null;
  const result = await dialog().wait({
    window: { title: `BoB｜${tr('Title')}` },
    position: { width: 600 },
    classes: ['bob-companion'],
    content,
    rejectClose: false,
    render: (_event, instance) => {
      instance.element.querySelectorAll('[data-soulheart-advanced]').forEach((button) =>
        button.addEventListener('click', () => {
          advanced = {
            action: button.dataset.soulheartAdvanced,
            form: selectedForm(instance.element.querySelector('form'))
          };
          instance.close();
        })
      );
    },
    buttons: [
      { action: 'upgrade', label: tr('UpgradeTitle') },
      { action: 'life', label: tr('LifeTitle') },
      { action: 'close', label: tr('Close') }
    ].map((button) => ({ ...button, callback: () => button.action }))
  });
  try {
    if (result === 'upgrade' || result === 'life') await soulheartOperationDialog(result);
    else if (advanced) {
      requirePrimaryGM();
      if (advanced.action === 'bind') await chooseBind();
      else if (advanced.action === 'sync') await chooseHPSync();
      else if (advanced.action === 'retry') {
        const op = readState(DOMAIN).operations?.[advanced.form.get('pending')];
        if (!op) throw new Error(tr('ErrorPendingMissing'));
        if (op.status === 'correcting') await correctSoulheart(op.id);
        else if (op.kind === 'life') await activateSoulheartLife(op, true);
        else await commitSoulheart(op, true);
      } else if (advanced.action === 'correct') {
        const op = readState(DOMAIN).operations?.[state.lastCompleted];
        if (!op) throw new Error(tr('ErrorPendingMissing'));
        if (
          await dialog().confirm({
            window: { title: tr('Correct') },
            content: `<p>${esc(tr('CorrectConfirm', { record: operationLabel(op), before: op.totalAfter, after: op.ledgerBefore }))}</p>`,
            rejectClose: false
          })
        )
          await correctSoulheart(op.id);
      }
    } else return;
  } catch (error) {
    ui.notifications.error(error.message);
  }
  return openSoulhearts();
}
let registered = false;
export function registerSoulhearts() {
  if (registered) return;
  registered = true;
  Hooks.once('ready', () => {
    const module = game.modules.get(ID);
    if (module)
      Object.assign((module.api ??= {}), {
        openSoulhearts,
        previewSoulheart,
        commitSoulheart,
        correctSoulheart,
        previewSoulheartLife,
        activateSoulheartLife,
        previewSoulheartHPSync
      });
  });
}
