/** Seconds throughout. These records describe explicit GM decisions, never discoveries. */
export const WEEK = 604800;
export const DAY = 86400;
const kinds = new Set(['A14','A19','C45','G4']);
const finite = value => Number.isFinite(value);
const active = use => !use.voided && use.consumedAt == null && !use.expired;
const uses = state => Object.values(state.uses ?? {});
const init = state => { state.uses ??= {}; state.actions ??= {}; };
function validateAction(input) {
  if (!input.id || typeof input.id !== 'string') throw new Error('缺少操作 ID。');
  if (!finite(input.at)) throw new Error('世界时间不可用。');
}
function repeated(state,input) {
  const existing = state.actions?.[input.id];
  if (!existing) return false;
  if (existing.useId !== (input.useId ?? input.id)) throw new Error('操作 ID 已用于其他记录。');
  return true;
}

export function cooldownRemaining(state,kind,actorId,at) {
  const duration = kind === 'C45' ? DAY : ['A14','A19'].includes(kind) ? WEEK : 0;
  if(!duration)return 0;
  const previous = uses(state).filter(use => !use.voided && use.kind === kind && (kind === 'C45' || use.actorId === actorId));
  return previous.length ? Math.max(0,Math.max(...previous.map(use => use.at + duration)) - at) : 0;
}

export function crossedDawn({start,at,dayStart,dawn}) {
  if (![start,at,dayStart,dawn].every(finite) || at < start || dawn < 0 || dawn >= DAY) return false;
  const sunrise = dayStart + dawn;
  return start <= sunrise && at >= sunrise;
}

export function recordBoon(state,input) {
  validateAction(input);
  if (!kinds.has(input.kind) || !input.actorId) throw new Error('请选择恩惠及角色。');
  if (repeated(state,input)) {
    const previous=state.uses[input.id];
    if(previous.kind!==input.kind||(previous.originalActorId??previous.actorId)!==input.actorId)throw new Error('操作 ID 已用于其他角色或恩惠。');
    return previous;
  }
  if (cooldownRemaining(state,input.kind,input.actorId,input.at)) throw new Error('仍在冷却期间。');
  if (['A14','A19'].includes(input.kind) && (!finite(input.start) || input.at - input.start < 3600)) throw new Error('必须完成至少 1 小时。');
  const use = {id:input.id,kind:input.kind,actorId:input.actorId,originalActorId:input.actorId,at:input.at,start:input.start ?? input.at,status:'pending',expiresAt:null};
  if (input.kind === 'A14') {
    if (!['criticalSuccess','success','failure','criticalFailure'].includes(input.degree)) throw new Error('请选择意志豁免结果。');
    use.cleaned = Boolean(input.cleaned);
    use.degree = input.degree === 'failure' && !use.cleaned ? 'criticalFailure' : input.degree;
    use.bonus = use.degree === 'criticalSuccess' ? 2 : use.degree === 'success' ? 1 : 0;
    if (use.bonus) use.expiresAt = use.at + (use.bonus === 2 ? WEEK : DAY);
    if (use.degree === 'criticalFailure') {use.condition = 'stupefied';use.expiresAt = use.at + DAY;}
  } else if (input.kind === 'A19') {
    if(input.dayStart!=null&&(!finite(input.dayStart)||input.at<input.dayStart||input.at>=input.dayStart+DAY))throw new Error('请校准完成当天的午夜时间。');
    use.diseasePending = true;
    use.crossedDawn = crossedDawn(input);
    if (use.crossedDawn) use.expiresAt = input.dayStart + DAY;
  } else if (input.kind === 'C45') {
    if (!['performance','crafting','athletics'].includes(input.choice)) throw new Error('请选择雕像。');
    use.choice = input.choice;
    use.expiresAt = use.at + 28800;
    use.cleansePending = true;
    use.targets = [...new Set(input.targets ?? [])];
  } else if (uses(state).some(other => other.kind === 'G4' && other.actorId === input.actorId && active(other))) {
    throw new Error('该角色已持有未使用恩赐，请转授给尚未持有者。');
  }
  init(state);
  state.uses[use.id] = use;
  state.actions[input.id] = {type:'grant',useId:use.id,at:input.at};
  return use;
}

function available(state,input) {
  validateAction(input);
  const use = state.uses?.[input.useId];
  if (!use || use.voided) throw new Error('记录不存在或已撤销。');
  if (use.consumedAt != null) throw new Error('此恩惠已消费。');
  if (use.expired || (finite(use.expiresAt) && input.at >= use.expiresAt)) throw new Error('此恩惠已到期。');
  return use;
}

export function consumeBoon(state,input) {
  if (repeated(state,input)) return;
  const use = available(state,input);
  if (use.kind !== 'G4' && !(use.kind === 'A14' && use.bonus > 0)) throw new Error('此效果无需单次消费。');
  use.consumedAt = input.at;
  state.actions[input.id] = {type:'consume',useId:use.id,at:input.at};
}

export function transferBoon(state,input) {
  if (repeated(state,input)) return;
  const use = available(state,input);
  if (use.kind !== 'G4' || !input.actorId || input.actorId === use.actorId) throw new Error('请选择新的恩赐持有者。');
  if (uses(state).some(other => other.kind === 'G4' && other.actorId === input.actorId && active(other))) throw new Error('接收者已持有恩赐。');
  use.transfers ??= [];
  use.transfers.push({from:use.actorId,to:input.actorId,at:input.at});
  use.actorId = input.actorId;
  use.status = 'pending';
  state.actions[input.id] = {type:'transfer',useId:use.id,at:input.at};
}

export function correctBoon(state,input) {
  validateAction(input);
  if (repeated(state,input)) return;
  const use = state.uses?.[input.useId];
  if (!use || !input.reason?.trim()) throw new Error('纠正必须选择记录并填写原因。');
  if (!finite(input.start) || input.start > input.at || (input.expiresAt != null && (!finite(input.expiresAt) || input.expiresAt <= input.at))) throw new Error('开始、完成、到期时间无效。');
  if (['A14','A19'].includes(use.kind) && input.at - input.start < 3600) throw new Error('必须完成至少 1 小时。');
  use.corrections ??= [];
  use.corrections.push({start:use.start,at:use.at,expiresAt:use.expiresAt,reason:input.reason});
  Object.assign(use,{start:input.start,at:input.at,expiresAt:input.expiresAt,expired:false,status:'pending'});
  state.actions[input.id] = {type:'correct',useId:use.id,at:input.at};
}

export function c45Active(use,{at,inRoom,day}) {
  return Boolean(use?.kind === 'C45' && active(use) && inRoom && day && at >= use.at && at < use.expiresAt);
}

export function voidBoon(state,input) {
  validateAction(input);
  if(repeated(state,input))return;
  const use=state.uses?.[input.useId];
  if(!use||!input.reason?.trim())throw new Error('撤销误登记须选择记录并填写原因。');
  if(use.voided)throw new Error('记录已撤销。');
  use.voided={at:input.at,reason:input.reason};
  state.actions[input.id]={type:'void',useId:use.id,at:input.at};
}

export function expireBoons(state,at) {
  for (const use of uses(state)) if (active(use) && finite(use.expiresAt) && at >= use.expiresAt) use.expired = true;
}
